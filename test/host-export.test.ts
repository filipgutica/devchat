import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exportBoard, exportsToPrune } from '../src/host/export.ts'
import { createMemoryBoard } from '../src/testing/index.ts'

test('exportsToPrune keeps the newest 14 export files and ignores other files', () => {
  const names = Array.from({ length: 16 }, (_, day) => `devchat-202611${String(day + 1).padStart(2, '0')}T030000Z.json`)
  assert.deepEqual(exportsToPrune([...names, 'notes.txt', 'devchat-x.json'].reverse()), names.slice(0, 2))
})

test('exportBoard writes every post keyed by rid, private to the service account, and loses none', async (t) => {
  const { handle, close } = createMemoryBoard()
  const dir = await mkdtemp(join(tmpdir(), 'devchat-export-'))
  t.after(async () => {
    close()
    await rm(dir, { recursive: true, force: true })
  })
  const root = await handle.post('work', { text: 'Review.', labels: { rid: 'work-1' } })
  await handle.reply(root.id, { text: 'Done.', labels: { rid: 'note-1' } })
  const repeated = await handle.post('todos', { text: 'Same rid.', labels: { rid: 'work-1' } })
  await handle.post('todos', { text: 'Odd rid.', labels: { rid: '__proto__' } })
  const intent = await handle.post('inbox', { text: '{"v":1}' })
  for (let day = 1; day <= 14; day += 1) await writeFile(join(dir, `devchat-202610${String(day).padStart(2, '0')}T030000Z.json`), '{}')

  const { file, records, duplicates, pruned } = await exportBoard(handle, dir, new Date('2026-11-27T03:00:00.000Z'))
  assert.equal(file, join(dir, 'devchat-20261127T030000Z.json'))
  assert.equal(records, 5)
  assert.equal(duplicates, 1)
  assert.deepEqual(pruned, ['devchat-20261001T030000Z.json'])
  assert.equal((await readdir(dir)).length, 14)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const written = JSON.parse(await readFile(file, 'utf8'))
  // Whichever post with rid work-1 is read first keeps the rid; the other is kept by its Board ID.
  const first = written.records['work-1'].id
  const second = first === root.id ? repeated.id : root.id
  assert.deepEqual(Object.keys(written.records).sort(), [`#${intent.id}`, `#${second}`, '__proto__', 'note-1', 'work-1'].sort())
  assert.equal(Object.getPrototypeOf(written.records), Object.prototype)
  assert.deepEqual(written.duplicates, [{ rid: 'work-1', id: second }])
})
