import { useRef, useState } from 'react'
import type { UserWrite } from '../../src/shared/layout.ts'
import { newRid, sendWrite, type Draft } from './api.ts'

export type WriteState =
  | { status: 'idle' }
  | { status: 'busy' }
  /** `retry` is set while the outcome is unknown: only a resend of the same body is safe. */
  | { status: 'error'; message: string; retry: boolean }

/**
 * One compose action's write, under the D4 contract: the rid is made once, reused on every retry,
 * and dropped only once the server answers for it: 200 or 201, or a refusal, which writes nothing.
 * After a network failure or a server error the outcome is unknown, so the rid and the exact body
 * stay; Retry resends them, and a new send reuses the rid. If the first attempt did land, a changed
 * body then answers 409, which ends the action.
 */
export function useWrite(onSaved: () => Promise<void>) {
  const pending = useRef<UserWrite | null>(null)
  const [state, setState] = useState<WriteState>({ status: 'idle' })

  async function attempt(body: UserWrite) {
    setState({ status: 'busy' })
    const outcome = await sendWrite(body)
    if (outcome.ok || outcome.written === false) pending.current = null
    if (outcome.ok) {
      setState({ status: 'idle' })
      await onSaved()
      return true
    }
    setState({ status: 'error', message: outcome.message, retry: outcome.written === 'unknown' })
    return false
  }

  return {
    state,
    /** Sends a new write, under the rid of an earlier attempt whose outcome is unknown. */
    send: (draft: Draft) => {
      const body = { ...draft, rid: pending.current?.rid ?? newRid() } as UserWrite
      pending.current = body
      return attempt(body)
    },
    /** Resends the unconfirmed write exactly as it was sent. */
    retry: () => (pending.current ? attempt(pending.current) : Promise.resolve(false)),
  }
}
