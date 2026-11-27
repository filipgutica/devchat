import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { test, type TestContext } from 'node:test'
import { board, BoardError, type Board, type MessageView } from '@vercel/board'
import { setupBoard } from '../src/host/grants.ts'
import { createApp } from '../src/server/app.ts'
import { foldState, isStateLabel } from '../src/server/fold.ts'
import { createStateWriter } from '../src/server/writer.ts'
import { appMarker, boardMarker, type Intent } from '../src/shared/layout.ts'
import { startBoardServer } from '../src/testing/index.ts'
import { foldFixture } from './fold-fixture.ts'

type Labels = Record<string, string>
type WriteCall = { method: 'post' | 'reply' | 'label'; id: string | undefined }

/**
 * A real `vb serve` with devchat's grants and board marker, a state writer for it, and the agent's
 * and user's sides: agents post intents in `inbox` as the tailnet login; `userReply` stands in for
 * the UI route (D4), which writes `by=user` posts as the owner.
 */
async function startHost(t: TestContext, { machines = {} }: { machines?: Labels } = {}) {
  const server = await startBoardServer()
  t.after(server.stop)
  process.env.BOARD_URL = server.url
  process.env.XDG_CONFIG_HOME = server.configHome
  await setupBoard(board(), 'user@example.com', () => {})
  const dir = await mkdtemp(join(tmpdir(), 'devchat-writer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'app-state.json')
  const settings = { allowlist: ['Example'], machines }
  const owner = board()

  /** A writer, as a fresh app process would run it; `crash` decides, after each write, whether the process dies there. */
  const writer = (crash?: (call: WriteCall) => boolean) => createStateWriter({
    settings,
    stateFile,
    ...(crash ? { openBoard: () => crashing(board(), crash) } : {}),
  })
  const submit = async (intent: object | string, id?: string) => {
    const text = typeof intent === 'string' ? intent : JSON.stringify(intent)
    const clientId = id ?? (typeof intent === 'object' && 'rid' in intent ? String(intent.rid) : undefined)
    const response = await server.tailnet.request('/messages', { method: 'POST', body: { channel: 'inbox', text, ...(clientId ? { id: clientId } : {}) } })
    assert.equal(response.status, 201, response.body)
    return (JSON.parse(response.body) as { message: { id: string } }).message.id
  }
  const canonical = async (rid: string) => {
    try {
      return await owner.posted(`app:${rid}`)
    } catch (error) {
      if (error instanceof BoardError && error.code === 'post_not_found') return null
      throw error
    }
  }
  const rootLabels = async (rid: string) => (await owner.posted(`app:${rid}`)).labels
  const userReply = async (root: string, labels: Labels, text = 'From the user.') => {
    const target = await owner.posted(`app:${root}`)
    await owner.reply(target.id, { id: `app:${labels.rid}`, text, labels: { by: 'user', kind: 'answer', ...labels } })
  }
  const messages = async (channel: string) => {
    const all: MessageView[] = []
    for (let page = await owner.channel(channel).messages({ after: '0' }); page.messages.length > 0;
      page = await owner.channel(channel).messages({ after: page.cursor })) all.push(...page.messages)
    return all
  }
  const applied = async () => (await owner.posted(appMarker.id)).labels.applied
  return { server, owner, stateFile, writer, submit, canonical, rootLabels, userReply, messages, applied }
}

/** Board whose canonical post or reply with client ID `id` fails with `error` before it is written. */
function failing(handle: Board, id: string, error: BoardError): Board {
  const fail = (input: string | { id?: string }) => typeof input !== 'string' && input.id === id
  return {
    ...handle,
    post: (channel, input) => (fail(input) ? Promise.reject(error) : handle.post(channel, input)),
    reply: (target, input) => (fail(input) ? Promise.reject(error) : handle.reply(target, input)),
  }
}

/** Board with every `post`, `reply`, and `label` counted; `crash` true after a write throws, as a process dying right after it. */
function crashing(handle: Board, crash: (call: WriteCall) => boolean): Board {
  const after = async <T>(call: WriteCall, write: Promise<T>) => {
    const result = await write
    if (crash(call)) throw new Error(`crash after ${call.method} ${call.id ?? ''}`)
    return result
  }
  return {
    ...handle,
    post: (channel, input) => after({ method: 'post', id: typeof input === 'string' ? undefined : input.id }, handle.post(channel, input)),
    reply: (id, input) => after({ method: 'reply', id: typeof input === 'string' ? undefined : input.id }, handle.reply(id, input)),
    label: (id, change) => after({ method: 'label', id }, handle.label(id, change)),
  }
}

const base = { v: 1, by: 'laptop-claude' } as const
const work = (rid: string, extra: object = {}) => ({ ...base, rid, kind: 'work', channel: 'work', text: `Goal ${rid}.`, repo: 'example/project', ...extra })

/** The intent an agent sends for a fixture post: the fixture is the canonical post it yields. */
function intentFor(channel: 'todos' | 'work', { text, labels }: { text: string; labels: Labels }, root: string): Intent {
  const { rid, by, re, kind, block, repo } = labels
  assert.ok(rid && by)
  const pr = Object.entries(labels).find(([key]) => key.startsWith('pr.'))?.[1]
  const reply = { v: 1 as const, rid, by, root, ...(re ? { re } : {}) }
  switch (kind) {
    case undefined: return channel === 'work'
      ? { v: 1, rid, by, kind: 'work', channel, text, ...(repo ? { repo } : {}) }
      : { v: 1, rid, by, kind: 'todo', channel, text, ...(repo ? { repo } : {}) }
    case 'note': return { ...reply, kind, text, ...(pr ? { pr } : {}) }
    case 'ask': return { ...reply, kind, text, ...(block === '1' ? { block: 1 } : {}) }
    case 'done': case 'drop': return { ...reply, kind, text: '' }
    default: throw new Error(`no intent yields kind=${kind}`)
  }
}

for (const { name, channel, steps } of foldFixture) {
  test(`state writer: ${name}, each post through ingest (fixtures/fold.json: every §2 row but reaction and queue, the pending guard, a user reply sets ask=answered and turn, a reply reopens, an ask without block on a blocked item sets status=open)`, async (t) => {
    const host = await startHost(t)
    const writer = host.writer()
    const rootRid = steps[0]?.post.labels.rid
    assert.ok(rootRid)
    for (const [index, { post, rootLabels }] of steps.entries()) {
      if (post.labels.by === 'user') await host.userReply(rootRid, post.labels, post.text)
      else await host.submit(intentFor(channel, post, rootRid))
      await writer.pass()
      assert.deepEqual(await host.rootLabels(rootRid), rootLabels, `after step ${index + 1} (${post.labels.kind ?? 'root'}`
        + ` by ${post.labels.by}${post.labels.block ? ', block' : ''}${post.labels.re ? `, re=${post.labels.re}` : ''}): ${post.text}`)
      // Every post is stored as the fixture has it, also one the pending guard keeps from changing the root.
      const stored = (await host.canonical(post.labels.rid ?? ''))?.labels ?? {}
      assert.deepEqual(index === 0 ? Object.fromEntries(Object.entries(stored).filter(([key]) => !isStateLabel(key))) : stored, post.labels)
    }
    assert.deepEqual((await host.messages('inbox')).filter(({ labels }) => labels.refused), [])
  })
}

test('Ingest: kind=answer, by=user, a state field, a non-allowlisted repo, a missing root, and a message-root, queue, or ack intent get refused=<reason> and write nothing', async (t) => {
  const host = await startHost(t)
  const writer = host.writer()
  await host.submit(work('work-1'))
  await host.submit({ ...base, rid: 'note-1', kind: 'note', root: 'work-1', text: 'A note.' })
  // A user message root, as the UI route (D4) writes it.
  await host.owner.post('msg', { id: 'app:msg-1', text: 'For the coordinator.', labels: { rid: 'msg-1', by: 'user' } })
  await writer.pass()
  const before = { work: (await host.messages('work')).length, todos: (await host.messages('todos')).length, msg: (await host.messages('msg')).length }

  const refusals: [string, object | string][] = [
    ['invalid', { ...base, rid: 'r-answer', kind: 'answer', root: 'work-1', text: 'Yes.' }],
    ['invalid', { ...base, rid: 'r-user', kind: 'note', root: 'work-1', text: 'Hi.', by: 'user' }],
    ['invalid', { ...work('r-status'), status: 'done' }],
    ['invalid', { ...base, rid: 'r-env', kind: 'todo', channel: 'todos', text: 'X.', env: 'e1' }],
    ['repo', work('r-repo', { repo: 'someone-else/project' })],
    ['repo', work('r-repo-shape', { repo: 'example/project/nested' })],
    ['root', { ...base, rid: 'r-missing', kind: 'note', root: 'work-404', text: 'Hi.' }],
    ['root', { ...base, rid: 'r-reply-target', kind: 'note', root: 'note-1', text: 'Hi.' }],
    ['deferred', { ...base, rid: 'r-msg', kind: 'msg', channel: 'msg', text: 'Hi.' }],
    ['deferred', { ...base, rid: 'r-queue', kind: 'queue', root: 'work-1', text: '' }],
    ['deferred', { ...base, rid: 'r-ack', kind: 'ack', root: 'work-1', text: '' }],
    ['pr', { ...base, rid: 'r-pr', kind: 'note', root: 'work-1', text: 'PR.', pr: 'https://example.com/issues/3' }],
    ['profile', { ...base, rid: 'r-profile', kind: 'note', root: 'msg-1', text: 'Picked up.' }],
    ['json', 'not json'],
    ['invalid', `{"v":1,"rid":"r-nul","kind":"todo","channel":"todos","text":"a\\u0000b","by":"laptop-claude"}`],
    ['invalid', `{"v":1,"rid":"r-surrogate","kind":"todo","channel":"todos","text":"a\\ud800b","by":"laptop-claude"}`],
    ['invalid', { ...base, rid: 'r-pr-newline', kind: 'note', root: 'work-1', text: 'PR.', pr: 'https://example.com/pu\nll/1' }],
  ]
  const ids = new Map<string, string>()
  for (const [index, [, intent]] of refusals.entries()) ids.set(String(index), await host.submit(intent, `refused-${index}`))
  // An intent is a root: a reply in inbox is refused too.
  const inboxRoot = ids.get('0')
  assert.ok(inboxRoot)
  const reply = await host.server.tailnet.request(`/messages`, { method: 'POST', body: { re: inboxRoot, text: JSON.stringify(work('r-inbox-reply')) } })
  assert.equal(reply.status, 201, reply.body)
  await writer.pass()

  const inbox = await host.messages('inbox')
  const refusedOf = (id: string | undefined) => inbox.find((message) => message.id === id)?.labels.refused
  for (const [index, [reason, intent]] of refusals.entries()) {
    assert.equal(refusedOf(ids.get(String(index))), reason, JSON.stringify(intent))
    if (typeof intent === 'object' && 'rid' in intent) assert.equal(await host.canonical(String(intent.rid)), null)
  }
  assert.equal(refusedOf((JSON.parse(reply.body) as { message: { id: string } }).message.id), 'reply')
  assert.equal(await host.canonical('r-inbox-reply'), null)
  assert.deepEqual({ work: (await host.messages('work')).length, todos: (await host.messages('todos')).length, msg: (await host.messages('msg')).length }, before)
  assert.equal(await host.applied(), inbox.at(-1)?.id)
})

test('Ingest: an agent resolve without re is refused while a reply is pending, and nothing is written', async (t) => {
  const host = await startHost(t)
  const writer = host.writer()
  await host.submit(work('work-1'))
  await host.submit({ ...base, rid: 'ask-1', kind: 'ask', root: 'work-1', text: 'Proceed?', block: 1 })
  await writer.pass()
  await host.userReply('work-1', { rid: 'answer-1', re: 'ask-1' })
  const without = await host.submit({ ...base, rid: 'done-1', kind: 'done', root: 'work-1', text: '' })
  const stale = await host.submit({ ...base, rid: 'drop-1', kind: 'drop', root: 'work-1', text: '', re: 'ask-1' })
  await writer.pass()

  const inbox = await host.messages('inbox')
  assert.equal(inbox.find(({ id }) => id === without)?.labels.refused, 'pending')
  assert.equal(inbox.find(({ id }) => id === stale)?.labels.refused, 'pending')
  assert.equal(await host.canonical('done-1'), null)
  assert.equal(await host.canonical('drop-1'), null)
  assert.deepEqual(await host.rootLabels('work-1'),
    { rid: 'work-1', by: base.by, repo: 'example/project', status: 'blocked', ask: 'answered', turn: 'answer-1' })

  await host.submit({ ...base, rid: 'done-2', kind: 'done', root: 'work-1', text: '', re: 'answer-1' })
  await writer.pass()
  assert.deepEqual(await host.rootLabels('work-1'), { rid: 'work-1', by: base.by, repo: 'example/project', status: 'done' })
})

test('Ingest reads inbox in log order across pages, and applied names the last inbox post handled', async (t) => {
  const host = await startHost(t)
  const writer = host.writer()
  await writer.pass()
  // A root and its replies in one batch, after more than one page of todos.
  for (let index = 0; index < 55; index += 1) {
    await host.submit({ ...base, rid: `todo-${index}`, kind: 'todo', channel: 'todos', text: `Todo ${index}.` })
  }
  await host.submit(work('work-1'))
  await host.submit({ ...base, rid: 'ask-1', kind: 'ask', root: 'work-1', text: 'Proceed?', block: 1 })
  const last = await host.submit({ ...base, rid: 'note-1', kind: 'note', root: 'work-1', text: 'Proceeding.', pr: 'https://github.com/example/project/pull/7' })
  await writer.pass()

  assert.deepEqual((await host.messages('inbox')).filter(({ labels }) => labels.refused), [])
  assert.equal((await host.messages('todos')).length, 55)
  assert.deepEqual(await host.rootLabels('work-1'),
    { rid: 'work-1', by: base.by, repo: 'example/project', status: 'open', 'pr.7': 'https://github.com/example/project/pull/7' })
  assert.equal(await host.applied(), last)
})

test('Ingest: an intent ingested twice posts once, also from a replay of the whole inbox', async (t) => {
  const host = await startHost(t)
  await host.submit(work('work-1'))
  const note = { ...base, rid: 'note-1', kind: 'note', root: 'work-1', text: 'Once.' }
  await host.submit(note)
  await host.writer().pass()
  // The same intent again under another client ID, then a replay from an older cursor.
  await host.submit(note, 'note-1-again')
  await host.writer().pass()
  await host.owner.label((await host.owner.posted(appMarker.id)).id, { unset: ['applied'] })
  await rm(host.stateFile)
  await host.writer().pass()

  const work1 = await host.owner.posted('app:work-1')
  assert.equal((await host.owner.thread(work1.id)).replies.length, 1)
  assert.equal((await host.messages('work')).length, 2)
  assert.deepEqual((await host.messages('inbox')).filter(({ labels }) => labels.refused), [])
})

test('Ingest: a resolve applied before a crash, with a user reply written before applied moved, is not refused on replay', async (t) => {
  const host = await startHost(t)
  await host.submit(work('work-1'))
  await host.submit({ ...base, rid: 'ask-1', kind: 'ask', root: 'work-1', text: 'Proceed?' })
  await host.writer().pass()
  await host.userReply('work-1', { rid: 'answer-1', re: 'ask-1' })
  const resolve = await host.submit({ ...base, rid: 'done-1', kind: 'done', root: 'work-1', text: '', re: 'answer-1' })
  await assert.rejects(host.writer(({ method, id }) => method === 'reply' && id === 'app:done-1').pass(), /crash/)
  await host.userReply('work-1', { rid: 'answer-2' })

  await host.writer().pass()
  const inbox = await host.messages('inbox')
  assert.equal(inbox.find(({ id }) => id === resolve)?.labels.refused, undefined)
  assert.equal(await host.applied(), resolve)
  assert.deepEqual(await host.rootLabels('work-1'),
    { rid: 'work-1', by: base.by, repo: 'example/project', status: 'open', ask: 'answered', turn: 'answer-2' })
})

test('Ingest: a replay folds the thread of an intent already written before applied passes it', async (t) => {
  const host = await startHost(t)
  await host.submit(work('work-1'))
  await host.writer().pass()
  await host.submit({ ...base, rid: 'ask-1', kind: 'ask', root: 'work-1', text: 'Proceed?', block: 1 })
  // The canonical post is written, its fold is not; then the replay dies right after moving applied.
  await assert.rejects(host.writer(({ method, id }) => method === 'reply' && id === 'app:ask-1').pass(), /crash/)
  const marker = (await host.owner.posted(appMarker.id)).id
  await assert.rejects(host.writer(({ method, id }) => method === 'label' && id === marker).pass(), /crash/)
  await assertAppliedCoversOnlyFolded(host)
  assert.equal((await host.rootLabels('work-1')).status, 'blocked')
})

test('Ingest: a 400 from Board on a canonical post refuses that intent as invalid, and a 409 duplicate_id as rid, and moves on; a 5xx stops the pass and retries it', async (t) => {
  const host = await startHost(t)
  await host.submit(work('work-1'))
  await host.writer().pass()
  const refused = await host.submit({ ...base, rid: 'note-1', kind: 'note', root: 'work-1', text: 'Refused by Board.' })
  await host.submit({ ...base, rid: 'note-2', kind: 'note', root: 'work-1', text: 'Applied.' })
  const badRequest = new BoardError('invalid_request', 'stubbed refusal', 400)
  await createStateWriter({ settings: { allowlist: ['example'], machines: {} }, stateFile: host.stateFile,
    openBoard: () => failing(board(), 'app:note-1', badRequest) }).pass()
  const inbox = await host.messages('inbox')
  assert.equal(inbox.find(({ id }) => id === refused)?.labels.refused, 'invalid')
  assert.equal(await host.canonical('note-1'), null)
  assert.ok(await host.canonical('note-2'))
  assert.equal(await host.applied(), inbox.at(-1)?.id)

  // A client ID another author holds: the app's lookup finds nothing, and Board answers 409.
  const duplicate = new BoardError('duplicate_id', 'stubbed collision', 409)
  const takenRoot = await host.submit(work('work-taken'))
  const takenReply = await host.submit({ ...base, rid: 'note-taken', kind: 'note', root: 'work-1', text: 'Taken.' })
  await createStateWriter({ settings: { allowlist: ['example'], machines: {} }, stateFile: host.stateFile,
    openBoard: () => failing(failing(board(), 'app:work-taken', duplicate), 'app:note-taken', duplicate) }).pass()
  const taken = await host.messages('inbox')
  assert.deepEqual([takenRoot, takenReply].map((id) => taken.find((message) => message.id === id)?.labels.refused), ['rid', 'rid'])
  assert.equal(await host.applied(), takenReply)

  const retried = await host.submit({ ...base, rid: 'note-3', kind: 'note', root: 'work-1', text: 'Board is down.' })
  const before = await host.applied()
  await assert.rejects(createStateWriter({ settings: { allowlist: ['example'], machines: {} }, stateFile: host.stateFile,
    openBoard: () => failing(board(), 'app:note-3', new BoardError('unavailable', 'stubbed outage', 503)) }).pass(), /stubbed outage/)
  assert.equal((await host.messages('inbox')).find(({ id }) => id === retried)?.labels.refused, undefined)
  assert.equal(await host.applied(), before)
  await host.writer().pass()
  assert.ok(await host.canonical('note-3'))
  assert.equal(await host.applied(), retried)
})

test('Ingest: a reused rid that names an app post of another kind or channel, such as a sched root, is refused and changes nothing', async (t) => {
  const host = await startHost(t)
  await host.submit(work('work-1'))
  await host.writer().pass()
  // A stopped schedule, as the UI route writes it from release 4.
  const schedLabels = { rid: 'sched-1', by: 'user', status: 'stopped', every: 'P1D' }
  await host.owner.post('sched', { id: 'app:sched-1', text: 'Every morning.', labels: schedLabels })
  const asNote = await host.submit({ ...base, rid: 'sched-1', kind: 'note', root: 'work-1', text: 'Reuses the rid.' })
  const asTodo = await host.submit({ ...base, rid: 'sched-1', kind: 'todo', channel: 'todos', text: 'Reuses it too.' }, 'sched-1-todo')
  await host.writer().pass()

  const inbox = await host.messages('inbox')
  assert.equal(inbox.find(({ id }) => id === asNote)?.labels.refused, 'rid')
  assert.equal(inbox.find(({ id }) => id === asTodo)?.labels.refused, 'rid')
  const sched = await host.owner.posted('app:sched-1')
  assert.deepEqual(sched.labels, schedLabels)
  assert.equal((await host.owner.thread(sched.id)).replies.length, 0)
  assert.equal((await host.owner.thread((await host.owner.posted('app:work-1')).id)).replies.length, 0)
})

test('Ingest: a reused rid on a reply to another root, or with other text, is refused as rid and its post is not lost silently', async (t) => {
  const host = await startHost(t)
  await host.submit(work('work-a'))
  await host.submit(work('work-b'))
  await host.submit({ ...base, rid: 'note-1', kind: 'note', root: 'work-a', text: 'On a.' })
  await host.writer().pass()
  const onB = await host.submit({ ...base, rid: 'note-1', kind: 'note', root: 'work-b', text: 'On a.' }, 'note-1-on-b')
  const otherText = await host.submit({ ...base, rid: 'note-1', kind: 'note', root: 'work-a', text: 'Changed.' }, 'note-1-changed')
  const asAsk = await host.submit({ ...base, rid: 'note-1', kind: 'ask', root: 'work-a', text: 'On a.' }, 'note-1-ask')
  const same = await host.submit({ ...base, rid: 'note-1', kind: 'note', root: 'work-a', text: 'On a.' }, 'note-1-again')
  await host.writer().pass()

  const refusedOf = async (id: string) => (await host.messages('inbox')).find((message) => message.id === id)?.labels.refused
  assert.equal(await refusedOf(onB), 'rid')
  assert.equal(await refusedOf(otherText), 'rid')
  assert.equal(await refusedOf(asAsk), 'rid')
  assert.equal(await refusedOf(same), undefined)
  const replies = async (rid: string) => (await host.owner.thread((await host.owner.posted(`app:${rid}`)).id)).replies.length
  assert.deepEqual([await replies('work-a'), await replies('work-b')], [1, 0])
})

test('Ingest: a reused rid on a root in another channel, or on a deleted canonical post, is refused as rid', async (t) => {
  const host = await startHost(t)
  await host.submit({ ...base, rid: 'item-1', kind: 'todo', channel: 'todos', text: 'Same text.' })
  await host.writer().pass()
  const asWork = await host.submit({ ...base, rid: 'item-1', kind: 'work', channel: 'work', text: 'Same text.' }, 'item-1-work')
  await host.submit(work('work-1'))
  await host.submit({ ...base, rid: 'note-1', kind: 'note', root: 'work-1', text: 'Deleted later.' })
  await host.writer().pass()
  await host.owner.delete((await host.owner.posted('app:note-1')).id)
  const replayed = await host.submit({ ...base, rid: 'note-1', kind: 'note', root: 'work-1', text: 'Deleted later.' }, 'note-1-again')
  await host.writer().pass()

  const inbox = await host.messages('inbox')
  assert.equal(inbox.find(({ id }) => id === asWork)?.labels.refused, 'rid')
  assert.equal(inbox.find(({ id }) => id === replayed)?.labels.refused, 'rid')
  assert.deepEqual((await host.messages('work')).map(({ labels }) => labels.rid).filter(Boolean), ['work-1'])
  assert.equal(await host.applied(), replayed)
})

test('Ingest: a root deleted on the board stalls nothing: its fold is skipped, a new reply to it is refused as root, and applied moves on', async (t) => {
  const host = await startHost(t)
  await host.submit(work('work-1'))
  await host.writer().pass()
  await host.submit({ ...base, rid: 'note-1', kind: 'note', root: 'work-1', text: 'Lands, then the root goes.' })
  await assert.rejects(host.writer(({ method, id }) => method === 'reply' && id === 'app:note-1').pass(), /crash/)
  await host.owner.delete((await host.owner.posted('app:work-1')).id)
  const late = await host.submit({ ...base, rid: 'note-2', kind: 'note', root: 'work-1', text: 'Too late.' })
  const last = await host.submit({ ...base, rid: 'todo-1', kind: 'todo', channel: 'todos', text: 'Still lands.' })
  await host.writer().pass()

  assert.equal((await host.messages('inbox')).find(({ id }) => id === late)?.labels.refused, 'root')
  assert.equal(await host.canonical('note-2'), null)
  assert.deepEqual(await host.rootLabels('todo-1'), { rid: 'todo-1', by: base.by, status: 'open' })
  assert.equal(await host.applied(), last)
})

/** The board as rids: each conversation post's labels and text, the reply counts, and inbox decisions. */
async function boardState(host: Awaited<ReturnType<typeof startHost>>) {
  const posts: Record<string, { labels: Labels; text: string }> = {}
  for (const channel of ['todos', 'work', 'msg']) {
    for (const { labels, text } of await host.messages(channel)) {
      assert.ok(labels.rid && !(labels.rid in posts), `one post per rid: ${labels.rid}`)
      posts[labels.rid] = { labels, text }
    }
  }
  const inbox = (await host.messages('inbox')).map(({ text, labels }) => ({ text, refused: labels.refused }))
  return { posts, inbox, applied: await host.applied() }
}

/**
 * Every intent `applied` covers is decided, and each written one's root carries the fold of its
 * thread up to that post at least: later posts, which `applied` does not cover, may not be folded yet.
 */
async function assertAppliedCoversOnlyFolded(host: Awaited<ReturnType<typeof startHost>>) {
  const marker = await host.owner.posted(appMarker.id)
  const inbox = await host.messages('inbox')
  const covered = inbox.slice(0, inbox.findIndex(({ id }) => id === marker.labels.applied) + 1)
  for (const message of covered) {
    if (message.id === marker.id || message.labels.refused) continue
    const written = await host.canonical((JSON.parse(message.text) as { rid: string }).rid)
    assert.ok(written, `applied covers an undecided intent: ${message.text}`)
    const { message: root, replies } = await host.owner.thread(written.re ?? written.id)
    const state = Object.fromEntries(Object.entries(root.labels).filter(([key]) => isStateLabel(key)))
    const folds = replies.map((_, index) => foldState(replies.slice(0, index + 1).map(({ labels }) => labels)))
    const covers = [foldState([]), ...folds].slice(replies.findIndex(({ id }) => id === written.id) + 1)
    assert.ok(covers.some((fold) => isDeepStrictEqual(fold, state)), `root labels lag behind applied: ${message.text}`)
  }
}

/** Two passes' worth of intents, a user answer between them, and the second pass's inbox. */
async function crashWorkload(host: Awaited<ReturnType<typeof startHost>>) {
  await host.submit(work('work-1', { machine: 'laptop', thread: 'thread-1', issue: 'example/project#1' }))
  await host.submit({ ...base, rid: 'ask-1', kind: 'ask', root: 'work-1', text: 'Proceed?', block: 1 })
  await host.writer().pass()
  await host.userReply('work-1', { rid: 'answer-1', re: 'ask-1' })
  const note = { ...base, rid: 'note-1', kind: 'note', root: 'work-1', text: 'A late note.' }
  for (const intent of [
    note,
    { ...base, rid: 'todo-1', kind: 'todo', channel: 'todos', text: 'Check the queue.', machine: 'desktop' },
    { ...base, rid: 'drop-1', kind: 'drop', root: 'todo-1', text: '' },
    { ...base, rid: 'note-2', kind: 'note', root: 'work-1', text: 'Done with that.', re: 'answer-1', pr: 'https://github.com/example/project/pull/2' },
    work('work-x', { repo: 'other/project' }),
    { ...base, rid: 'ask-2', kind: 'ask', root: 'work-1', text: 'Ship it?', block: 1 },
    { ...base, rid: 'done-1', kind: 'done', root: 'work-1', text: '' },
  ]) await host.submit(intent)
  await host.submit(note, 'note-1-again')
}

test('State writer: a crash after any post, and a replay from an older cursor, leave the same labels; applied passes an intent only after its root labels are written', async (t) => {
  const reference = await (async () => {
    const host = await startHost(t, { machines: { laptop: 'env-1' } })
    await crashWorkload(host)
    let writes = 0
    await host.writer(() => {
      writes += 1
      return false
    }).pass()
    return { writes, state: await boardState(host) }
  })()
  assert.ok(reference.writes > 10)
  assert.equal(reference.state.inbox.filter(({ refused }) => refused).length, 1)
  assert.equal(reference.state.posts['work-1']?.labels.status, 'done')

  for (let crashAt = 1; crashAt <= reference.writes; crashAt += 1) {
    await t.test(`crash after write ${crashAt} of ${reference.writes}`, async (t) => {
      const host = await startHost(t, { machines: { laptop: 'env-1' } })
      await crashWorkload(host)
      let writes = 0
      await assert.rejects(host.writer(() => (writes += 1) === crashAt).pass(), /crash/)
      await assertAppliedCoversOnlyFolded(host)
      await host.writer().pass()
      assert.deepEqual(await boardState(host), reference.state)
      // A replay from an older cursor: the whole inbox again, with no fold cursor.
      await host.owner.label((await host.owner.posted(appMarker.id)).id, { unset: ['applied'] })
      await rm(host.stateFile)
      await host.writer().pass()
      assert.deepEqual(await boardState(host), reference.state)
    })
  }
})

test('Routing labels are set once at root creation: env from the machine map, unset for an unmapped machine; no reply changes them', async (t) => {
  const host = await startHost(t, { machines: { laptop: 'env-1' } })
  await host.submit(work('work-1', { machine: 'laptop', thread: 'thread-1', issue: 'example/project#1' }))
  await host.submit({ ...base, rid: 'todo-1', kind: 'todo', channel: 'todos', text: 'Check.', machine: 'desktop', repo: 'EXAMPLE/other' })
  await host.submit({ ...base, rid: 'todo-2', kind: 'todo', channel: 'todos', text: 'Proto.', machine: 'constructor' })
  await host.writer().pass()
  const routing = { rid: 'work-1', by: base.by, repo: 'example/project', machine: 'laptop', env: 'env-1', thread: 'thread-1', issue: 'example/project#1' }
  assert.deepEqual(await host.rootLabels('work-1'), { ...routing, status: 'open' })
  assert.deepEqual(await host.rootLabels('todo-1'), { rid: 'todo-1', by: base.by, repo: 'EXAMPLE/other', machine: 'desktop', status: 'open' })
  assert.deepEqual(await host.rootLabels('todo-2'), { rid: 'todo-2', by: base.by, machine: 'constructor', status: 'open' })

  for (const intent of [
    { ...base, rid: 'ask-1', kind: 'ask', root: 'work-1', text: 'Proceed?', block: 1, by: 'desktop-codex' },
    { ...base, rid: 'note-1', kind: 'note', root: 'work-1', text: 'Note.', repo: 'example/elsewhere' },
    { ...base, rid: 'note-2', kind: 'note', root: 'work-1', text: 'Note.', pr: 'https://github.com/example/project/pull/3' },
    { ...base, rid: 'done-1', kind: 'done', root: 'work-1', text: '' },
  ]) await host.submit(intent)
  await host.writer().pass()
  const labels = await host.rootLabels('work-1')
  assert.deepEqual(Object.fromEntries(Object.entries(labels).filter(([key]) => !isStateLabel(key))), routing)
  assert.equal(labels.status, 'done')
  assert.equal((await host.canonical('ask-1'))?.labels.by, 'desktop-codex')
})

test('A resolve sets status=done; the thread is found by its status label and by search, and the resolve post shows who resolved it', async (t) => {
  const host = await startHost(t)
  await host.submit(work('work-1', { text: 'Rotate the signing key.' }))
  await host.submit({ ...base, rid: 'done-1', kind: 'done', root: 'work-1', text: '', by: 'desktop-claude' })
  await host.writer().pass()
  const root = await host.owner.posted('app:work-1')
  assert.equal(root.labels.status, 'done')
  const open = await host.owner.threads({ channel: 'work', label: { status: 'open' } })
  assert.deepEqual(open.threads, [])
  const done = await host.owner.threads({ channel: 'work', label: { status: 'done' } })
  assert.deepEqual(done.threads.map(({ message }) => message.id), [root.id])
  const found = await host.owner.threads({ channel: 'work', text: 'signing key' })
  assert.deepEqual(found.threads.map(({ message }) => message.id), [root.id])
  const resolve = await host.canonical('done-1')
  assert.deepEqual(resolve && { text: resolve.text, by: resolve.labels.by, kind: resolve.labels.kind }, { text: 'Resolved.', by: 'desktop-claude', kind: 'done' })
})

test('After a changed epoch the app drops its cursors: it ingests inbox from its start and folds every thread again', async (t) => {
  const host = await startHost(t)
  await host.submit(work('work-1'))
  await host.writer().pass()
  assert.deepEqual(JSON.parse(await readFile(host.stateFile, 'utf8')).epoch, '1')
  const root = await host.owner.posted('app:work-1')
  // A label the fold does not give, written behind the writer's back: the cursors skip it.
  await host.owner.label(root.id, { set: { status: 'blocked', turn: 'x' } })
  await host.writer().pass()
  assert.equal((await host.rootLabels('work-1')).status, 'blocked')

  await host.owner.label((await host.owner.posted(boardMarker.id)).id, { set: { epoch: '2' } })
  await host.writer().pass()
  assert.deepEqual(await host.rootLabels('work-1'), { rid: 'work-1', by: base.by, repo: 'example/project', status: 'open' })
  assert.equal(JSON.parse(await readFile(host.stateFile, 'utf8')).epoch, '2')
})

test('Pending inbox schedules are canceled before each pass and counted in /devchat.json', async (t) => {
  const host = await startHost(t)
  const scheduled = await host.server.tailnet.request('/schedules', {
    method: 'POST', body: { channel: 'inbox', text: JSON.stringify(work('work-later')), in: '1h' },
  })
  assert.equal(scheduled.status, 201, scheduled.body)
  const writer = host.writer()
  await writer.pass()
  assert.deepEqual((await host.owner.schedules({ channel: 'inbox', all: true })).map(({ state }) => state), ['canceled'])
  await writer.pass()

  const app = createApp({ version: '1.2.3', writerStats: writer.stats })
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  t.after(() => app.close())
  const response = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/devchat.json`)
  assert.deepEqual(await response.json(), { app: 'devchat', version: '1.2.3', board: { reachable: true }, epoch: 1, inboxSchedulesCanceled: 1 })
})
