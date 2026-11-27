import { useSyncExternalStore } from 'react'
import type { UserWrite } from '../../src/shared/layout.ts'
import { sendWrite } from './api.ts'

/**
 * The page-level store of the UI's writes: each composer's draft, and each composer's or Resolve
 * button's unconfirmed write, keyed `channel:<repo>:<tab>`, `thread:<rid>`, or `resolve:<rid>`. They
 * outlive the component, so closing a thread or leaving a channel keeps them.
 */

/**
 * A write sent whose outcome is not known yet. It is immutable: a retry resends
 * exactly this rid and body (D4), and a changed draft never takes its rid.
 */
export type PendingWrite = Readonly<{ text: string; body: Readonly<UserWrite> }>

export type Status =
  | { status: 'idle' }
  | { status: 'busy' }
  /** The board confirmed the write; `stamp` orders it against the page's reads (see `stamp`). */
  | { status: 'saved'; stamp: number }
  /** `retry` is set while the outcome is unknown: the pending write can only be resent or discarded. */
  | { status: 'error'; message: string; retry: boolean }

/** One draft and write. Resolve uses only `status` and `pending`. */
export type ComposerState = Readonly<{
  text: string
  /** The question the draft started under: a reply answers what the user saw while writing it. */
  bound: Readonly<{ rid: string | undefined }> | null
  status: Status
  pending: PendingWrite | null
}>

const empty: ComposerState = Object.freeze({ text: '', bound: null, status: { status: 'idle' as const }, pending: null })
const states = new Map<string, ComposerState>()
const listeners = new Set<() => void>()

export const readComposer = (key: string) => states.get(key) ?? empty

/** Changes a composer's state at once, so a check right after it, such as Send's lock, sees the change. */
export function updateComposer(key: string, change: (state: ComposerState) => Partial<ComposerState>) {
  const current = readComposer(key)
  states.set(key, { ...current, ...change(current) })
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const useComposerState = (key: string) => useSyncExternalStore(subscribe, () => readComposer(key))

let clock = 0
/** A page-wide order of events: a read that finishes after a write took a larger stamp. */
export const stamp = () => ++clock

/**
 * Sends a pending write under the D4 settle rule. Only an answer that proves this rid's fate drops
 * the record: 200 or 201, or a 400, 409, or 422 on this body. Anything else keeps it, and only Retry
 * or Discard moves past it. On a confirmed write, `confirmed` gives the rest of the change, made in
 * the same update that ends the busy state. True when the board confirmed it.
 */
export async function attemptWrite(key: string, write: PendingWrite, confirmed: (state: ComposerState) => Partial<ComposerState>) {
  updateComposer(key, () => ({ status: { status: 'busy' } }))
  const outcome = await sendWrite(write.body)
  if (!outcome.ok) {
    updateComposer(key, () => ({
      status: { status: 'error', message: outcome.message, retry: !outcome.settled },
      ...(outcome.settled ? { pending: null } : {}),
    }))
    return false
  }
  updateComposer(key, (current) => ({ pending: null, status: { status: 'idle' }, ...confirmed(current) }))
  return true
}
