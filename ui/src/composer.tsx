import { Button } from '@ui-sdk/react/button'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import type { UserWrite } from '../../src/shared/layout.ts'
import { newRid, sendWrite, type Draft } from './api.ts'
import { readComposer, updateComposer, useComposerState, type ComposerState, type PendingWrite } from './composer-store.ts'
import { Icon } from './icons.tsx'

/** The question a reply answers now: the post `turn` names while `ask=open`. */
export type Question = { rid: string; text: string }

type ComposerProps = {
  /** Where this composer's draft and write live: a channel tab or a thread, stable across visits. */
  storeKey: string
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

const offlineHint = "Offline: devchat can't be reached. Sending comes back when it can."
const blockedByPending = 'Not sent: the earlier text may already be on the board. Retry it, or discard it to send this text.'

/**
 * One auto-growing field with an inline send button and a hint (components.md, Composer). Enter
 * sends and Shift+Enter starts a new line. It owns its writes under the D4 contract: each send makes
 * one immutable pending write, which stays until the board answers for it or the user discards it,
 * even if the composer closes meanwhile; Send stays locked from the click until the confirmed draft
 * is cleared; and a reply bound to one question is never sent as the answer to another without the
 * user's say-so.
 */
export function Composer({ storeKey, label, hint, offline, toDraft, question, onSaved }: ComposerProps) {
  const id = useId()
  const { text, bound, status, pending } = useComposerState(storeKey)
  /** Set after the board confirms this composer's write, and cleared once the user types again (§12). */
  const [saved, setSaved] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const update = (change: (state: ComposerState) => Partial<ComposerState>) => updateComposer(storeKey, change)

  const busy = status.status === 'busy'
  const error = status.status === 'error' ? status : null
  const hasDraft = text.trim() !== ''
  // The question changed since the draft started: a new one arrived, or the one it answers closed.
  // Not while this draft is in flight: a read can show its own answer before the board confirms it.
  const moved = !busy && hasDraft && bound !== null && bound.rid !== question?.rid
  const shownHint = offline ? offlineHint : [saved && 'Saved to the board.', hint].filter(Boolean).join(' ')

  async function attempt(write: PendingWrite) {
    update(() => ({ status: { status: 'busy' } }))
    const outcome = await sendWrite(write.body)
    if (!outcome.ok) {
      // Only an answer that proves this rid's fate drops the pending write; otherwise only Retry or
      // Discard moves past it.
      update(() => ({
        status: { status: 'error', message: outcome.message, retry: !outcome.settled },
        ...(outcome.settled ? { pending: null } : {}),
      }))
      return
    }
    // One change clears the confirmed draft and ends the busy state, so Send can't resend it. A draft
    // edited since keeps its text and the question it is bound to.
    update((current) => ({
      pending: null,
      status: { status: 'idle' },
      ...(current.text === write.text ? { text: '', bound: null } : {}),
    }))
    setSaved(true)
    field.current?.focus()
    void onSaved()
  }

  function send() {
    const current = readComposer(storeKey)
    if (current.status.status === 'busy' || offline || !hasDraft) return
    // Nothing new is sent past an unconfirmed write: the user retries or discards it first.
    if (current.pending) {
      if (current.pending.text !== text) update(() => ({ status: { status: 'error', message: blockedByPending, retry: true } }))
      return
    }
    if (moved) return
    const re = bound ? bound.rid : question?.rid
    const write: PendingWrite = Object.freeze({ text, body: Object.freeze({ ...toDraft(text, re), rid: newRid() } as UserWrite) })
    update(() => ({ pending: write }))
    void attempt(write)
  }

  function retry() {
    const { pending, status: now } = readComposer(storeKey)
    if (pending && now.status !== 'busy') void attempt(pending)
  }

  function discard() {
    update(() => ({ pending: null, status: { status: 'idle' } }))
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
            setSaved(false)
            // A new draft binds to the question in view; an emptied one lets go.
            update((current) => ({
              text: next,
              bound: next.trim() === '' ? null : current.bound ?? { rid: question?.rid },
            }))
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
          {/* An unconfirmed write keeps the draft on its question until it is retried or discarded. */}
          {!pending && (
            <Button data-variant="text" data-size="sm" onClick={() => update((current) => (current.pending ? {} : { bound: { rid: question?.rid } }))}>
              {question ? 'Answer this question' : 'Send as a reply'}
            </Button>
          )}
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
