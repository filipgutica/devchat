import type { Board, MessageView } from '@vercel/board'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Settings } from '../host/settings.ts'
import { channels, rid, userWriteSchema, type UserWrite } from '../shared/layout.ts'
import { createBoardPort, type BoardPort } from './board-port.ts'
import type { Guard } from './guard.ts'
import { findOwn, readWholeThread, type StateWriter, type UserWriteRefusal } from './writer.ts'

export type UiRouteOptions = {
  settings: Pick<Settings, 'login' | 'host' | 'httpsPort'>
  /** The server's text guard. Without it the route refuses every write (§5, §12). */
  guard: Guard | undefined
  writer: Pick<StateWriter, 'writeUser'>
  openBoard: () => Board
  /** Runs after each write the route made: main wakes the ingest loop (§12). */
  onWrite?: () => void
}

/** The channels the route reads and writes in release 1. No query reaches any other channel. */
const viewChannels = [channels.todos, channels.work] as const
type ViewChannel = typeof viewChannels[number]
const isViewChannel = (value: string | null): value is ViewChannel => viewChannels.some((channel) => channel === value)

/** The HTTP status of each reason the writer refuses a UI write. */
const refusalStatus: Record<UserWriteRefusal, number> = { repo: 400, root: 404, re: 400, invalid: 400, conflict: 409 }
const maxBody = 64 * 1024
const openPageSize = 50
/** Search returns at most this many threads from each view channel, newest activity first. */
const searchLimit = 50
const maxQuery = 200

const json = (response: ServerResponse, status: number, body: unknown) => void response
  .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  .end(JSON.stringify(body))

/** A header's one value, or undefined when it is missing or sent more than once. */
const header = (request: IncomingMessage, name: string) => {
  const values = request.headersDistinct[name]
  return values?.length === 1 ? values[0] : undefined
}

async function readBody(request: IncomingMessage) {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBody) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** A thread whose root is not deleted: Board answers a deleted root as a tombstone with no labels. */
const isLive = ({ message }: { message: MessageView }) => !message.deleted

/** Every live thread a label query matches, newest activity first. */
async function allThreads(port: BoardPort, query: { channel: ViewChannel; label: string[] }) {
  const threads = []
  for (let before: string | undefined; ;) {
    const page = await port.threads({ ...query, limit: 500, ...(before ? { before } : {}) })
    threads.push(...page.threads.filter(isLive))
    if (!page.older) return threads
    before = page.older
  }
}

/**
 * Threads of the two view channels that match any of `labels`, each thread once. A label is Board's
 * `key=value`, or `key` for any value.
 */
async function viewThreads(port: BoardPort, labels: string[]) {
  const found = new Map<string, Awaited<ReturnType<typeof allThreads>>[number]>()
  for (const channel of viewChannels) {
    for (const label of labels) {
      for (const thread of await allThreads(port, { channel, label: [label] })) found.set(thread.message.id, thread)
    }
  }
  return [...found.values()]
}

/**
 * Each thread with the post its `turn` names, the question that waits or the user's answer, which a
 * Needs you row shows. A later reply can follow it: the pending guard skips an agent's note that does
 * not answer the user (§2), so `last` is not always the turn.
 */
async function withTurn<T extends { message: MessageView; last: MessageView | null }>(port: BoardPort, threads: T[]) {
  return Promise.all(threads.map(async (thread) => {
    const { turn } = thread.message.labels
    const post = !turn ? null : thread.last?.labels.rid === turn ? thread.last : await findOwn(port, `app:${turn}`)
    return { ...thread, turn: post && !post.deleted ? post : null }
  }))
}

const isOpen = (status: string | undefined) => status === undefined || status === 'open' || status === 'blocked'

/**
 * A page of a channel's open threads. A root with no `status` yet is open (§2), and Board can't
 * query a missing label, so this reads the channel's threads and keeps the open ones, reading on
 * until it has a page's worth or reaches the end.
 */
