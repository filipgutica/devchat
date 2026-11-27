import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deferredIntentKinds, intentSchema, type Intent } from '../src/shared/layout.ts'

const work = {
  v: 1,
  rid: 'work-1',
  kind: 'work',
  channel: 'work',
  text: 'Review the handoff.',
  by: 'agent',
  repo: 'example/project',
  issue: 'ABC-123',
} as const satisfies Intent

test('accepts release 1 intent shapes', () => {
  const intents = [
    work,
    { v: 1, rid: 'todo-1', kind: 'todo', channel: 'todos', text: 'Check the queue.', by: 'agent' },
    { v: 1, rid: 'note-1', kind: 'note', root: work.rid, text: 'Draft is ready.', by: 'agent', pr: 'https://example.com/pull/1' },
    { v: 1, rid: 'ask-1', kind: 'ask', root: work.rid, text: 'Can we proceed?', by: 'agent', block: 1 },
    { v: 1, rid: 'done-1', kind: 'done', root: work.rid, text: '', by: 'agent', re: 'answer-1' },
    { v: 1, rid: 'drop-1', kind: 'drop', root: 'todo-1', text: '', by: 'agent' },
  ] satisfies Intent[]

  for (const intent of intents) assert.deepEqual(intentSchema.parse(intent), intent)
})

test('refuses derived fields, the user profile, and deferred kinds', () => {
  for (const override of [
    { env: '<env>' },
    { by: 'user' },
    { status: 'done' },
    { kind: 'answer' },
    { rid: 'x|y' },
    { by: 'a'.repeat(257) },
    { repo: 'r'.repeat(257) },
    ...deferredIntentKinds.map((kind) => ({ kind })),
  ]) {
    assert.equal(intentSchema.safeParse({ ...work, ...override }).success, false, JSON.stringify(override))
  }
})

test('refuses a work-lane todo in release 1', () => {
  assert.equal(intentSchema.safeParse({ v: 1, rid: 'todo-2', kind: 'todo', channel: 'todos', text: 'Check the queue.', by: 'agent', work: 1 }).success, false)
})

test('enforces target, Board input, and work-lane boundaries', () => {
  const { issue: _issue, ...workWithoutIssue } = work
  for (const intent of [
    { ...work, root: 'another-root' },
    { ...work, channel: 'sched' },
    { ...work, rid: 'r'.repeat(197) },
    { ...work, text: '   ' },
    { ...workWithoutIssue, kind: 'todo', channel: 'todos', work: 1 },
    { v: 1, rid: 'note-1', kind: 'note', channel: 'work', text: 'Draft is ready.', by: 'agent' },
  ]) {
    assert.equal(intentSchema.safeParse(intent).success, false, JSON.stringify(intent))
  }
})
