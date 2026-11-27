import { Button } from '@ui-sdk/react/button'
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { UserWrite } from '../../src/shared/layout.ts'
import { newRid, sendWrite, type Draft } from './api.ts'
import { Icon } from './icons.tsx'

/** The question a reply answers now: the post `turn` names while `ask=open`. */
export type Question = { rid: string; text: string }

type ComposerProps = {
  /** Names the field for where the text goes, such as "New todo in #global". */
  label: string
  /** What the reader should know before sending, such as "Waiting for the agent."; none by default. */
  hint?: string | undefined
  offline: boolean
  /** The write a draft stands for, given the question it answers (`re`), if any. */
  toDraft: (text: string, re: string | undefined) => Draft
  /** In a thread: the question that waits now. A draft binds to the one it started under. */
  question?: Question | undefined
  /** Runs after the board confirms a write: reads the board again. Sending does not wait for it. */
  onSaved: () => Promise<void>
}

/**
 * A write this composer sent whose outcome it has not learned yet. It is immutable: a retry resends
 * exactly this rid and body (D4), and a changed draft never takes its rid.
 */
type PendingWrite = Readonly<{ text: string; body: Readonly<UserWrite> }>

type Status =
  | { status: 'idle' }
  | { status: 'busy' }
  /** `retry` is set while the outcome is unknown: the pending write can only be resent or discarded. */
  | { status: 'error'; message: string; retry: boolean }

const offlineHint = "Offline: devchat can't be reached. Sending comes back when it can."
const blockedByPending = 'Not sent: the earlier text may already be on the board. Retry it, or discard it to send this text.'

/**
 * One auto-growing field with an inline send button and a hint (components.md, Composer). Enter
 * sends and Shift+Enter starts a new line. It owns its writes under the D4 contract: each send makes
 * one immutable pending write, which stays until the board answers for it; Send stays locked from the
 * click until the confirmed draft is cleared; and a reply bound to one question is never sent as the
 * answer to another without the user's say-so.
 */
export function Composer({ label, hint, offline, toDraft, question, onSaved }: ComposerProps) {
  const id = useId()
  const [text, setText] = useState('')
  /** The question the draft started under: a reply answers what the user saw while writing it. */
  const [bound, setBound] = useState<{ rid: string | undefined } | null>(null)
  const [status, setStatus] = useState<Status>({ status: 'idle' })
  /** Set after the board confirms this composer's write, and cleared once the user types again (§12). */
  const [saved, setSaved] = useState(false)
  const pending = useRef<PendingWrite | null>(null)
  /** Held from a send's click until the render that follows its answer, so one draft sends once. */
  const locked = useRef(false)
  const field = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    if (status.status !== 'busy') locked.current = false
  }, [status])

  const busy = status.status === 'busy'
  const error = status.status === 'error' ? status : null
  const hasDraft = text.trim() !== ''
  // The question changed since the draft started: a new one arrived, or the one it answers closed.
  // Not while this draft is in flight: a read can show its own answer before the board confirms it.
  const moved = !busy && hasDraft && bound !== null && bound.rid !== question?.rid
  const shownHint = offline ? offlineHint : [saved && 'Saved to the board.', hint].filter(Boolean).join(' ')

  async function attempt(write: PendingWrite) {
    locked.current = true
    setStatus({ status: 'busy' })
    const outcome = await sendWrite(write.body)
    if (outcome.ok || outcome.written === false) pending.current = null
    if (!outcome.ok) {
      setStatus({ status: 'error', message: outcome.message, retry: outcome.written === 'unknown' })
      return
    }
    // Clear the confirmed draft in the same render that ends the busy state, so Send can't resend it.
    setText((current) => (current === write.text ? '' : current))
    setBound(null)
    setSaved(true)
    setStatus({ status: 'idle' })
    field.current?.focus()
    void onSaved()
  }

  function send() {
    if (locked.current || offline || !hasDraft) return
    const earlier = pending.current
    // Enter on the unchanged text of an unconfirmed write is its retry.
    if (earlier) {
      if (earlier.text === text) return void attempt(earlier)
      return setStatus({ status: 'error', message: blockedByPending, retry: true })
    }
    if (moved) return
    const re = bound ? bound.rid : question?.rid
    const write: PendingWrite = Object.freeze({ text, body: Object.freeze({ ...toDraft(text, re), rid: newRid() } as UserWrite) })
    pending.current = write
    void attempt(write)
  }

  function retry() {
    if (pending.current && !locked.current) void attempt(pending.current)
  }

  function discard() {
    pending.current = null
    setStatus({ status: 'idle' })
    field.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    send()
  }

  return (
    <div className="composer">
      <label className="sr-only" htmlFor={`${id}-field`}>{label}</label>
      <div className="composer-box">
        <textarea
          ref={field}
          id={`${id}-field`}
          rows={1}
          placeholder={label}
          value={text}
          readOnly={busy}
          disabled={offline}
          aria-describedby={[moved && `${id}-moved`, shownHint && `${id}-hint`].filter(Boolean).join(' ') || undefined}
          aria-invalid={error ? 'true' : undefined}
          aria-errormessage={error ? `${id}-error` : undefined}
          onChange={(event) => {
            const next = event.target.value
            setText(next)
            setSaved(false)
            // A new draft binds to the question in view; an emptied one lets go.
            if (next.trim() === '') setBound(null)
            else if (!bound) setBound({ rid: question?.rid })
          }}
          onKeyDown={onKeyDown}
        />
        <Button data-size="sm" data-icon-only aria-label="Send" aria-busy={busy ? 'true' : undefined} disabled={offline || busy || moved} onClick={send}>
          <Icon name="send" />
        </Button>
      </div>
      {moved && (
        <div className="composer-note" id={`${id}-moved`}>
          <p>{question ? `A new question arrived: “${question.text}” Your reply is kept.` : 'The question you were answering is no longer open. Your reply is kept.'}</p>
          <Button data-variant="text" data-size="sm" onClick={() => setBound({ rid: question?.rid })}>
            {question ? 'Answer this question' : 'Send as a reply'}
          </Button>
        </div>
      )}
      {error && (
        <div className="composer-note">
          <p className="field-error" id={`${id}-error`}>{error.message}</p>
          {error.retry && (
            <>
              <Button data-variant="text" data-size="sm" disabled={offline || busy} onClick={retry}>Retry</Button>
              <Button data-variant="text" data-size="sm" disabled={busy} onClick={discard}>Discard</Button>
            </>
          )}
        </div>
      )}
      {shownHint && <p className="composer-hint" id={`${id}-hint`}>{shownHint}</p>}
    </div>
  )
}
