import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { board } from '@vercel/board'
import { checkVb, type CheckResult } from '../src/host/verify.ts'
import { startBoardServer } from '../src/testing/index.ts'

test('checkVb passes a refusal and fails an allowed write, for an authenticated caller', async (t) => {
  const server = await startBoardServer()
  t.after(server.stop)
  process.env.BOARD_URL = server.url
  process.env.XDG_CONFIG_HOME = server.configHome
  // The owner keeps manage but loses every channel: vb is authenticated and gets a 403 on a post.
  const owner = board()
  await owner.createGrants([{ principals: [{ kind: 'everyone' }], can: { '*': 'none' } }])
  for (const id of ['g1', 'g2', 'g3']) await owner.revokeGrant(id)

  const results: CheckResult[] = []
  const cli = fileURLToPath(new URL('./dist/cli.mjs', import.meta.resolve('@vercel/board/package.json')))
  checkVb({ url: server.url, route: 'owner', node: process.execPath, cli }, (name, ok, detail) => { results.push({ name, ok, detail }) })
  assert.deepEqual(results.map(({ name, ok, detail }) => [name, ok, detail.replace(/^exit \d+/, 'exit n')]), [
    ['owner: vb post in work denied', true, 'exit n, permission_denied'],
    // An owner may change grants: the check must fail, not take a nonzero exit for a refusal.
    ['owner: vb grant change denied', false, 'exit n, {"grant":"g999999","outcome":"unchanged"}'],
  ])
})
