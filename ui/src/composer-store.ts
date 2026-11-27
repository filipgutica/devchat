import { useSyncExternalStore } from 'react'
import type { UserWrite } from '../../src/shared/layout.ts'

/**
 * A write a composer sent whose outcome it has not learned yet. It is immutable: a retry resends
 * exactly this rid and body (D4), and a changed draft never takes its rid.
 */
export type PendingWrite = Readonly<{ text: string; body: Readonly<UserWrite> }>

export type Status =
  | { status: 'idle' }
  | { status: 'busy' }
  /** `retry` is set while the outcome is unknown: the pending write can only be resent or discarded. */
  | { status: 'error'; message: string; retry: boolean }

/** One composer's draft and write, which outlive the composer: closing a thread or leaving a channel keeps them. */
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
