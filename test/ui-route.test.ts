import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { board, type Board, type MessageView } from '@vercel/board'
import { setupBoard } from '../src/host/grants.ts'
import { createApp } from '../src/server/app.ts'
import { guardReason } from '../src/server/guard.ts'
import { createStateWriter } from '../src/server/writer.ts'
import type { Intent } from '../src/shared/layout.ts'
import { startBoardServer } from '../src/testing/index.ts'

type Labels = Record<string, string>
type Headers = Record<string, string | undefined>
/** A UI write's answer: its post's rid and its root's state, or why it was refused. */
type WriteBody = { rid: string; state: Labels; refused?: string }
type Thread = { message: MessageView }

/** A promise and the function that resolves it. */
function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const settings = { login: 'user@example.com', host: 'devchat.example.test', httpsPort: 8443 }
/** What `tailscale serve` and a browser on the devchat page send. */
const browser: Headers = {
  Host: 'devchat.example.test:8443',
  'Tailscale-User-Login': 'user@example.com',
  'Sec-Fetch-Site': 'same-origin',
  Origin: 'https://devchat.example.test:8443',
  'Content-Type': 'application/json',
}

/**
 * A real `vb serve` with devchat's grants, a state writer, and the app with its UI route on
 * loopback. `openBoard` lets a test watch the writer's board calls.
 */
async function startHost(t: TestContext, { withGuard = true, openBoard = () => board() } = {}) {
  const server = await startBoardServer()
  t.after(server.stop)
  process.env.BOARD_URL = server.url
  process.env.XDG_CONFIG_HOME = server.configHome
  await setupBoard(board(), settings.login, () => {})
  const dir = await mkdtemp(join(tmpdir(), 'devchat-ui-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const writer = createStateWriter({ settings: { allowlist: ['example'], machines: {} }, stateFile: join(dir, 'app-state.json'), openBoard })
  const app = createApp({ version: '0.0.0', ui: { settings, guard: withGuard ? guardReason : undefined, writer } })
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  t.after(() => app.close())
  const port = (app.address() as AddressInfo).port
  const owner = board()

  /** An HTTP call to the app; `node:http`, because `fetch` cannot set `Host`. */
  const call = (path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Headers; body?: unknown } = {}) => {
    const sent = Object.fromEntries(Object.entries({ ...browser, ...headers }).filter((entry): entry is [string, string] => entry[1] !== undefined))
    return new Promise<{ status: number | undefined; json: <T = WriteBody>() => T }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, headers: sent }, (res) => {
        let text = ''
        res.setEncoding('utf8').on('data', (chunk: string) => { text += chunk }).on('end', () => resolve({ status: res.statusCode, json: <T>() => JSON.parse(text) as T }))
      })
      req.on('error', reject)
      req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
    })
  }
  const write = (body: unknown, headers: Headers = {}) => call('/api/ui/posts', { method: 'POST', body, headers })
  /** An agent's intent, posted in `inbox` as the tailnet login. */
  const submit = async (intent: Intent) => {
    const response = await server.tailnet.request('/messages', { method: 'POST', body: { channel: 'inbox', text: JSON.stringify(intent), id: intent.rid } })
    assert.equal(response.status, 201, response.body)
  }
  const messages = async (channel: string) => {
    const all: MessageView[] = []
    for (let page = await owner.channel(channel).messages({ after: '0' }); page.messages.length > 0;
      page = await owner.channel(channel).messages({ after: page.cursor })) all.push(...page.messages)
    return all
  }
  const posted = async (rid: string) => (await owner.posted(`app:${rid}`))
  return { writer, call, write, submit, messages, posted }
}

const agent = { v: 1, by: 'laptop-claude' } as const

