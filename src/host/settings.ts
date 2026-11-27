import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** Fixed host layout: §5 and §8 of the spec. Nothing here comes from the user's home. */
export const hostPaths = {
  account: 'devchat',
  stateDir: '/var/lib/devchat',
  configHome: '/var/lib/devchat/config',
  boardDir: '/var/lib/devchat/board',
  exportDir: '/var/lib/devchat/exports',
  /** Install's private staging directory: root-owned, never under a temp directory. */
  stageDir: '/opt/devchat/.staging',
  optDir: '/opt/devchat',
  node: '/opt/devchat/bin/node',
  appDir: '/opt/devchat/app',
  configDir: '/etc/devchat',
  configFile: '/etc/devchat/app.json',
  /** The routes tailscale serves for devchat (root 644, readable so install can check them first). */
  routesFile: '/etc/devchat/routes.json',
  unitDir: '/etc/systemd/system',
} as const

const appModules = `${hostPaths.appDir}/node_modules`
export const boardCli = `${appModules}/@vercel/board/dist/cli.mjs`
export const hostCli = `${appModules}/@filipgutica/devchat/dist/host/cli.js`
export const appMain = `${appModules}/@filipgutica/devchat/dist/server/main.js`

export const unitNames = {
  board: 'devchat-board.service',
  app: 'devchat-app.service',
  exportService: 'devchat-export.service',
  exportTimer: 'devchat-export.timer',
} as const

const port = z.number().int().min(1).max(65_535)

/**
 * GitHub owners whose repos may appear on the board (§5). An intent's `repo` must be
 * `<owner>/<repo>` with its owner here, ignoring case. Empty refuses every repo.
 */
const allowlist = z.array(z.string().regex(/^[A-Za-z0-9-]{1,39}$/, 'a GitHub owner such as octocat'))
/** Machine name to T3 environment ID: the app sets a work item's `env` from it (§2). */
const machines = z.record(z.string().min(1).max(256), z.string().min(1).max(256))

/**
 * The settings install and verify take. Without an allowlist or machine map, install keeps the
 * ones `/etc/devchat/app.json` holds (`mergeSettings`).
 */
export const installSettingsSchema = z.object({
  // Board lowercases a tailnet login and keeps it as an ID only in this shape (Board 0.56.1's LOGIN
  // rule). Checking it here refuses a login before install writes anything; it is also shell-safe.
  login: z.string().trim().toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9][a-z0-9.-]{0,127}$/, 'a tailnet login such as user@example.com'),
  host: z.string().regex(/^[a-z0-9.-]+$/i, 'a DNS name such as <host>.<tailnet>.ts.net'),
  httpsPort: port,
  boardPort: port,
  appPort: port,
  allowlist: allowlist.optional(),
  machines: machines.optional(),
}).strict()

export type InstallSettings = z.infer<typeof installSettingsSchema>

/** The app's settings, written to `/etc/devchat/app.json` (root:devchat 640). */
export const settingsSchema = installSettingsSchema.extend({
  allowlist: allowlist.default([]),
  machines: machines.default({}),
}).strict()

export type Settings = z.infer<typeof settingsSchema>

/**
 * The allowlist and machine map from install's flags: an absent flag gives none, so install keeps
 * the installed value, and an empty one clears it.
 */
export function listFlags({ allowlist, machine }: { allowlist?: string | undefined; machine?: string[] | undefined }) {
  const entries = machine?.filter(Boolean).map((entry) => {
    const split = entry.indexOf('=')
    if (split < 1) throw new Error(`--machine ${entry}: use <name>=<T3 environment ID>`)
    return [entry.slice(0, split), entry.slice(split + 1)] as const
  })
  return {
    ...(allowlist === undefined ? {} : { allowlist: allowlist.split(',').map((owner) => owner.trim()).filter(Boolean) }),
    ...(entries === undefined ? {} : { machines: Object.fromEntries(entries) }),
  }
}

/** The settings install writes: `update`, with the installed allowlist and machine map where it has none. */
export const mergeSettings = (update: InstallSettings, current: Settings | null): Settings => settingsSchema.parse({
  ...update,
  allowlist: update.allowlist ?? current?.allowlist,
  machines: update.machines ?? current?.machines,
})

/** The allowlist and machine map install writes, for its plan and its run. */
export function describeLists({ allowlist, machines }: Pick<InstallSettings, 'allowlist' | 'machines'>) {
  const kept = 'kept from the installed app.json, empty on a first install'
  const list = allowlist === undefined ? kept : allowlist.join(', ') || 'empty, so every repo is refused'
  const map = machines === undefined ? kept
    : Object.entries(machines).map(([name, env]) => `${name}=${env}`).join(', ') || 'empty'
  return `allowlist: ${list}; machines: ${map}`
}

export const defaultPorts = { httpsPort: 8443, boardPort: 4100, appPort: 4101 } as const

export const boardUrl = ({ boardPort }: Pick<Settings, 'boardPort'>) => `http://127.0.0.1:${boardPort}/api/board`

/** The tailnet origin `tailscale serve` exposes, and the Host header it forwards. */
export const tailnetHost = ({ host, httpsPort }: Pick<Settings, 'host' | 'httpsPort'>) => `${host}:${httpsPort}`

/** Where `vb serve` writes the owner token for `url` under `configHome` (Board 0.56.1, Phase 0). */
export function ownerTokenFile(configHome: string, url: string) {
  const hash = createHash('sha256').update(url.replace(/\/+$/, '')).digest('hex').slice(0, 32)
  return join(configHome, 'board', 'local', `${hash}.json`)
}

/**
 * Why `path` is not root's alone: each directory on it, and the file itself, must be root-owned,
 * not a symlink, and not group- or world-writable. Empty when only root can change it.
 */
export async function rootFileProblems(path: string) {
  const parts = path.split('/').filter(Boolean)
  const problems: string[] = []
  for (let depth = 0; depth <= parts.length; depth += 1) {
    const current = `/${parts.slice(0, depth).join('/')}`
    const isFile = depth === parts.length
    const stat = await lstat(current)
    if (isFile ? !stat.isFile() : !stat.isDirectory()) problems.push(`${current} is not a ${isFile ? 'regular file' : 'directory'}`)
    if (stat.uid !== 0) problems.push(`${current} is not root-owned`)
    if ((stat.mode & 0o022) !== 0) problems.push(`${current} is group- or world-writable`)
  }
  return problems
}

export async function readSettings(file: string = hostPaths.configFile) {
  return settingsSchema.parse(JSON.parse(await readFile(file, 'utf8')))
}
