import { spawnSync } from 'node:child_process'
import { access, constants, lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { channels } from '../shared/layout.ts'
import { forgedTailnetClient, plainClient, type BoardRequester } from './board-http.ts'
import { boardCli, boardUrl, hostPaths, ownerTokenFile, tailnetHost, unitNames, type Settings } from './settings.ts'

export type CheckResult = { name: string; ok: boolean; detail: string }
type Check = (name: string, ok: boolean, detail: string) => void

const denied = (status: number | undefined) => status === 401 || status === 403
const firstLine = (text: string) => text.split('\n', 1)[0]?.slice(0, 160) ?? ''
const messagesPage = z.object({ messages: z.array(z.object({ id: z.string() })) })
const posted = z.object({ message: z.object({ id: z.string() }) })
const explained = z.object({ can: z.array(z.string()) })
/** A grant ID no board hands out: an owner's revoke of it changes nothing, so the probe is harmless. */
const missingGrant = 'g999999'
export const inboxProbe = { id: 'devchat-verify-probe', text: 'devchat-host verify probe: not an intent' } as const

/** A denied post in `work` and a denied grant change, for a caller with no credentials. */
export async function checkAnonymousRoute(request: BoardRequester, route: string, check: Check) {
  const post = await request('/messages', { method: 'POST', body: { channel: channels.work, text: 'devchat-host verify probe' } })
  check(`${route}: post in work denied`, denied(post.status), `HTTP ${post.status}`)
  const grant = await request(`/grants/${missingGrant}/revoke`, { method: 'POST', body: {} })
  check(`${route}: grant change denied`, denied(grant.status), `HTTP ${grant.status}`)
}

/**
 * What the tailnet login may do (§5): no post, reply, or label in the conversation channels or
 * `sys` (where the board marker is the post to probe), no label in `inbox`, no grant change, and a label-free `inbox` post. Reply and label need a post to
 * act on; in a channel with none, the check falls back to `grants explain`.
 */
export async function checkTailnetRoute(request: BoardRequester, { route, login }: { route: string; login: string }, check: Check) {
  const me = await request('/me')
  const principal = me.status === 200 ? z.object({ principal: z.string() }).parse(JSON.parse(me.body)).principal : `HTTP ${me.status}`
  check(`${route}: acts as the tailnet login`, principal === `tailscale:user:${login}`, principal)

  for (const channel of [channels.todos, channels.work, channels.msg, channels.sys]) {
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

/** `vb` from the user's account, with the user's own environment: denied a post in `work` and a grant change. */
function checkVb(url: string, route: string, check: Check) {
  const deniedReasons = new Set(['no_project', 'unauthorized', 'forbidden'])
  for (const [what, args] of [
    ['post in work', ['post', channels.work, 'devchat-host verify probe']],
    ['grant change', ['grants', 'revoke', missingGrant]],
  ] as const) {
    const result = spawnSync(hostPaths.node, [boardCli, '--json', ...args], {
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
    check(`${route}: vb ${what} denied`, result.status !== 0 && deniedReasons.has(reason), `exit ${result.status}, ${reason}`)
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

/** Every path the services execute or load, and each directory above them: root-owned, and not writable by this account. */
async function checkNotWritable(check: Check) {
  const roots = ['/opt', hostPaths.optDir, hostPaths.configDir, hostPaths.unitDir]
  const files = [hostPaths.configFile, ...Object.values(unitNames).map((name) => join(hostPaths.unitDir, name))]
  const problems: string[] = []
  let checked = 0
  async function inspect(path: string, walk: boolean) {
    checked += 1
    // A path this account cannot even reach, such as app.json inside /etc/devchat (750), it cannot write.
    const stat = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'EACCES') return undefined
      throw error
    })
    if (stat === undefined) return
    const writable = (await errorCode(() => access(path, constants.W_OK))) === 'readable'
    if (stat.uid !== 0) problems.push(`${path} is owned by uid ${stat.uid}`)
    if (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0) problems.push(`${path} is group- or world-writable`)
    if (writable) problems.push(`${path} is writable by this account`)
    if (walk && stat.isDirectory()) {
      for (const name of await readdir(path)) await inspect(join(path, name), true)
    }
  }
  for (const root of roots) await inspect(root, root === hostPaths.optDir)
  for (const file of files) await inspect(file, false)
  check('no file the services execute is writable by this account', problems.length === 0,
    problems.length === 0 ? `${checked} paths under /opt/devchat, /etc/devchat, and the units` : problems.slice(0, 5).join('; '))
}

async function checkApp(settings: Settings, check: Check) {
  const response = await fetch(`http://127.0.0.1:${settings.appPort}/devchat.json`, { signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  const info = z.object({ board: z.object({ reachable: z.boolean() }), epoch: z.number().optional() }).safeParse(JSON.parse(body))
  check('app: /devchat.json reports the board reachable with epoch 1',
    response.status === 200 && info.success && info.data.board.reachable && info.data.epoch === 1, body.slice(0, 160))
  check('app: /devchat.json shows no token', !/token/i.test(body), 'no "token" in the response')
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
  await checkApp(settings, check)

  await checkAnonymousRoute(plainClient(loopback), 'loopback, plain HTTP', check)
  checkVb(loopback, 'loopback', check)
  await checkTailnetRoute(forgedTailnetClient({ url: loopback, host: tailnetHost(settings), login: settings.login }),
    { route: 'loopback, forged tailnet headers', login: settings.login }, check)
  if (expose) {
    checkVb(tailnet, 'tailnet', check)
    await checkTailnetRoute(plainClient(tailnet), { route: 'tailnet, plain HTTP', login: settings.login }, check)
  }
  return results
}
