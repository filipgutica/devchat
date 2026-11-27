import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { board, BoardError, type Board, type MessageView } from '@vercel/board'
import { setupBoard } from '../src/host/grants.ts'
import { createApp } from '../src/server/app.ts'
import { guardReason } from '../src/server/guard.ts'
import { createStateWriter } from '../src/server/writer.ts'
import type { Intent } from '../src/shared/layout.ts'
import { sha256, withoutDigest } from './digest.ts'
import { startBoardServer } from '../src/testing/index.ts'

type Labels = Record<string, string>
type Headers = Record<string, string | string[] | undefined>
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
/** A new rid in the UI namespace, as the browser makes one per write. */
const uiRid = () => `ui-${randomUUID()}`
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
async function startHost(t: TestContext, {
  withGuard = true, openBoard = () => board(), readBoard = () => board(), httpsPort = settings.httpsPort,
} = {}) {
  const server = await startBoardServer()
  t.after(server.stop)
  process.env.BOARD_URL = server.url
  process.env.XDG_CONFIG_HOME = server.configHome
  await setupBoard(board(), settings.login, () => {})
  const dir = await mkdtemp(join(tmpdir(), 'devchat-ui-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const writer = createStateWriter({ settings: { allowlist: ['example'], machines: {} }, stateFile: join(dir, 'app-state.json'), openBoard })
  const app = createApp({ version: '0.0.0', openBoard: readBoard, ui: { settings: { ...settings, httpsPort }, guard: withGuard ? guardReason : undefined, writer } })
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  t.after(() => app.close())
  const port = (app.address() as AddressInfo).port
  const owner = board()

  /** An HTTP call to the app; `node:http`, because `fetch` cannot set `Host`. */
  const call = (path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Headers; body?: unknown } = {}) => {
    // Raw header lines, so a test can send one header twice.
    const sent = Object.entries({ ...browser, ...headers }).flatMap(([name, value]) => [value ?? []].flat().flatMap((one) => [name, one]))
    return new Promise<{ status: number | undefined; json: <T = WriteBody>() => T }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method, headers: sent }, (res) => {
        let text = ''
        res.setEncoding('utf8').on('data', (chunk: string) => { text += chunk }).on('end', () => resolve({ status: res.statusCode, json: <T>() => JSON.parse(text) as T }))
      })
      req.on('error', reject)
      req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
    })
  }
  /** A UI write; an object body without a `rid` gets a new one. */
  const write = (body: unknown, headers: Headers = {}) => call('/api/ui/posts', {
    method: 'POST', headers, body: typeof body === 'object' && body !== null && !('rid' in body) ? { rid: uiRid(), ...body } : body,
  })
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
  /** The app's post for `rid` without its `digest`, which tests check on their own. */
  const posted = async (rid: string) => withoutDigest(await owner.posted(`app:${rid}`))
  return { owner, writer, call, write, submit, messages, posted }
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
    ['Host with another port', host.write(todo, { Host: 'devchat.example.test:443' }), 403],
    ['another host on the port', host.write(todo, { Host: 'other.example.test:8443' }), 403],
    ['Host in other case', host.write(todo, { Host: 'DEVCHAT.example.test:8443' }), 403],
    ['Host sent twice', host.write(todo, { Host: ['devchat.example.test:8443', 'devchat.example.test:8443'] }), 403],
    ['Origin with the default port', host.write(todo, { Origin: 'https://devchat.example.test' }), 403],
    ['cross-site request', host.write(todo, { 'Sec-Fetch-Site': 'cross-site' }), 403],
    ['same-site request', host.write(todo, { 'Sec-Fetch-Site': 'same-site' }), 403],
    ['no Sec-Fetch-Site', host.write(todo, { 'Sec-Fetch-Site': undefined }), 403],
    ['other Origin', host.write(todo, { Origin: 'https://evil.example.test' }), 403],
    ['no Origin', host.write(todo, { Origin: undefined }), 403],
    ['form post', host.write('kind=todo&text=x', { 'Content-Type': 'application/x-www-form-urlencoded' }), 415],
    ['PUT', host.call('/api/ui/posts', { method: 'PUT', body: todo }), 405],
    ['GET', host.call('/api/ui/posts'), 405],
    ['guarded text', host.write({ kind: 'todo', text: 'api_key=<secret>' }), 422],
    ['a credential in repo', host.write({ kind: 'todo', text: 'Review the handoff.', repo: 'example/ghp_abcdefghijklmnopqrstuvwx' }), 422],
    ['repo not a GitHub name', host.write({ kind: 'todo', text: 'Review the handoff.', repo: 'example/api_key=x' }), 400],
    ['repo named ..', host.write({ kind: 'todo', text: 'Review the handoff.', repo: 'example/..' }), 400],
    ['owner over 39 characters', host.write({ kind: 'todo', text: 'Review the handoff.', repo: `${'e'.repeat(40)}/project` }), 400],
    ['owner with an edge hyphen', host.write({ kind: 'todo', text: 'Review the handoff.', repo: 'example-/project' }), 400],
    ['repo over 100 characters', host.write({ kind: 'todo', text: 'Review the handoff.', repo: `example/${'p'.repeat(101)}` }), 400],
    ['rid outside the UI namespace', host.write({ ...todo, rid: 'work-9' }), 400],
    ['guarded reply text', host.write({ kind: 'answer', root: 'work-1', text: 'Check /home/someone/notes.txt' }), 422],
    ['a read with a wrong login', host.call('/api/ui/needs-you', { headers: { 'Tailscale-User-Login': 'other@example.com' } }), 403],
    ['a read with a wrong Host', host.call('/api/ui/needs-you', { headers: { Host: 'localhost' } }), 403],
  ]
  for (const [name, response, status] of cases) assert.equal((await response).status, status, name)
  assert.deepEqual([...await host.messages('todos'), ...await host.messages('work')], [])
  // The same request with the browser's headers goes through.
  assert.equal((await host.write(todo)).status, 201)
})

