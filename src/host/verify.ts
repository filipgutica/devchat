import { spawnSync } from 'node:child_process'
import { access, constants, lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { channels } from '../shared/layout.ts'
import { forgedTailnetClient, plainClient, type BoardRequester } from './board-http.ts'
import { boardCli, boardUrl, hostPaths, ownerTokenFile, rootFileProblems, tailnetHost, unitNames, type Settings } from './settings.ts'

export type CheckResult = { name: string; ok: boolean; detail: string }
type Check = (name: string, ok: boolean, detail: string) => void

const denied = (status: number | undefined) => status === 401 || status === 403
const firstLine = (text: string) => text.split('\n', 1)[0]?.slice(0, 160) ?? ''
const messagesPage = z.object({ messages: z.array(z.object({ id: z.string() })) })
const posted = z.object({ message: z.object({ id: z.string() }) })
const explained = z.object({ can: z.array(z.string()) })
/** A grant ID no board hands out: an owner's revoke of it changes nothing, so the probe is harmless. */
const missingGrant = 'g999999'
const inboxProbe = { id: 'devchat-verify-probe', text: 'devchat-host verify probe: not an intent' } as const

/** A denied post in `work` and a denied grant change, for a caller with no credentials. */
export async function checkAnonymousRoute(request: BoardRequester, route: string, check: Check) {
  const post = await request('/messages', { method: 'POST', body: { channel: channels.work, text: 'devchat-host verify probe' } })
  check(`${route}: post in work denied`, denied(post.status), `HTTP ${post.status}`)
  const grant = await request(`/grants/${missingGrant}/revoke`, { method: 'POST', body: {} })
  check(`${route}: grant change denied`, denied(grant.status), `HTTP ${grant.status}`)
}

/**
 * What the tailnet login may do (§5): no post, reply, or label in the conversation channels,
 * `sched`, `out`, or `sys` (where the board marker is the post to probe); in `inbox`, a label-free
 * post and nothing else; no grant change. Reply and label need a post to act on; in a channel with
 * none, the check falls back to `grants explain`.
 */
export async function checkTailnetRoute(request: BoardRequester, { route, login }: { route: string; login: string }, check: Check) {
  const me = await request('/me')
  const principal = me.status === 200 ? z.object({ principal: z.string() }).parse(JSON.parse(me.body)).principal : `HTTP ${me.status}`
  check(`${route}: acts as the tailnet login`, principal === `tailscale:user:${login}`, principal)

  for (const channel of [channels.todos, channels.work, channels.msg, channels.sched, channels.out, channels.sys]) {
    const post = await request('/messages', { method: 'POST', body: { channel, text: 'devchat-host verify probe' } })
    check(`${route}: post in ${channel} denied`, post.status === 403, `HTTP ${post.status}`)
    const page = await request(`/messages?channel=${channel}&limit=1`)
    const target = page.status === 200 ? messagesPage.parse(JSON.parse(page.body)).messages[0]?.id : undefined
    if (target === undefined) {
      const explain = await request(`/grants/explain?channel=${channel}`)
      const can = explain.status === 200 ? explained.parse(JSON.parse(explain.body)).can : []
      check(`${route}: reply and label in ${channel} denied (no post to probe; grants explain)`,
        can.length === 1 && can[0] === 'read', `can=[${can}]`)
      continue
    }
    const reply = await request('/messages', { method: 'POST', body: { re: target, text: 'devchat-host verify probe' } })
    check(`${route}: reply in ${channel} denied`, reply.status === 403, `HTTP ${reply.status} on #${target}`)
    const label = await request(`/messages/${target}/labels`, { method: 'POST', body: { set: { probe: '1' } } })
    check(`${route}: label write in ${channel} denied`, label.status === 403, `HTTP ${label.status} on #${target}`)
  }

  const labeled = await request('/messages', { method: 'POST', body: { channel: channels.inbox, text: 'devchat-host verify probe', labels: { applied: '1' } } })
  check(`${route}: labeled post in inbox denied`, labeled.status === 403, `HTTP ${labeled.status}`)
  // The same client ID posts once, so repeated runs leave one probe in inbox.
  const inbox = await request('/messages', { method: 'POST', body: { channel: channels.inbox, ...inboxProbe } })
  check(`${route}: label-free post in inbox succeeds`, inbox.status === 200 || inbox.status === 201, `HTTP ${inbox.status}`)
  if (inbox.status === 200 || inbox.status === 201) {
    const { id } = posted.parse(JSON.parse(inbox.body)).message
    const label = await request(`/messages/${id}/labels`, { method: 'POST', body: { set: { applied: '1' } } })
    check(`${route}: label write in inbox denied`, label.status === 403, `HTTP ${label.status} on #${id}`)
  }
  const grant = await request(`/grants/${missingGrant}/revoke`, { method: 'POST', body: {} })
  check(`${route}: grant change denied`, grant.status === 403, `HTTP ${grant.status}`)
}

/** How `vb --json` names a refusal: no credentials (`no_project`, `unauthorized`) or a 403 (`permission_denied`). */
const vbDeniedReasons = new Set(['no_project', 'unauthorized', 'forbidden', 'permission_denied'])

/** `vb` with the caller's own environment: denied a post in `work` and a grant change. */
export function checkVb({ url, route, node = hostPaths.node, cli = boardCli }: { url: string; route: string; node?: string; cli?: string }, check: Check) {
  for (const [what, args] of [
    ['post in work', ['post', channels.work, 'devchat-host verify probe']],
    ['grant change', ['grants', 'revoke', missingGrant]],
  ] as const) {
    const result = spawnSync(node, [cli, '--json', ...args], {
      env: { ...process.env, BOARD_URL: url },
      encoding: 'utf8',
      timeout: 30_000,
    })
    let reason = firstLine(result.stderr || result.stdout)
    try {
      reason = z.object({ reason: z.string() }).parse(JSON.parse(result.stderr)).reason
    } catch {
      // Not a JSON error: the check fails below and shows the first line instead.
    }
    check(`${route}: vb ${what} denied`, result.status !== 0 && vbDeniedReasons.has(reason), `exit ${result.status}, ${reason}`)
  }
}

async function errorCode(action: () => Promise<unknown>) {
  try {
    await action()
    return 'readable'
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : String(error)
  }
}

/** Environment a unit must not set: each one loads code from somewhere else. */
const codeLoadingEnv = /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT)=/

