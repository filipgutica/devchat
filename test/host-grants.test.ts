import assert from 'node:assert/strict'
import { test } from 'node:test'
import { board, type GrantView } from '@vercel/board'
import { plainClient } from '../src/host/board-http.ts'
import { desiredGrants, lockBoard, planGrants, setupBoard } from '../src/host/grants.ts'
import { checkAnonymousRoute, checkTailnetRoute, type CheckResult } from '../src/host/verify.ts'
import { startBoardServer } from '../src/testing/index.ts'

const view = (id: string, grant: ReturnType<typeof desiredGrants>[number]): GrantView => ({
  id,
  principals: grant.principals.map((principal) => (principal.kind === 'user'
    ? { kind: 'user', userId: principal.userId ?? '', email: null }
    : { kind: 'everyone' })),
  can: Object.fromEntries(Object.entries(grant.can).map(([pattern, can]) => [pattern, can === 'none' ? [] : can === 'all' ? 'all' : [...can]])),
  capped: false,
  by: null,
  at: null,
})

test('planGrants keeps matching grants and revokes defaults, duplicates, and a changed login', () => {
  const wanted = desiredGrants({ login: 'new@example.com', account: 'devchat' })
  const [everyone, account] = wanted
  assert.ok(everyone && account)
  const oldLogin = desiredGrants({ login: 'old@example.com', account: 'devchat' })[2]
  assert.ok(oldLogin)
  const current: GrantView[] = [
    { id: 'g1', principals: [{ kind: 'all-users' }], can: { '*': 'all' }, capped: false, by: null, at: null },
    view('g4', everyone), view('g5', account), view('g6', account), view('g7', oldLogin),
  ]
  const { create, revoke } = planGrants(current, wanted)
  assert.deepEqual(revoke, ['g1', 'g6', 'g7'])
  assert.deepEqual(create, [wanted[2]])
})

test('board setup against vb serve', async (t) => {
  // The install's first start: loopback only, without --tailscale.
  const server = await startBoardServer({ tailscale: false })
  t.after(server.stop)
  process.env.BOARD_URL = server.url
  process.env.XDG_CONFIG_HOME = server.configHome
  const login = 'user@example.com'

  await t.test('the lock revokes the default grants on a board that does not serve the tailnet yet', async () => {
    const log: string[] = []
    await lockBoard(board(), login, (line) => log.push(line))
    assert.ok(log.includes('applied: revoked grant g1'), log.join('\n'))
    const grants = await board().grants()
    assert.deepEqual(grants.map(({ principals }) => principals[0]?.kind), ['everyone', 'user'])
    // Such a board refuses the login as a user ID, which is why its grant waits for setupBoard.
    await assert.rejects(setupBoard(board(), login, () => {}), /userId/)
  })

  await t.test('after a restart with --tailscale, setup converges once and a rerun changes nothing', async () => {
    await server.restart({ tailscale: true })
    const first: string[] = []
    await setupBoard(board(), login, (line) => first.push(line))
    assert.deepEqual(first.filter((line) => line.startsWith('applied:')).map((line) => line.replace(/g\d+/, 'g?')),
      ['applied: created grants g?', 'applied: board marker posted in sys (epoch=1)'])
    const grants = await board().grants()

    const second: string[] = []
    await setupBoard(board(), login, (line) => second.push(line))
    await lockBoard(board(), login, (line) => second.push(line))
    assert.deepEqual(second.filter((line) => !line.startsWith('unchanged:')), [])
    assert.deepEqual(await board().grants(), grants)
  })

  await t.test('the tailnet login and an anonymous caller get only the §5 split', async () => {
    // A root to reply to and label in two channels; msg stays empty to take the explain fallback.
    await board().post('todos', { text: 'seed' })
    await board().post('work', { text: 'seed' })
    const results: CheckResult[] = []
    const check = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }) }
    await checkTailnetRoute((path, init) => server.tailnet.request(path, init), { route: 'tailnet', login }, check)
    await checkAnonymousRoute(plainClient(server.url), 'plain', check)
    assert.deepEqual(results.filter(({ ok }) => !ok), [])
    const names = results.map(({ name }) => name)
    for (const name of ['tailnet: reply in todos denied', 'tailnet: label write in work denied',
      'tailnet: reply and label in msg denied (no post to probe; grants explain)', 'tailnet: label-free post in inbox succeeds',
      'tailnet: label write in inbox denied', 'plain: grant change denied']) {
      assert.ok(names.includes(name), name)
    }
  })
})