async function openThreads(port: BoardPort, { channel, repo, before }: { channel: ViewChannel; repo: string | null; before: string | undefined }) {
  const threads = []
  let older: string | null = before ?? null
  do {
    const page = await port.threads({ channel, limit: openPageSize, ...(repo ? { label: [`repo=${repo}`] } : {}), ...(older ? { before: older } : {}) })
    threads.push(...page.threads.filter((thread) => isLive(thread) && isOpen(thread.message.labels.status)))
    older = page.older ?? null
  } while (older !== null && threads.length < openPageSize)
  return { threads, older }
}

/**
 * The read endpoints of the release 1 views (§12), as the board answers them, through the owner.
 * Each reads only `todos` and `work`.
 */
const reads: Record<string, (port: BoardPort, query: URLSearchParams) => Promise<[number, unknown]>> = {
  // Needs you: open questions and blocked items, then the threads waiting for an agent. A user
  // answer moves a blocked item to the second list: `ask=answered` wins over `status=blocked`. The
  // second read runs last, so a thread answered between the two reads shows only there.
  async 'needs-you'(port) {
    const candidates = await viewThreads(port, ['ask=open', 'status=blocked'])
    const answered = await viewThreads(port, ['ask=answered'])
    const answeredIds = new Set(answered.map(({ message }) => message.id))
    // A candidate's own snapshot can say `ask=answered` too, when it was resolved before the second read.
    const open = candidates.filter(({ message }) => message.labels.ask !== 'answered' && !answeredIds.has(message.id))
    return [200, { open: await withTurn(port, open), answered: await withTurn(port, answered) }]
  },
  // The project channels: every allowlisted repo a todo or work item names.
  async channels(port) {
    const repos = new Set((await viewThreads(port, ['repo'])).flatMap(({ message }) => message.labels.repo ?? []))
    return [200, { repos: [...repos].sort() }]
  },
  // One channel's open threads, or with `resolved=1` its resolved ones, a page at a time: pass
  // `older` back as `before` until it is null.
  async threads(port, query) {
    const channel = query.get('channel')
    if (!isViewChannel(channel)) return [400, { error: 'channel must be todos or work' }]
    const repo = query.get('repo')
    const before = query.get('before') ?? undefined
    if (query.get('resolved') === '1') {
      const page = await port.threads({ channel, label: ['status=done|dropped', ...(repo ? [`repo=${repo}`] : [])], ...(before ? { before } : {}) })
      return [200, { threads: page.threads.filter(isLive), older: page.older ?? null }]
    }
    return [200, await openThreads(port, { channel, repo, before })]
  },
  // Search (§12): the board's text filter over a view channel's threads, open and resolved alike,
  // or over both view channels without `channel`. It matches a thread's root or its replies.
  async search(port, query) {
    const q = query.get('q')?.trim() ?? ''
    if (q.length === 0 || q.length > maxQuery) return [400, { error: `q must be 1 to ${maxQuery} characters` }]
    const channel = query.get('channel')
    if (channel !== null && !isViewChannel(channel)) return [400, { error: 'channel must be todos or work' }]
    const threads = []
    for (const one of channel === null ? viewChannels : [channel]) {
      const page = await port.threads({ channel: one, text: q, limit: searchLimit })
      threads.push(...page.threads.filter(isLive))
    }
    return [200, { threads }]
  },
  // One thread by its root's rid, with every reply.
  async thread(port, query) {
    const parsed = rid.safeParse(query.get('rid'))
    const root = parsed.success ? await findOwn(port, `app:${parsed.data}`) : null
    if (!root || root.deleted || root.re !== null || !isViewChannel(root.channel)) return [404, { error: 'no such thread' }]
    // The root can be deleted after the lookup above: check the snapshot the read returns.
    const thread = await readWholeThread(port, root.id)
    return thread.root.deleted ? [404, { error: 'no such thread' }] : [200, thread]
  },
}

