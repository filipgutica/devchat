import { useCallback, useRef, useState } from 'react'
import type { UserWrite } from '../../src/shared/layout.ts'
import { newRid, sendWrite, type Draft } from './api.ts'

export type WriteState =
  | { status: 'idle' }
  | { status: 'busy' }
  /** The board confirmed the write; the caller resets once the page shows its effect. */
  | { status: 'saved' }
  /** `retry` is set while the outcome is unknown: only a resend of the same body is safe. */
  | { status: 'error'; message: string; retry: boolean }

/**
 * One button's write, such as Resolve, under the D4 contract: the rid is made once and the body is
 * kept until an answer proves its fate (200 or 201, or 400, 409, or 422). Until then every send
 * resends that same body. After a confirmed write the state stays `saved`, which keeps the button
 * locked, until `reset`.
 */
export function useWrite(onSaved: () => Promise<void>) {
  const pending = useRef<UserWrite | null>(null)
  const locked = useRef(false)
  const [state, setState] = useState<WriteState>({ status: 'idle' })
  const reset = useCallback(() => {
    locked.current = false
    setState((current) => (current.status === 'saved' ? { status: 'idle' } : current))
  }, [])

  async function attempt(body: UserWrite) {
    if (locked.current) return false
    locked.current = true
    setState({ status: 'busy' })
    const outcome = await sendWrite(body)
    if (outcome.ok || outcome.settled) pending.current = null
    if (outcome.ok) {
      setState({ status: 'saved' })
      void onSaved()
      return true
    }
    locked.current = false
    setState({ status: 'error', message: outcome.message, retry: !outcome.settled })
    return false
  }

  return {
    state,
    /** Sends the write, or resends the unconfirmed one exactly as it was sent. */
    send: (draft: Draft) => attempt(pending.current ??= { ...draft, rid: newRid() } as UserWrite),
    /** Unlocks after a confirmed write, once the page shows it. */
    reset,
  }
}
