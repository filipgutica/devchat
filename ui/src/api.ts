import type { UserWrite } from '../../src/shared/layout.ts'

/** A board post as the UI route answers it; the fields the UI reads. */
export type Message = {
  id: string
  channel: string
  text: string
  /** The thread's root, or null for a root. */
  re: string | null
  labels: Record<string, string>
  createdAt: string
}
/** A thread at a glance: its root, its reply count, and its newest reply. */
export type ThreadSummary = { message: Message; replies: number; last: Message | null }
export type Thread = { root: Message; replies: Message[] }
export type NeedsYou = { open: ThreadSummary[]; answered: ThreadSummary[] }
export type Tab = 'todos' | 'work'

/** The host can't be reached: the network failed, or `tailscale serve` found no app behind it. */
export class Unreachable extends Error {
  constructor() {
    super("devchat can't be reached")
  }
}

/** The app answered a read with an error. */
export class ReadError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const isUnreachable = (status: number) => status === 502 || status === 504

/** One read under `/api/ui/`. */
export async function read<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/ui/${path}`, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  } catch {
    throw new Unreachable()
  }
  if (isUnreachable(response.status)) throw new Unreachable()
  if (!response.ok) throw new ReadError(response.status, `devchat refused a read (${response.status}): ${await errorText(response)}`)
  return response.json() as Promise<T>
}

async function errorText(response: Response) {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') return body.error
  } catch {
    // A body that is not JSON, such as a proxy's error page, says nothing more than the status.
  }
  return response.statusText || 'no reason given'
}

/** One thread, or null when the board has no thread with this rid. */
export async function readThread(rid: string): Promise<Thread | null> {
  try {
    return await read<Thread>(`thread?rid=${encodeURIComponent(rid)}`)
  } catch (error) {
    if (error instanceof ReadError && error.status === 404) return null
    throw error
  }
}

/** Up to this many pages of a channel list, 50 threads each. */
const maxPages = 10

/**
 * A channel's open or resolved threads in one tab. #global (`repo` null) is the threads with no
 * `repo` label: Board can't query a missing label, so this reads the tab's pages and keeps those.
 */
export async function readChannel({ tab, repo, resolved }: { tab: Tab; repo: string | null; resolved: boolean }) {
  const threads: ThreadSummary[] = []
  let before: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({ channel: tab })
    if (repo) query.set('repo', repo)
    if (resolved) query.set('resolved', '1')
    if (before) query.set('before', before)
    const body: { threads: ThreadSummary[]; older: string | null } = await read(`threads?${query}`)
    threads.push(...body.threads)
    before = body.older
    if (!before) break
  }
  return repo ? threads : threads.filter(({ message }) => !message.labels.repo)
}

/** A UI write without its rid: the rid belongs to the write's lifetime, not its content. */
export type Draft = UserWrite extends infer W ? (W extends unknown ? Omit<W, 'rid'> : never) : never

/**
 * A new rid in the UI namespace: `ui-` and a lowercase version 4 UUID. `crypto.randomUUID` needs a
 * secure context, which a dev server on a tailnet address is not, so this builds it from random bytes.
 */
export function newRid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `ui-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * What a write came to. `written` is false when the board certainly holds nothing for this rid, so
 * a new attempt may take a new one; it is unknown after a network failure or a server error, when
 * only a retry with the same rid and body is safe.
 */
export type WriteOutcome =
  | { ok: true }
  | { ok: false; written: false; message: string }
  | { ok: false; written: 'unknown'; message: string }

/** What each refusal tells the user. None repeats the refused text: it may hold a secret. */
const refusals: Record<string, string> = {
  conflict: 'Not saved: an earlier send of this message may already be on the board. Check the thread, then send again.',
  repo: "Not saved: this repo isn't on the host's allowlist.",
  re: 'Not saved: the question changed while you wrote. Read the new question, then send again.',
  root: 'Not saved: this thread is no longer on the board.',
  invalid: 'Not saved: the board refused this text.',
}

/** Sends one UI write (§12, docs/layout.md "UI route"). The browser adds `Origin` and `Sec-Fetch-Site`. */
export async function sendWrite(body: UserWrite): Promise<WriteOutcome> {
  let response: Response
  try {
    response = await fetch('/api/ui/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    return { ok: false, written: 'unknown', message: "Not sent: devchat can't be reached. Your text is kept; retry when it's back." }
  }
  if (response.status === 200 || response.status === 201) return { ok: true }
  if (isUnreachable(response.status) || response.status >= 500 && response.status !== 503) {
    return { ok: false, written: 'unknown', message: 'Not sent: devchat had an error. Your text is kept; retry to send it once.' }
  }
  if (response.status === 503) {
    return { ok: false, written: false, message: "Not saved: devchat's text guard isn't loaded, so it refuses every write until the host is fixed." }
  }
  const reason = await refusalOf(response)
  if (response.status === 422) {
    const why = reason.detail ? ` (${reason.detail})` : ''
    return { ok: false, written: false, message: `Not saved: the text guard refused this text${why}. Remove that part and send again.` }
  }
  const message = (reason.refused && refusals[reason.refused]) ?? `Not saved: devchat refused this write (${response.status}).`
  return { ok: false, written: false, message }
}

/** The route's refusal and, for the guard, its reason, such as "credential assignment". */
async function refusalOf(response: Response): Promise<{ refused?: string; detail?: string }> {
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return {}
    const refused = 'refused' in body && typeof body.refused === 'string' ? body.refused : undefined
    const error = 'error' in body && typeof body.error === 'string' ? body.error : ''
    // The guard's error is "the guard refused the text: <reason>"; the reason names a kind, never the text.
    const detail = refused === 'guard' ? error.split(': ').at(-1) : undefined
    return { ...(refused ? { refused } : {}), ...(detail ? { detail } : {}) }
  } catch {
    return {}
  }
}
