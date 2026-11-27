import type { Board } from '@vercel/board'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tailnetHost, type Settings } from '../host/settings.ts'
import { channels, rid, userWriteSchema } from '../shared/layout.ts'
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
const refusalStatus: Record<UserWriteRefusal, number> = { repo: 400, root: 404, re: 400, invalid: 400 }
const maxBody = 64 * 1024

const json = (response: ServerResponse, status: number, body: unknown) => void response
  .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  .end(JSON.stringify(body))

const header = (request: IncomingMessage, name: string) => {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
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

/** Every page of threads a label query matches, newest activity first. */
async function allThreads(port: BoardPort, query: { channel: ViewChannel; label: string[] }) {
  const threads = []
  for (let before: string | undefined; ;) {
    const page = await port.threadsByLabel({ ...query, limit: 500, ...(before ? { before } : {}) })
    threads.push(...page.threads)
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
 * The read endpoints of the release 1 views (§12), as the board answers them, through the owner.
 * Each reads only `todos` and `work`.
 */
const reads: Record<string, (port: BoardPort, query: URLSearchParams) => Promise<[number, unknown]>> = {
  // Needs you: open questions and blocked items, then the threads waiting for an agent.
  async 'needs-you'(port) {
    const open = await viewThreads(port, ['ask=open', 'status=blocked'])
    const answered = await viewThreads(port, ['ask=answered'])
    return [200, { open, answered }]
  },
  // The project channels: every allowlisted repo a todo or work item names.
  async channels(port) {
    const repos = new Set((await viewThreads(port, ['repo'])).flatMap(({ message }) => message.labels.repo ?? []))
    return [200, { repos: [...repos].sort() }]
  },
  // One channel's open threads, or with `resolved=1` its resolved ones, a page at a time.
  async threads(port, query) {
    const channel = query.get('channel')
    if (!isViewChannel(channel)) return [400, { error: 'channel must be todos or work' }]
    const label = [query.get('resolved') === '1' ? 'status=done|dropped' : 'status=open|blocked']
    const repo = query.get('repo')
    if (repo) label.push(`repo=${repo}`)
    const before = query.get('before')
    const page = await port.threadsByLabel({ channel, label, ...(before ? { before } : {}) })
    return [200, { threads: page.threads, older: page.older ?? null }]
  },
  // One thread by its root's rid, with every reply.
  async thread(port, query) {
    const parsed = rid.safeParse(query.get('rid'))
    const root = parsed.success ? await findOwn(port, `app:${parsed.data}`) : null
    if (!root || root.re !== null || !isViewChannel(root.channel)) return [404, { error: 'no such thread' }]
    return [200, await readWholeThread(port, root.id)]
  },
}

/**
 * The UI route (§12): the browser's one way to write, and the reads its views need, under
 * `/api/ui/`. `tailscale serve` is the only way in, so every request must carry its `Host` and the
 * configured `Tailscale-User-Login`. A write must also be a same-origin JSON POST from the
 * devchat origin. Each write is guarded, then made by the state writer with `by=user`.
 *
 * Any host process can forge these headers on loopback; spec §13 accepts that (agent error, not
 * an attacker), and the client CLI holds no code that calls this route.
 */
export function createUiRoute({ settings, guard, writer, openBoard, onWrite }: UiRouteOptions) {
  const origin = new URL(`https://${tailnetHost(settings)}`)

  async function write(request: IncomingMessage, response: ServerResponse) {
    if (header(request, 'sec-fetch-site') !== 'same-origin' || header(request, 'origin') !== origin.origin) {
      return json(response, 403, { error: 'cross-origin request' })
    }
    if (!guard) return json(response, 503, { error: 'the text guard is not loaded' })
    if (header(request, 'content-type')?.split(';')[0]?.trim() !== 'application/json') {
      return json(response, 415, { error: 'send application/json' })
    }
    const body = await readBody(request)
    if (body === null) return json(response, 413, { error: 'request body too large' })
    let parsed
    try {
      parsed = userWriteSchema.safeParse(JSON.parse(body))
    } catch {
      return json(response, 400, { error: 'invalid JSON' })
    }
    if (!parsed.success) return json(response, 400, { error: 'invalid write', issues: parsed.error.issues })
    const reason = 'text' in parsed.data ? guard(parsed.data.text) : null
    if (reason) return json(response, 422, { error: `the guard refused the text: ${reason}`, refused: 'guard' })
    const result = await writer.writeUser(parsed.data)
    if ('refused' in result) return json(response, refusalStatus[result.refused], { error: 'refused', refused: result.refused })
    json(response, 201, result)
    onWrite?.()
  }

  /** Answers a request under `/api/ui/`. */
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (header(request, 'host')?.toLowerCase() !== origin.host) return json(response, 403, { error: 'wrong host' })
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