test('The route refuses a wrong login, a wrong Host, a cross-origin request, a non-POST write, and guarded text, and writes nothing', async (t) => {
  const host = await startHost(t)
  const todo = { kind: 'todo', text: 'Review the handoff.' }
  const cases: [string, Promise<{ status: number | undefined }>, number][] = [
    ['wrong login', host.write(todo, { 'Tailscale-User-Login': 'other@example.com' }), 403],
    ['no login', host.write(todo, { 'Tailscale-User-Login': undefined }), 403],
    ['wrong Host', host.write(todo, { Host: '127.0.0.1' }), 403],
    ['Host without the HTTPS port', host.write(todo, { Host: 'devchat.example.test' }), 403],
    ['cross-site request', host.write(todo, { 'Sec-Fetch-Site': 'cross-site' }), 403],
    ['same-site request', host.write(todo, { 'Sec-Fetch-Site': 'same-site' }), 403],
    ['no Sec-Fetch-Site', host.write(todo, { 'Sec-Fetch-Site': undefined }), 403],
    ['other Origin', host.write(todo, { Origin: 'https://evil.example.test' }), 403],
    ['no Origin', host.write(todo, { Origin: undefined }), 403],
    ['form post', host.write('kind=todo&text=x', { 'Content-Type': 'application/x-www-form-urlencoded' }), 415],
    ['PUT', host.call('/api/ui/posts', { method: 'PUT', body: todo }), 405],
    ['GET', host.call('/api/ui/posts'), 405],
    ['guarded text', host.write({ kind: 'todo', text: 'api_key=<secret>' }), 422],
    ['guarded reply text', host.write({ kind: 'answer', root: 'work-1', text: 'Check /home/someone/notes.txt' }), 422],
    ['a read with a wrong login', host.call('/api/ui/needs-you', { headers: { 'Tailscale-User-Login': 'other@example.com' } }), 403],
    ['a read with a wrong Host', host.call('/api/ui/needs-you', { headers: { Host: 'localhost' } }), 403],
  ]
  for (const [name, response, status] of cases) assert.equal((await response).status, status, name)
  assert.deepEqual([...await host.messages('todos'), ...await host.messages('work')], [])
  // The same request with the browser's headers goes through.
  assert.equal((await host.write(todo)).status, 201)
})

test('The route refuses every write while its guard is missing', async (t) => {
  const host = await startHost(t, { withGuard: false })
  await host.submit({ ...agent, rid: 'work-1', kind: 'work', channel: 'work', text: 'Goal.' })
  await host.writer.pass()
  const before = await host.messages('work')
  for (const body of [
    { kind: 'todo', text: 'Review the handoff.' },
    { kind: 'work', text: 'A goal.' },
    { kind: 'answer', root: 'work-1', text: 'Yes.' },
    { kind: 'done', root: 'work-1' },
  ]) assert.equal((await host.write(body)).status, 503, body.kind)
  assert.deepEqual(await host.messages('todos'), [])
  assert.deepEqual(await host.messages('work'), before)
})

test('A UI post carries by=user and its own rid; no request field sets by, rid, or labels', async (t) => {
  // That no intent yields by=user: writer.test.ts, "Ingest: kind=answer, by=user, …".
  const host = await startHost(t)
  const root = await host.write({ kind: 'work', text: 'Ship the export.', repo: 'Example/project' })
  assert.equal(root.status, 201)
  const { rid, state } = root.json()
  assert.match(rid, /^ui-/)
  assert.deepEqual(state, { status: 'open' })
  const stored = await host.posted(rid)
  assert.equal(stored.channel, 'work')
  assert.deepEqual(stored.labels, { rid, by: 'user', repo: 'Example/project', status: 'open' })

  const todo = (await host.write({ kind: 'todo', text: 'Review the handoff.' })).json()
  assert.equal((await host.posted(todo.rid)).channel, 'todos')
  assert.deepEqual((await host.posted(todo.rid)).labels, { rid: todo.rid, by: 'user', status: 'open' })

  for (const extra of [{ by: 'laptop-claude' }, { rid: 'chosen' }, { labels: { by: 'agent' } }, { status: 'done' }]) {
    assert.equal((await host.write({ kind: 'todo', text: 'Review.', ...extra })).status, 400, JSON.stringify(extra))
  }
  assert.equal((await host.write({ kind: 'todo', text: 'Review.', repo: 'stranger/project' })).json().refused, 'repo')
  assert.equal((await host.messages('todos')).length, 1)
})

