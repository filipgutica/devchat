import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { board } from '@vercel/board'
import { setupBoard } from '../src/host/grants.ts'
import { createApp } from '../src/server/app.ts'
import { guardReason } from '../src/server/guard.ts'
import { createStateWriter } from '../src/server/writer.ts'
import type { Intent } from '../src/shared/layout.ts'
import { startBoardServer } from '../src/testing/index.ts'

type UiHostOptions = {
  /** The address the front server listens on: loopback, or the Tailscale address with `--serve`. */
  bind?: string
  port?: number
  /** The name the browser uses for this host; the app answers only this `Host`. */
  host?: string
  login?: string
  allowlist?: string[]
  /** Without it the app has no text guard and refuses every write (503). */
  guard?: boolean
  /** Run an ingest pass this often and after each UI write, as the host's app does; off when unset. */
  ingestEvery?: number
  /** Where the board keeps its data; inside the repository by default, so nothing lands in a system temp folder. */
  directory?: string
}

/** A reply no browser accepts: two different lengths for one body. */
const brokenReply = 'HTTP/1.1 201 Created\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const shell = join(repoRoot, 'dist', 'ui')

/**
 * A local devchat host for development and the UI tests: a real `vb serve` with devchat's grants,
 * the state writer, and the app with its UI route and built shell, behind a front server that
 * stands in for `tailscale serve`. Like `tailscale serve`, the front server sets the tailnet login
 * and forwards the browser's `Host`. It has no TLS, so it also stands in for the HTTPS origin: for a
 * request whose `Origin` is exactly its own http origin, it forwards `Origin: https://<host>`, and
 * `Sec-Fetch-Site: same-origin` when the browser sent none (browsers send it only to a secure
 * context, which a plain-http tailnet address is not). Any other request passes through unchanged,
 * so the app's checks still refuse it.
 */