test('On HTTPS port 443 the route takes the bare Host and Origin, and refuses the explicit :443', async (t) => {
  const host = await startHost(t, { httpsPort: 443 })
  const todo = { kind: 'todo', text: 'Review the handoff.' }
  const bare = { Host: 'devchat.example.test', Origin: 'https://devchat.example.test' }
  assert.equal((await host.write(todo, { ...bare, Host: 'devchat.example.test:443' })).status, 403)
  assert.equal((await host.write(todo, { ...bare, Origin: 'https://devchat.example.test:443' })).status, 403)
  assert.equal((await host.write(todo, { ...bare, Host: 'devchat.example.test:8443' })).status, 403)
  assert.equal((await host.write(todo)).status, 403, 'the :8443 headers of another install')
  assert.deepEqual(await host.messages('todos'), [])
  assert.equal((await host.write(todo, bare)).status, 201)
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

test('A UI post carries by=user and the browser\'s UI rid; no request field sets by, labels, or status', async (t) => {
  // That no intent yields by=user: writer.test.ts, "Ingest: kind=answer, by=user, …".
  const host = await startHost(t)
  const root = await host.write({ kind: 'work', text: 'Ship the export.', repo: 'Example/project' })
  assert.equal(root.status, 201)
  const { rid, state } = root.json()
  assert.match(rid, /^ui-[0-9a-f-]{36}$/)
  assert.deepEqual(state, { status: 'open' })
  const stored = await host.posted(rid)
  assert.equal(stored.channel, 'work')
  assert.deepEqual(stored.labels, { rid, by: 'user', repo: 'Example/project', status: 'open' })

  const todo = (await host.write({ kind: 'todo', text: 'Review the handoff.' })).json()
  assert.equal((await host.posted(todo.rid)).channel, 'todos')
  assert.deepEqual((await host.posted(todo.rid)).labels, { rid: todo.rid, by: 'user', status: 'open' })

  for (const extra of [{ by: 'laptop-claude' }, { rid: 'chosen' }, { rid: uiRid().toUpperCase() }, { labels: { by: 'agent' } }, { status: 'done' }]) {
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
  // Answering a blocking question moves the item from the first Needs you list to the second.
  const needsYou = (await host.call('/api/ui/needs-you')).json<{ open: Thread[]; answered: Thread[] }>()
  assert.deepEqual([needsYou.open.length, needsYou.answered.map(({ message }) => message.labels.rid)], [0, ['work-1']])

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

test('A root without status is open: the open list shows it and pages to the end', async (t) => {
  const host = await startHost(t)
  // Roots as a crash between the post and its fold leaves them: no `status` yet.
  const open = Array.from({ length: 105 }, (_, index) => `raw-${index}`)
  for (const rid of open) await host.owner.post('todos', { id: `app:${rid}`, text: `Todo ${rid}.`, labels: { rid, by: 'user' } })
  const done = (await host.write({ kind: 'todo', text: 'Resolved todo.' })).json().rid
  await host.write({ kind: 'done', root: done })

  const listed: string[] = []
  const pages: number[] = []
  for (let before: string | null = null; ;) {
    const page: { threads: Thread[]; older: string | null } = (await host.call(`/api/ui/threads?channel=todos${before ? `&before=${encodeURIComponent(before)}` : ''}`))
      .json()
    pages.push(page.threads.length)
    listed.push(...page.threads.map(({ message }) => message.labels.rid ?? ''))
    if (page.older === null) break
    before = page.older
  }
  assert.deepEqual(listed.sort(), [...open].sort())
  // Every page but the last holds a full page of open threads, though a resolved one sits among them.
  assert.ok(pages.length >= 2 && pages.slice(0, -1).every((count) => count >= 50), `pages: ${pages.join(', ')}`)
})

test('A retried UI write replays: the same rid and body answer 200 with one post; another body answers 409', async (t) => {
  const host = await startHost(t)
  const body = { rid: uiRid(), kind: 'todo', text: 'Review the handoff.', repo: 'example/project' }
  const first = await host.write(body)
  assert.equal(first.status, 201)
  const retry = await host.write(body)
  assert.equal(retry.status, 200)
  assert.deepEqual(retry.json(), first.json())
  assert.deepEqual((await host.messages('todos')).map(({ labels }) => labels.rid), [body.rid])

  for (const other of [{ text: 'Another text.' }, { repo: 'example/other' }, { kind: 'work' }]) {
    const response = await host.write({ ...body, ...other })
    assert.deepEqual([response.status, response.json().refused], [409, 'conflict'], JSON.stringify(other))
  }
  const done = { rid: uiRid(), kind: 'done', root: body.rid }
  assert.equal((await host.write(done)).status, 201)
  assert.equal((await host.write({ ...done, kind: 'answer', text: 'Hi.' })).status, 404, 'an answer never goes under a todo')
  assert.equal((await host.write({ rid: done.rid, kind: 'todo', text: 'Resolved.' })).status, 409)
  assert.equal((await host.messages('todos')).length, 2)
  assert.equal((await host.messages('work')).length, 0)

  // A retry repairs a write that stopped after its post: the replay folds the thread.
  const crashed = uiRid()
  await host.owner.post('work', { id: `app:${crashed}`, text: 'A goal.', labels: { rid: crashed, by: 'user', digest: sha256('A goal.') } })
  const repaired = await host.write({ rid: crashed, kind: 'work', text: 'A goal.' })
  assert.deepEqual([repaired.status, repaired.json().state], [200, { status: 'open' }])
  assert.equal((await host.posted(crashed)).labels.status, 'open')
})

test('Ingest refuses an intent whose rid is in the UI namespace, so no agent claims a UI rid', async (t) => {
  const host = await startHost(t)
  for (const rid of [uiRid(), 'UI-claimed', 'ui-x']) {
    await host.submit({ ...agent, rid, kind: 'todo', channel: 'todos', text: 'Claimed.' })
  }
  await host.writer.pass()
  assert.deepEqual((await host.messages('inbox')).filter(({ labels }) => labels.rid === undefined && !labels.applied).map(({ labels }) => labels.refused),
    ['rid', 'rid', 'rid'])
  assert.deepEqual(await host.messages('todos'), [])
})

test('Ingest replays an agent intent with a ui- rid whose canonical post it already wrote, and refuses one that names a UI post', async (t) => {
  const host = await startHost(t)
  // An intent applied before the reservation, or before a crash moved `applied`: its canonical post exists.
  const legacy = { ...agent, rid: 'ui-legacy', kind: 'todo', channel: 'todos', text: 'Written before a crash.' } as const
  await host.owner.post('todos', { id: 'app:ui-legacy', text: legacy.text, labels: { rid: legacy.rid, by: legacy.by, digest: sha256(legacy.text) } })
  await host.submit(legacy)
  // A UI post, then an agent intent that reuses its rid.
  const ui = (await host.write({ kind: 'todo', text: 'From the UI.' })).json().rid
  await host.submit({ ...agent, rid: ui, kind: 'todo', channel: 'todos', text: 'From the UI.' })
  await host.writer.pass()

  const refused = (await host.messages('inbox')).filter(({ labels }) => labels.rid === undefined && !labels.applied)
    .map(({ text, labels }) => [JSON.parse(text).rid, labels.refused ?? null])
  assert.deepEqual(refused, [['ui-legacy', null], [ui, 'rid']])
  assert.deepEqual((await host.posted('ui-legacy')).labels, { rid: 'ui-legacy', by: 'laptop-claude', status: 'open' })
  assert.deepEqual((await host.posted(ui)).labels, { rid: ui, by: 'user', status: 'open' })
  assert.equal((await host.messages('todos')).length, 2)
})

test('A deleted root leaves every list and its thread read', async (t) => {
  const host = await startHost(t)
  const kept = (await host.write({ kind: 'todo', text: 'Kept.', repo: 'example/kept' })).json().rid
  const gone = (await host.write({ kind: 'todo', text: 'Deleted.', repo: 'example/gone' })).json().rid
  const resolved = (await host.write({ kind: 'todo', text: 'Resolved, then deleted.' })).json().rid
  await host.write({ kind: 'done', root: resolved })
  for (const rid of [gone, resolved]) await host.owner.delete((await host.posted(rid)).id)

  const list = async (query: string) => (await host.call(`/api/ui/threads?${query}`)).json<{ threads: Thread[] }>().threads.map(({ message }) => message.id)
  assert.deepEqual(await list('channel=todos'), [(await host.posted(kept)).id])
  assert.deepEqual(await list('channel=todos&resolved=1'), [])
  assert.deepEqual((await host.call('/api/ui/channels')).json<unknown>(), { repos: ['example/kept'] })
  assert.equal((await host.call(`/api/ui/thread?rid=${gone}`)).status, 404)
})

/**
 * A read board that runs a write once, just before its first `ask=answered` threads read or its
 * first thread read: a change that lands between two reads of one request.
 */
function racingBoard() {
  let pending: { method: 'threads' | 'thread'; run: () => Promise<unknown> } | null = null
  const before = async (method: 'threads' | 'thread', matches: boolean) => {
    if (pending?.method !== method || !matches) return
    const { run } = pending
    pending = null
    await run()
  }
  const openBoard = (): Board => {
    const handle = board()
    return {
      ...handle,
      threads: (async (query: Parameters<Board['threads']>[0]) => {
        await before('threads', Array.isArray(query?.label) && query.label.includes('ask=answered'))
        return handle.threads(query)
      }) as Board['threads'],
      thread: (async (...args: Parameters<Board['thread']>) => {
        await before('thread', true)
        return handle.thread(...args)
      }) as Board['thread'],
    }
  }
  return {
    openBoard,
    beforeAnsweredRead: (run: () => Promise<unknown>) => { pending = { method: 'threads', run } },
    beforeThreadRead: (run: () => Promise<unknown>) => { pending = { method: 'thread', run } },
    ran: () => pending === null,
  }
}

/** A work item with a blocking question, through ingest. */
async function blockedItem(host: Awaited<ReturnType<typeof startHost>>) {
  await host.submit({ ...agent, rid: 'work-1', kind: 'work', channel: 'work', text: 'Goal.' })
  await host.submit({ ...agent, rid: 'ask-1', root: 'work-1', kind: 'ask', text: 'Which port?', block: 1 })
  await host.writer.pass()
}

const needsYouRids = async (host: Awaited<ReturnType<typeof startHost>>) => {
  const { open, answered } = (await host.call('/api/ui/needs-you')).json<{ open: Thread[]; answered: Thread[] }>()
  return [open.map(({ message }) => message.labels.rid), answered.map(({ message }) => message.labels.rid)]
}

test('A thread answered between the two Needs you reads shows only under answered', async (t) => {
  const race = racingBoard()
  const host = await startHost(t, { readBoard: race.openBoard })
  await blockedItem(host)
  race.beforeAnsweredRead(() => host.write({ kind: 'answer', root: 'work-1', re: 'ask-1', text: '8443.' }))
  assert.deepEqual(await needsYouRids(host), [[], ['work-1']])
  assert.ok(race.ran(), 'the answer landed between the reads')
})

test('An answered blocked item resolved between the two Needs you reads shows in neither list', async (t) => {
  const race = racingBoard()
  const host = await startHost(t, { readBoard: race.openBoard })
  await blockedItem(host)
  await host.write({ kind: 'answer', root: 'work-1', re: 'ask-1', text: '8443.' })
  race.beforeAnsweredRead(() => host.write({ kind: 'done', root: 'work-1' }))
  assert.deepEqual(await needsYouRids(host), [[], []])
  assert.ok(race.ran(), 'the resolve landed between the reads')
})

test('A root deleted between its lookup and its thread read answers 404', async (t) => {
  const race = racingBoard()
  const host = await startHost(t, { readBoard: race.openBoard })
  const rid = (await host.write({ kind: 'todo', text: 'Deleted while read.' })).json().rid
  race.beforeThreadRead(async () => host.owner.delete((await host.posted(rid)).id))
  assert.equal((await host.call(`/api/ui/thread?rid=${rid}`)).status, 404)
  assert.ok(race.ran(), 'the delete landed between the reads')
})

test('A Board error on the UI post: duplicate_id answers 409 conflict with a JSON body; a 5xx answers 500 and writes nothing', async (t) => {
  const failure: { id: string; error: BoardError } = { id: '', error: new BoardError('duplicate_id', 'stubbed collision', 409) }
  /** The writer's board: the post with client ID `failure.id` fails with `failure.error`. */
  const openBoard = (): Board => {
    const handle = board()
    const fail = (input: string | { id?: string }) => typeof input !== 'string' && input.id === failure.id
    return { ...handle, post: (channel, input) => (fail(input) ? Promise.reject(failure.error) : handle.post(channel, input)) }
  }
  const host = await startHost(t, { openBoard })
  const rid = uiRid()
  failure.id = `app:${rid}`
  const taken = await host.write({ rid, kind: 'todo', text: 'Another author holds this ID.' })
  assert.deepEqual([taken.status, taken.json().refused], [409, 'conflict'])

  failure.error = new BoardError('unavailable', 'stubbed outage', 503)
  assert.equal((await host.write({ rid, kind: 'todo', text: 'Board is down.' })).status, 500)
  assert.deepEqual(await host.messages('todos'), [])
})

test('A UI retry of a post with an @handle replays with 200, though Board stored the mention resolved', async (t) => {
  const host = await startHost(t)
  // The tailnet login's first post makes it a Board actor with the handle `user`.
  await host.submit({ ...agent, rid: 'work-1', kind: 'work', channel: 'work', text: 'Goal.' })
  await host.writer.pass()
  const body = { rid: uiRid(), kind: 'todo', text: 'Review with @user.' }
  assert.equal((await host.write(body)).status, 201)
  const stored = await host.owner.posted(`app:${body.rid}`)
  assert.notEqual(stored.text, body.text, 'Board resolved the mention')
  assert.equal(stored.labels.digest, sha256(body.text))

  const retry = await host.write(body)
  assert.deepEqual([retry.status, retry.json().rid], [200, body.rid])
  assert.equal((await host.write({ ...body, text: 'Review with @user later.' })).status, 409)
  // The answer under that thread too.
  const answer = { rid: uiRid(), kind: 'answer', root: 'work-1', text: 'Ask @user first.' }
  assert.equal((await host.write(answer)).status, 201)
  assert.equal((await host.write(answer)).status, 200)
  assert.equal((await host.messages('todos')).length, 1)
  assert.equal((await host.messages('work')).length, 2)
})

test('No UI write sets the digest label', async (t) => {
  const host = await startHost(t)
  const forged = await host.write({ kind: 'todo', text: 'Review.', digest: sha256('Another text.') })
  assert.equal(forged.status, 400)
  assert.deepEqual(await host.messages('todos'), [])
})

test('Search finds open and resolved threads in todos and work by their root or a reply, and nothing in other channels', async (t) => {
  const host = await startHost(t)
  await host.submit({ ...agent, rid: 'work-1', kind: 'work', channel: 'work', text: 'Ship the parrot exporter.', repo: 'example/one' })
  await host.submit({ ...agent, rid: 'note-1', root: 'work-1', kind: 'note', text: 'The walrus step is slow.' })
  await host.submit({ ...agent, rid: 'todo-1', kind: 'todo', channel: 'todos', text: 'Feed the parrot.' })
  await host.writer.pass()
  await host.write({ kind: 'done', root: 'todo-1' })
  // Words that sit only in an intent's JSON in inbox, or in another channel, never come back.
  await host.submit({ ...agent, rid: 'todo-bad', kind: 'todo', channel: 'todos', text: 'Pelican.', repo: 'other/one' })
  await host.writer.pass()
  await host.owner.post('msg', { text: 'A pelican message.' })

  type Found = { threads: Thread[] }
  const search = async (query: string) => {
    const response = await host.call(`/api/ui/search?${query}`)
    assert.equal(response.status, 200, query)
    return response.json<Found>().threads.map(({ message }) => message.labels.rid).sort()
  }
  assert.deepEqual(await search('q=parrot'), ['todo-1', 'work-1'], 'a resolved todo and an open work item')
  assert.deepEqual(await search('q=walrus'), ['work-1'], 'a match in a reply')
  assert.deepEqual(await search('q=parrot&channel=todos'), ['todo-1'])
  assert.deepEqual(await search('q=pelican'), [])
  assert.deepEqual(await search('q=todo-bad'), [])
  assert.deepEqual(await search(`q=${encodeURIComponent('"parrot*) OR (')}`), [], 'search syntax is plain text')

  for (const [query, status] of [['q=', 400], [`q=${'x'.repeat(201)}`, 400], ['q=parrot&channel=inbox', 400], ['q=parrot&channel=msg', 400]] as const) {
    assert.equal((await host.call(`/api/ui/search?${query}`)).status, status, query)
  }
  assert.equal((await host.call('/api/ui/search?q=parrot', { headers: { 'Tailscale-User-Login': 'other@example.com' } })).status, 403)
  assert.equal((await host.call('/api/ui/search?q=parrot', { headers: { Host: 'localhost' } })).status, 403)
})