test('A UI reply sets ask=answered and turn; Resolve sets status=done, and a later reply reopens the thread', async (t) => {
  const host = await startHost(t)
  await host.submit({ ...agent, rid: 'work-1', kind: 'work', channel: 'work', text: 'Goal.', repo: 'example/project' })
  await host.submit({ ...agent, rid: 'note-1', root: 'work-1', kind: 'note', text: 'Started.' })
  await host.submit({ ...agent, rid: 'ask-1', root: 'work-1', kind: 'ask', text: 'Which port?', block: 1 })
  await host.writer.pass()
  assert.deepEqual((await host.posted('work-1')).labels.ask, 'open')

  // `re` must name a question in this thread.
  assert.equal((await host.write({ kind: 'answer', root: 'work-1', re: 'note-1', text: '8443.' })).json().refused, 're')
  assert.equal((await host.write({ kind: 'answer', root: 'work-1', re: 'missing', text: '8443.' })).json().refused, 're')

  const answer = await host.write({ kind: 'answer', root: 'work-1', re: 'ask-1', text: '8443.' })
  assert.equal(answer.status, 201)
  const answerRid = answer.json().rid
  const answered = { rid: 'work-1', by: 'laptop-claude', repo: 'example/project', status: 'blocked', ask: 'answered', turn: answerRid }
  assert.deepEqual(answer.json().state, { status: 'blocked', ask: 'answered', turn: answerRid })
  assert.deepEqual((await host.posted('work-1')).labels, answered)
  assert.deepEqual((await host.posted(answerRid)).labels, { rid: answerRid, by: 'user', kind: 'answer', re: 'ask-1' })

  const done = await host.write({ kind: 'done', root: 'work-1' })
  assert.equal(done.status, 201)
  const resolved = await host.posted(done.json().rid)
  assert.equal(resolved.text, 'Resolved.')
  assert.deepEqual(resolved.labels, { rid: done.json().rid, by: 'user', kind: 'done' })
  assert.deepEqual((await host.posted('work-1')).labels, { rid: 'work-1', by: 'laptop-claude', repo: 'example/project', status: 'done' })

  const reopen = await host.write({ kind: 'answer', root: 'work-1', text: 'One more thing.' })
  assert.deepEqual(reopen.json().state, { status: 'open', ask: 'answered', turn: reopen.json().rid })
  assert.deepEqual((await host.posted(reopen.json().rid)).labels, { rid: reopen.json().rid, by: 'user', kind: 'answer' })

  // A todo resolves from the UI; answers go to work items only, and never to a reply.
  const todo = (await host.write({ kind: 'todo', text: 'Review the handoff.' })).json().rid
  assert.equal((await host.write({ kind: 'answer', root: todo, text: 'Hi.' })).json().refused, 'root')
  assert.equal((await host.write({ kind: 'answer', root: 'ask-1', text: 'Hi.' })).json().refused, 'root')
  assert.equal((await host.write({ kind: 'done', root: 'missing' })).status, 404)
  assert.deepEqual((await host.write({ kind: 'done', root: todo })).json().state, { status: 'done' })
})

