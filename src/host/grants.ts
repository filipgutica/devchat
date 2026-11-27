import { BoardError, type Board, type GrantInput, type GrantView } from '@vercel/board'
import { boardMarker, channels } from '../shared/layout.ts'

type Permission = 'read' | 'post' | 'react' | 'label' | 'sync' | 'manage'

/**
 * What the user's tailnet login may do (§5). The four conversation channels and `out` are
 * read-only, so the app is their only writer; `inbox` takes label-free posts. `sys` is read-only
 * in release 1: a label there could change the board marker's epoch and stop every client's sync,
 * and the machine markers that need writes arrive in release 3.
 */
const tailnetCan = {
  [channels.todos]: ['read'],
  [channels.work]: ['read'],
  [channels.msg]: ['read'],
  [channels.sched]: ['read'],
  [channels.out]: ['read'],
  [channels.inbox]: ['read', 'post'],
  'guide/': ['read', 'post', 'label'],
  [channels.dream]: ['read', 'post', 'label'],
  [channels.sys]: ['read'],
} as const satisfies Record<string, readonly Permission[]>

/**
 * The whole grant set: `everyone` gets nothing, the service account everything (an owner needs a
 * grant to read a closed channel, Phase 0), and the tailnet login the split above.
 */
export function desiredGrants({ login, account }: { login: string; account: string }): GrantInput[] {
  return [
    { principals: [{ kind: 'everyone' }], can: { '*': 'none' } },
    { principals: [{ kind: 'user', userId: account }], can: { '*': 'all' } },
    { principals: [{ kind: 'user', userId: login }], can: tailnetCan },
  ]
}

type GrantShape = { principals: readonly ({ kind: string; userId?: string | undefined })[]; can: Readonly<Record<string, 'all' | 'none' | readonly string[]>> }

/** One string per grant, the same for a grant as written and as the board lists it. */
function grantKey({ principals, can }: GrantShape) {
  const who = principals.map(({ kind, userId }) => (userId === undefined ? kind : `${kind}:${userId}`)).sort()
  const what = Object.entries(can)
    .map(([pattern, permissions]) => {
      const list = permissions === 'none' ? [] : permissions
      return `${pattern}=${list === 'all' ? 'all' : [...list].sort().join(',')}`
    })
    .sort()
  return `${who.join('+')} ${what.join(' ')}`
}

/** Which grants to create and which to revoke so the board holds exactly `desired`. */
export function planGrants(current: readonly GrantView[], desired: readonly GrantInput[]) {
  const wanted = new Map(desired.map((grant) => [grantKey(grant), grant]))
  const kept = new Set<string>()
  const revoke: string[] = []
  for (const grant of current) {
    const key = grantKey(grant)
    if (wanted.has(key) && !kept.has(key)) kept.add(key)
    else revoke.push(grant.id)
  }
  const create = [...wanted].filter(([key]) => !kept.has(key)).map(([, grant]) => grant)
  return { create, revoke }
}

type Log = (line: string) => void

async function applyGrantPlan(handle: Board, { create, revoke }: ReturnType<typeof planGrants>, log: Log) {
  if (create.length === 0 && revoke.length === 0) {
    log('unchanged: grants')
    return
  }
  // Create before revoking: the new set keeps the service account in, so no step locks it out.
  if (create.length > 0) {
    const { grants } = await handle.createGrants(create)
    log(`applied: created grants ${grants.map(({ id }) => id).join(', ')}`)
  }
  for (const id of revoke) {
    await handle.revokeGrant(id)
    log(`applied: revoked grant ${id}`)
  }
}