export async function startUiHost({
  bind = '127.0.0.1', port = 0, host = '127.0.0.1', login = 'user@example.com', allowlist = ['example'],
  guard = true, ingestEvery, directory = join(repoRoot, '.board', 'ui-host'),
}: UiHostOptions = {}) {
  await mkdir(directory, { recursive: true })
  const server = await startBoardServer({ directory })
  process.env.BOARD_URL = server.url
  process.env.XDG_CONFIG_HOME = server.configHome
  await setupBoard(board(), login, () => {})
  const stateDir = await mkdtemp(join(directory, 'app-'))
  const writer = createStateWriter({ settings: { allowlist, machines: {} }, stateFile: join(stateDir, 'app-state.json') })

  // The front server listens first: the app's route needs its port, which is the page's origin.
  const front = createServer((req, res) => void forward(req, res))
  front.listen(port, bind)
  await once(front, 'listening')
  const frontPort = (front.address() as AddressInfo).port
  const authority = `${host}:${frontPort}`

  let timer: NodeJS.Timeout | undefined
  const pass = () => writer.pass()
  const wake = () => {
    if (ingestEvery === undefined) return
    clearTimeout(timer)
    void pass().catch((error: unknown) => console.error('devchat dev: ingest pass failed:', error))
      .finally(() => { timer = setTimeout(wake, ingestEvery) })
  }
  const app = createApp({
    version: 'dev', shell,
    ui: { settings: { login, host, httpsPort: frontPort }, guard: guard ? guardReason : undefined, writer, onWrite: wake },
  })
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  const appPort = (app.address() as AddressInfo).port
  wake()

  let reachable = true
  let dropNext = false
  /** The body of every UI write the front server forwarded, in order. */
  const writes: string[] = []

  function upstreamHeaders(req: IncomingMessage): IncomingHttpHeaders {
    const headers: IncomingHttpHeaders = { ...req.headers, 'tailscale-user-login': login }
    if (req.headers.origin === `http://${authority}`) {
      headers.origin = `https://${authority}`
      headers['sec-fetch-site'] ??= 'same-origin'
    }
    return headers
  }

  async function forward(req: IncomingMessage, res: ServerResponse) {
    // Unreachable: the connection drops, as it does when the host is down.
    if (!reachable) return void req.socket.destroy()
    const isWrite = req.method === 'POST' && req.url === '/api/ui/posts'
    const chunks: Buffer[] = []
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    if (isWrite) writes.push(body.toString('utf8'))
    const drop = isWrite && dropNext
    if (drop) dropNext = false
    const upstream = request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: upstreamHeaders(req) }, (answer) => {
      // A lost answer: the app finished the write, and the browser gets a reply it must reject, so
      // fetch fails as on a dropped connection. An empty reply would not do: a browser silently
      // resends the request after one, and the page never sees the failure.
      if (drop) return void answer.resume().on('end', () => req.socket.end(brokenReply))
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end())
    upstream.end(body)
  }

  return {
    url: `http://${authority}/`,
    writes,
    /** The board's owner, to read what the app wrote. */
    owner: board(),
    pass,
    /** Posts an agent's intent in `inbox`, as the tailnet login; a pass applies it. */
    async submit(intent: Intent) {
      const response = await server.tailnet.request('/messages', { method: 'POST', body: { channel: 'inbox', text: JSON.stringify(intent), id: intent.rid } })
      if (response.status !== 201) throw new Error(`inbox post failed: ${response.status} ${response.body}`)
    },
    /**
     * Sample items, as agents and the user would make them: open, blocked, and answered work items,
     * todos in #global and a project channel, and a resolved todo. Repos are under the `example` owner.
     */
    async seed() {
      const agent = { v: 1, by: 'laptop-claude' } as const
      const intents: Intent[] = [
        { ...agent, rid: 'seed-todo-1', kind: 'todo', channel: 'todos', text: 'Rotate the backup drive before Friday.' },
        { ...agent, rid: 'seed-todo-2', kind: 'todo', channel: 'todos', text: 'Write the release notes for 0.2.', repo: 'example/devchat' },
        { ...agent, rid: 'seed-todo-3', kind: 'todo', channel: 'todos', text: 'Renew the tailnet certificate.' },
        { ...agent, rid: 'seed-done-3', kind: 'done', root: 'seed-todo-3', text: '' },
        { ...agent, by: 'desktop-claude', rid: 'seed-work-1', kind: 'work', channel: 'work', text: 'devchat: build the web UI', repo: 'example/devchat' },
        { ...agent, by: 'desktop-claude', rid: 'seed-note-1', kind: 'note', root: 'seed-work-1', text: 'Needs you, channels, and the thread pane render against a local board.' },
        { ...agent, by: 'desktop-claude', rid: 'seed-ask-1', kind: 'ask', root: 'seed-work-1', block: 1, text: 'Should the composer keep a draft after a refused write, or clear it?' },
        { ...agent, rid: 'seed-work-2', kind: 'work', channel: 'work', text: 'annoterm: render Markdown tables', repo: 'example/annoterm' },
        { ...agent, rid: 'seed-ask-2', kind: 'ask', root: 'seed-work-2', text: 'Wide tables in narrow terminals: scroll sideways, or wrap cells?' },
        { ...agent, by: 'desktop-codex', rid: 'seed-work-3', kind: 'work', channel: 'work', text: 'Docs preview deploys', repo: 'example/devchat' },
        { ...agent, by: 'desktop-codex', rid: 'seed-ask-3', kind: 'ask', root: 'seed-work-3', text: 'Deploy previews for every branch, or only for pull requests?' },
      ]
      for (const intent of intents) await this.submit(intent)
      await pass()
      await writer.writeUser({ kind: 'answer', rid: 'ui-00000000-0000-4000-8000-000000000001', root: 'seed-work-3', re: 'seed-ask-3', text: 'Only for pull requests.' })
    },
    /** Lets the next UI write reach the app, and drops its answer. */
    dropNextWriteResponse() {
      dropNext = true
    },
    setReachable(value: boolean) {
      reachable = value
    },
    async stop() {
      clearTimeout(timer)
      front.closeAllConnections()
      app.closeAllConnections()
      await Promise.all([new Promise((done) => front.close(done)), new Promise((done) => app.close(done))])
      await server.stop()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}

export type UiHost = Awaited<ReturnType<typeof startUiHost>>
