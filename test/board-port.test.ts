import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBoardPort } from '../src/server/board-port.ts'
import { createMemoryBoard } from '../src/testing/index.ts'

test('the board port preserves client IDs, cursors, and conditional label writes', async (t) => {
  const { handle, close } = createMemoryBoard()
  t.after(close)
  const port = createBoardPort(handle)

  const root = await port.post('work', { id: 'app:work-1', text: 'Review the handoff.', labels: { status: 'open' } })
  const { cursor } = await port.readChannel('work')
  const reply = await port.reply(root.id, { id: 'app:note-1', text: 'Draft is ready.' })

  const page = await port.readChannel('work', { after: cursor })
  assert.deepEqual(page.messages.map(({ id }) => id), [reply.id])
  assert.equal((await port.getPost('app:note-1')).id, reply.id)
  const thread = await port.readThread(root.id)
  assert.deepEqual(thread.replies.map(({ id }) => id), [reply.id])

  await assert.rejects(port.setLabels(root.id, { set: { status: 'done' }, if: { status: 'blocked' } }), {
    code: 'label_conflict',
  })
  await port.setLabels(root.id, { set: { status: 'done' }, if: { status: 'open' } })
  const { threads } = await port.threads({ channel: 'work', label: { status: 'done' } })
  assert.deepEqual(threads.map(({ message }) => message.id), [root.id])
})