test('The read endpoints give Needs you, channels, open or resolved threads, and one thread', async (t) => {
  const host = await startHost(t)
  await host.submit({ ...agent, rid: 'work-1', kind: 'work', channel: 'work', text: 'Asks.', repo: 'example/one' })
  await host.submit({ ...agent, rid: 'ask-1', root: 'work-1', kind: 'ask', text: 'Which port?' })
  await host.submit({ ...agent, rid: 'work-2', kind: 'work', channel: 'work', text: 'Answered.', repo: 'example/two' })
  await host.submit({ ...agent, rid: 'todo-1', kind: 'todo', channel: 'todos', text: 'Global todo.' })
  await host.writer.pass()
  await host.write({ kind: 'answer', root: 'work-2', text: 'Go ahead.' })
  const done = (await host.write({ kind: 'todo', text: 'Resolved todo.', repo: 'example/one' })).json().rid
  await host.write({ kind: 'done', root: done })

  const rids = (threads: Thread[]) => threads.map(({ message }) => message.labels.rid).sort()
  const needsYou = (await host.call('/api/ui/needs-you')).json<{ open: Thread[]; answered: Thread[] }>()
  assert.deepEqual(rids(needsYou.open), ['work-1'])
  assert.deepEqual(rids(needsYou.answered), ['work-2'])
  assert.deepEqual((await host.call('/api/ui/channels')).json<unknown>(), { repos: ['example/one', 'example/two'] })

  const list = async (query: string) => rids((await host.call(`/api/ui/threads?${query}`)).json<{ threads: Thread[] }>().threads)
  assert.deepEqual(await list('channel=todos'), ['todo-1'])
  assert.deepEqual(await list('channel=todos&resolved=1'), [done])
  assert.deepEqual(await list('channel=work&repo=example/one'), ['work-1'])
  assert.equal((await host.call('/api/ui/threads?channel=inbox')).status, 400)

  const thread = (await host.call('/api/ui/thread?rid=work-1')).json<{ root: MessageView; replies: MessageView[] }>()
  assert.equal(thread.root.labels.rid, 'work-1')
  assert.deepEqual(thread.replies.map(({ labels }) => labels.rid), ['ask-1'])
  assert.equal((await host.call('/api/ui/thread?rid=ask-1')).status, 404)
  assert.equal((await host.call('/api/ui/thread?rid=app')).status, 404, 'the inbox marker is not a thread')
  assert.equal((await host.call('/api/ui/needs-you', { method: 'POST', body: {} })).status, 405)
  assert.equal((await host.call('/api/ui/other')).status, 404)
})

test('Writes serialize with pass(): a UI write never runs while an ingest pass is on the board', async (t) => {
  const log: string[] = []
  let handles = 0
  let hold: ReturnType<typeof deferred> | null = null
  const passHeld = deferred()
  const uiCalled = deferred()
  /** A board whose calls are logged by handle; the first `schedules` call of a pass waits on `hold`. */
  const openBoard = (): Board => {
    const handle = board()
    const tag = `board-${++handles}`
    const watch = <A extends unknown[], R>(name: string, call: (...args: A) => Promise<R>) => async (...args: A) => {
      log.push(tag)
      if (tag !== 'board-1') uiCalled.resolve()
      if (name === 'schedules' && hold) {
        passHeld.resolve()
        await hold.promise
      }
      return call(...args)
    }
    return {
      ...handle,
      post: watch('post', handle.post) as Board['post'],
      reply: watch('reply', handle.reply) as Board['reply'],
      posted: watch('posted', handle.posted),
      thread: watch('thread', handle.thread) as Board['thread'],
      label: watch('label', handle.label),
      schedules: watch('schedules', handle.schedules),
    }
  }
  const host = await startHost(t, { openBoard })
  await host.submit({ ...agent, rid: 'work-1', kind: 'work', channel: 'work', text: 'Goal.' })

  hold = deferred()
  const pass = host.writer.pass()
  await passHeld.promise
  const write = host.write({ kind: 'todo', text: 'Written during a pass.' })
  // The UI write has had time to reach the board, had nothing kept it waiting.
  const raced = await Promise.race([uiCalled.promise.then(() => 'interleaved'), delay(500).then(() => 'waited')])
  assert.equal(raced, 'waited')
  hold.resolve()
  await pass
  assert.equal((await write).status, 201)

  const runs = log.filter((tag, index) => tag !== log[index - 1])
  assert.deepEqual(runs, ['board-1', 'board-2'], 'each handle\'s calls are one run: the pass, then the UI write')
  assert.ok((await host.messages('work')).length === 1 && (await host.messages('todos')).length === 1)
})