/** Settings the shipped units leave empty: each runs a command or reads a file besides ExecStart. */
const unshippedSettings = ['ExecCondition', 'ExecStartPre', 'ExecStartPost', 'ExecReload', 'ExecStop', 'ExecStopPost', 'EnvironmentFiles'] as const

/**
 * The files a unit uses, as systemd loaded it: its fragment, drop-ins, environment files, and each
 * absolute path in its commands; its environment; and which settings the shipped units leave empty
 * it sets. Reads `systemctl show -p` for ExecStart, Environment, DropInPaths, FragmentPath, and
 * `unshippedSettings`.
 */
export function parseUnitShow(text: string) {
  const values = new Map(text.split('\n').filter((line) => line.includes('=')).map((line) => {
    const at = line.indexOf('=')
    return [line.slice(0, at), line.slice(at + 1)] as const
  }))
  const files: string[] = []
  const fragment = values.get('FragmentPath')
  if (fragment) files.push(fragment)
  files.push(...(values.get('DropInPaths') ?? '').split(' ').filter(Boolean))
  for (const [, path] of (values.get('EnvironmentFiles') ?? '').matchAll(/(\/\S+) \(ignore_errors=/g)) if (path) files.push(path)
  for (const [, path, argv] of (values.get('ExecStart') ?? '').matchAll(/path=(\S+) ; argv\[\]=([^;]*);/g)) {
    if (path) files.push(path)
    files.push(...(argv ?? '').trim().split(/\s+/).filter((arg) => arg.startsWith('/')))
  }
  const environment = (values.get('Environment') ?? '').split(' ').filter(Boolean)
  for (const entry of environment) {
    const value = entry.slice(entry.indexOf('=') + 1)
    if (value.startsWith('/')) files.push(value)
  }
  const unshipped = unshippedSettings.filter((name) => values.get(name))
  return { files: [...new Set(files)], environment, unshipped }
}

const errorCodeOf = (error: unknown) => (error instanceof Error && 'code' in error ? String(error.code) : undefined)

/**
 * Why this account could change what `path` names, if it could: a component it owns or can write,
 * or a final file that is not root-owned or is group- or world-writable when `rootOwned`. A symlink
 * is followed and its target checked the same way. A component this account cannot reach ends
 * the check: it cannot write below it either.
 */
async function pathProblems(path: string, rootOwned: boolean, depth = 0): Promise<string[]> {
  if (depth > 20) return [`${path}: too many symlinks`]
  const uid = process.getuid?.()
  const parts = path.split('/').filter(Boolean)
  const problems: string[] = []
  let current = ''
  for (const [index, part] of parts.entries()) {
    current += `/${part}`
    let stat
    try {
      stat = await lstat(current)
    } catch (error) {
      if (errorCodeOf(error) === 'EACCES') return problems
      return [...problems, `${current}: ${errorCodeOf(error) ?? String(error)}`]
    }
    if (stat.uid === uid) problems.push(`${current} is owned by this account`)
    if (await errorCode(() => access(current, constants.W_OK)) === 'readable') problems.push(`${current} is writable by this account`)
    if (stat.isSymbolicLink()) {
      const rest = parts.slice(index + 1).join('/')
      const target = await realpath(current)
      return [...problems, ...await pathProblems(rest ? `${target}/${rest}` : target, rootOwned, depth + 1)]
    }
    const last = index === parts.length - 1
    if (last && rootOwned && stat.uid !== 0) problems.push(`${current} is owned by uid ${stat.uid}`)
    if (last && rootOwned && (stat.mode & 0o022) !== 0) problems.push(`${current} is group- or world-writable`)
  }
  return problems
}

/**
 * Every file the services execute or load, as systemd loaded the units, and every directory above
 * them: nothing this account could replace. The package tree under /opt/devchat must hold only
 * root-owned regular files and directories.
 */
async function checkNotWritable(check: Check) {
  const problems: string[] = []
  const files = new Set<string>([hostPaths.node, hostPaths.configFile])
  for (const unit of Object.values(unitNames)) {
    const shown = spawnSync('systemctl', ['show', '-p', ['ExecStart', 'Environment', 'DropInPaths', 'FragmentPath', ...unshippedSettings].join(','), unit], { encoding: 'utf8' })
    if (shown.status !== 0) {
      problems.push(`systemctl show ${unit} failed`)
      continue
    }
    const { files: named, environment, unshipped } = parseUnitShow(shown.stdout)
    if (!named.length) problems.push(`${unit} is not loaded`)
    for (const name of unshipped) problems.push(`${unit} sets ${name}`)
    for (const entry of environment) if (codeLoadingEnv.test(entry)) problems.push(`${unit} sets ${entry.slice(0, entry.indexOf('='))}`)
    for (const file of named) files.add(file)
  }
  // Data the services write (the state directory) belongs to the service account; everything else is root's.
  const isState = (file: string) => file === hostPaths.stateDir || file.startsWith(`${hostPaths.stateDir}/`)
  for (const file of files) problems.push(...await pathProblems(file, !isState(file)))
  let walked = 0
  async function walk(path: string) {
    walked += 1
    const stat = await lstat(path)
    if (!stat.isFile() && !stat.isDirectory()) problems.push(`${path} is not a regular file or directory`)
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) problems.push(`${path} is not root-owned or is group- or world-writable`)
    if (!stat.isDirectory()) return
    // Install's staging directory (711) is the one directory this account cannot list; being
    // root-owned and not writable, nothing below it changes from this account.
    const names = await readdir(path).catch((error: unknown) => {
      if (path === hostPaths.stageDir && errorCodeOf(error) === 'EACCES') return []
      throw error
    })
    for (const name of names) await walk(join(path, name))
  }
  problems.push(...await pathProblems(hostPaths.optDir, true))
  await walk(hostPaths.optDir)
  check('no file the services execute or load is replaceable by this account', problems.length === 0,
    problems.length === 0 ? `${files.size} files the units name, ${walked} paths under ${hostPaths.optDir}` : problems.slice(0, 5).join('; '))
}