/** The UI write a request's JSON body holds, once the guard passes every string it writes, or why not. */
async function readWrite(request: IncomingMessage, guard: Guard): Promise<{ write: UserWrite } | { status: number; error: object }> {
  if (header(request, 'content-type')?.split(';')[0]?.trim() !== 'application/json') {
    return { status: 415, error: { error: 'send application/json' } }
  }
  const body = await readBody(request)
  if (body === null) return { status: 413, error: { error: 'request body too large' } }
  let parsed
  try {
    parsed = userWriteSchema.safeParse(JSON.parse(body))
  } catch {
    return { status: 400, error: { error: 'invalid JSON' } }
  }
  if (!parsed.success) return { status: 400, error: { error: 'invalid write', issues: parsed.error.issues } }
  // Every string the request writes to the board, its `repo` too.
  const reason = Object.values(parsed.data).flatMap((value) => (typeof value === 'string' ? guard(value) ?? [] : []))[0]
  if (reason) return { status: 422, error: { error: `the guard refused the text: ${reason}`, refused: 'guard' } }
  return { write: parsed.data }
}

/**
 * The UI route (§12): the browser's one way to write, and the reads its views need, under
 * `/api/ui/`. `tailscale serve` is the only way in, and it forwards the browser's `Host` unchanged:
 * `<host>:<https port>`, or `<host>` on 443. So every request must carry exactly that `Host` and the
 * configured `Tailscale-User-Login`, each once. A write must also be a same-origin JSON POST from
 * the devchat origin. Each write is guarded, then made by the state writer with `by=user`.
 *
 * Write contract (`userWriteSchema`): the browser makes a new rid, `ui-<lowercase UUID>`, for each
 * write and resends the same body with it on a retry. A retry of a write the app already made
 * answers 200 with the same `{rid, state}` and writes nothing; a new write answers 201. The same rid
 * with another body answers 409 `conflict`. Refusals: 400 for an invalid body, `repo`, `re`, or
 * `invalid`; 404 `root`; 422 `guard`; 503 while the guard is missing.
 *
 * Any host process can forge these headers on loopback; spec §13 accepts that (agent error, not
 * an attacker), and the client CLI holds no code that calls this route.
 */
export function createUiRoute({ settings, guard, writer, openBoard, onWrite }: UiRouteOptions) {
  const host = settings.host.toLowerCase()
  const authority = settings.httpsPort === 443 ? host : `${host}:${settings.httpsPort}`
  const origin = `https://${authority}`

  async function write(request: IncomingMessage, response: ServerResponse) {
    if (header(request, 'sec-fetch-site') !== 'same-origin' || header(request, 'origin') !== origin) {
      return json(response, 403, { error: 'cross-origin request' })
    }
    if (!guard) return json(response, 503, { error: 'the text guard is not loaded' })
    const parsed = await readWrite(request, guard)
    if (!('write' in parsed)) return json(response, parsed.status, parsed.error)
    const result = await writer.writeUser(parsed.write)
    if ('refused' in result) return json(response, refusalStatus[result.refused], { error: 'refused', refused: result.refused })
    const { replayed, ...written } = result
    json(response, replayed ? 200 : 201, written)
    onWrite?.()
  }

  /** Answers a request under `/api/ui/`. */
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (header(request, 'host') !== authority) return json(response, 403, { error: 'wrong host' })
    if (header(request, 'tailscale-user-login')?.toLowerCase() !== settings.login) return json(response, 403, { error: 'wrong login' })
    const name = url.pathname.slice('/api/ui/'.length)
    if (name === 'posts') {
      if (request.method !== 'POST') return void response.writeHead(405, { Allow: 'POST' }).end()
      return write(request, response)
    }
    const read = Object.hasOwn(reads, name) ? reads[name] : undefined
    if (!read) return void response.writeHead(404).end()
    if (request.method !== 'GET') return void response.writeHead(405, { Allow: 'GET' }).end()
    const [status, body] = await read(createBoardPort(openBoard()), url.searchParams)
    json(response, status, body)
  }
}
