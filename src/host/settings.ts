import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** Fixed host layout: §5 and §8 of the spec. Nothing here comes from the user's home. */
export const hostPaths = {
  account: 'devchat',
  stateDir: '/var/lib/devchat',
  configHome: '/var/lib/devchat/config',
  boardDir: '/var/lib/devchat/board',
  exportDir: '/var/lib/devchat/exports',
  optDir: '/opt/devchat',
  node: '/opt/devchat/bin/node',
  appDir: '/opt/devchat/app',
  configDir: '/etc/devchat',
  configFile: '/etc/devchat/app.json',
  unitDir: '/etc/systemd/system',
} as const

export const appModules = `${hostPaths.appDir}/node_modules`
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

/** The app's settings, written to `/etc/devchat/app.json` (root:devchat 640). */
export const settingsSchema = z.object({
  // Board keeps a tailnet login as an ID only in these characters; they are also shell-safe.
  login: z.string().max(256).regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/, 'a tailnet login such as user@example.com'),
  host: z.string().regex(/^[a-z0-9.-]+$/i, 'a DNS name such as <host>.<tailnet>.ts.net'),
  httpsPort: port,
  boardPort: port,
  appPort: port,
}).strict()

export type Settings = z.infer<typeof settingsSchema>

export const defaultPorts = { httpsPort: 8443, boardPort: 4100, appPort: 4101 } as const

export const boardUrl = ({ boardPort }: Pick<Settings, 'boardPort'>) => `http://127.0.0.1:${boardPort}/api/board`

/** The tailnet origin `tailscale serve` exposes, and the Host header it forwards. */
export const tailnetHost = ({ host, httpsPort }: Pick<Settings, 'host' | 'httpsPort'>) => `${host}:${httpsPort}`

/** Where `vb serve` writes the owner token for `url` under `configHome` (Board 0.56.1, Phase 0). */
export function ownerTokenFile(configHome: string, url: string) {
  const hash = createHash('sha256').update(url.replace(/\/+$/, '')).digest('hex').slice(0, 32)
  return join(configHome, 'board', 'local', `${hash}.json`)
}

export async function readSettings(file: string = hostPaths.configFile) {
  return settingsSchema.parse(JSON.parse(await readFile(file, 'utf8')))
}