/** What `/devchat.json` may hold, and nothing else: a field outside it, such as a token, fails. */
const appInfo = z.object({
  app: z.literal('devchat'),
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
  board: z.object({ reachable: z.boolean() }).strict(),
  epoch: z.number().int().optional(),
  inboxSchedulesCanceled: z.number().int().min(0),
}).strict()

async function checkApp(settings: Settings, check: Check) {
  const response = await fetch(`http://127.0.0.1:${settings.appPort}/devchat.json`, { signal: AbortSignal.timeout(10_000) })
  let info: z.infer<typeof appInfo> | undefined
  try {
    info = appInfo.parse(await response.json())
  } catch {
    // The response is not printed: it could hold what this check guards against.
  }
  check('app: /devchat.json holds only the approved fields', response.status === 200 && info !== undefined,
    info === undefined ? `HTTP ${response.status}, response outside the schema` : `version=${info.version}`)
  check('app: /devchat.json reports the board reachable with epoch 1', info?.board.reachable === true && info.epoch === 1,
    `reachable=${info?.board.reachable}, epoch=${info?.epoch}`)
}

/** The release 1 trust tests, run from the user's own account without sudo. */
export async function verifyHost(settings: Settings, { expose }: { expose: boolean }) {
  const results: CheckResult[] = []
  const check: Check = (name, ok, detail) => { results.push({ name, ok, detail }) }
  const loopback = boardUrl(settings)
  const tailnet = `https://${tailnetHost(settings)}/api/board`

  check('state directory unreadable', await errorCode(() => readdir(hostPaths.stateDir)) === 'EACCES', hostPaths.stateDir)
  const tokenFile = ownerTokenFile(hostPaths.configHome, loopback)
  const token = await errorCode(() => readFile(tokenFile))
  check('owner credential unreadable', token === 'EACCES', `${tokenFile}: ${token}`)
  await checkNotWritable(check)
  if (await errorCode(() => lstat(hostPaths.routesFile)) !== 'ENOENT') {
    const problems = await rootFileProblems(hostPaths.routesFile).catch((error: unknown) => [String(error)])
    check('recorded routes are root\'s alone', problems.length === 0, problems.length === 0 ? hostPaths.routesFile : problems.join('; '))
  }
  await checkApp(settings, check)

  await checkAnonymousRoute(plainClient(loopback), 'loopback, plain HTTP', check)
  checkVb({ url: loopback, route: 'loopback' }, check)
  await checkTailnetRoute(forgedTailnetClient({ url: loopback, host: tailnetHost(settings), login: settings.login }),
    { route: 'loopback, forged tailnet headers', login: settings.login }, check)
  if (expose) {
    checkVb({ url: tailnet, route: 'tailnet' }, check)
    await checkTailnetRoute(plainClient(tailnet), { route: 'tailnet, plain HTTP', login: settings.login }, check)
  }
  return results
}
