import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldState, isStateLabel, stateChange } from '../src/server/fold.ts'
import { foldFixture } from './fold-fixture.ts'

for (const { name, steps } of foldFixture) {
  test(`fold: ${name} (fixtures/fold.json, §2 table and pending guard)`, () => {
    const [root, ...replies] = steps.map(({ post }) => post.labels)
    assert.ok(root)
    steps.forEach(({ rootLabels }, index) => {
      const own = Object.fromEntries(Object.entries(root).filter(([key]) => !isStateLabel(key)))
      assert.deepEqual({ ...own, ...foldState(replies.slice(0, index)) }, rootLabels, `after step ${index + 1}`)
    })
  })
}

test('fold: the label change sets what differs and unsets state labels the fold dropped, never routing labels', () => {
  const current = { rid: 'w', repo: 'example/project', status: 'blocked', ask: 'open', turn: 'q', 'pr.1': 'u' }
  assert.deepEqual(stateChange(current, { status: 'done', 'pr.1': 'u' }), { set: { status: 'done' }, unset: ['ask', 'turn'] })
  assert.equal(stateChange({ ...current, status: 'open' }, { status: 'open', ask: 'open', turn: 'q', 'pr.1': 'u' }), null)
})