/** Converges the board's grants to `desired`, then lists them again and fails on any difference. */
async function convergeGrants(handle: Board, desired: readonly GrantInput[], log: Log) {
  await applyGrantPlan(handle, planGrants(await handle.grants(), desired), log)
  const after = planGrants(await handle.grants(), desired)
  if (after.create.length > 0 || after.revoke.length > 0) {
    throw new Error(`grants did not converge: missing ${after.create.length}, extra ${after.revoke.join(', ')}`)
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join()

/** `grants explain` for the tailnet login on every channel the split names, and one it doesn't. */
async function explainGrants(handle: Board, login: string, log: Log) {
  const expected: [string, readonly string[]][] = [
    ...Object.entries(tailnetCan).map(([pattern, can]): [string, readonly string[]] =>
      [pattern.endsWith('/') ? `${pattern}global` : pattern, can]),
    ['devchat-unlisted', []],
  ]
  for (const [channel, can] of expected) {
    const explanation = await handle.explain(channel, { user: login })
    if (!sameSet(explanation.can, can)) {
      throw new Error(`grants explain ${channel}: the tailnet login gets [${explanation.can}], expected [${can}]`)
    }
  }
  log(`unchanged: grants explain matches the tailnet split on ${expected.length} channels`)
}

/** Posts the board marker with `epoch=1` once. An existing marker keeps its `epoch`. */
async function ensureBoardMarker(handle: Board, log: Log) {
  try {
    const marker = await handle.posted(boardMarker.id)
    log(`unchanged: board marker (epoch=${marker.labels.epoch ?? 'unset'})`)
  } catch (error) {
    if (!(error instanceof BoardError) || error.code !== 'post_not_found') throw error
    await handle.post(boardMarker.channel, {
      id: boardMarker.id,
      text: 'devchat board marker',
      labels: { epoch: '1' },
    })
    log(`applied: board marker posted in ${boardMarker.channel} (epoch=1)`)
  }
}

async function serviceAccount(handle: Board) {
  const { principal } = await handle.me()
  if (!principal.startsWith('local:user:')) throw new Error(`board setup needs the loopback owner, not ${principal}`)
  return principal.slice('local:user:'.length)
}

/**
 * The first half of setup, on a board that does not serve the tailnet yet: `everyone` gets nothing,
 * the service account everything, and every other grant goes, Board's default `g1` first: it lets
 * any forged tailnet header manage the board. The login's grant waits for `setupBoard`, since a
 * board served without `--tailscale` refuses a login as a user ID; an existing one stays.
 */
export async function lockBoard(handle: Board, login: string, log: Log) {
  const desired = desiredGrants({ login, account: await serviceAccount(handle) })
  const tailnet = desired[2]
  const { create, revoke } = planGrants(await handle.grants(), desired)
  await applyGrantPlan(handle, { create: create.filter((grant) => grant !== tailnet), revoke }, log)
}

/** Runbook step 3 as the service account: the full grant set, its check, and the board marker. */
export async function setupBoard(handle: Board, login: string, log: Log) {
  await convergeGrants(handle, desiredGrants({ login, account: await serviceAccount(handle) }), log)
  await explainGrants(handle, login, log)
  await ensureBoardMarker(handle, log)
}

/**
 * Why a board is not locked, if it is not. Locked means its grants are exactly devchat's: `everyone`
 * gets nothing, the service account everything, and at most the tailnet login's exact grant. Any
 * other grant (Board's defaults g1–g3, an open `everyone`, the login with more) is a problem.
 * Only a locked board may serve the tailnet.
 */
export function lockProblems(grants: readonly GrantView[], desired: readonly GrantInput[]) {
  const [, , tailnet] = desired
  const { create, revoke } = planGrants(grants, desired)
  return [
    ...revoke.map((id) => `${id} is not one of devchat's grants`),
    ...create.filter((grant) => grant !== tailnet).map((grant) => `missing ${grantKey(grant)}`),
  ]
}

/** `lockProblems` for this board, as the service account. */
export async function boardLockProblems(handle: Board, login: string) {
  return lockProblems(await handle.grants(), desiredGrants({ login, account: await serviceAccount(handle) }))
}
