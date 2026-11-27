import { Button } from '@ui-sdk/react/button'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './icons.tsx'
import type { WriteState } from './use-write.ts'

type ComposerProps = {
  /** Names the field for where the text goes, such as "New todo in #global". */
  label: string
  /** Says what happens after sending. */
  hint: string
  offline: boolean
  write: { state: WriteState; retry: () => Promise<boolean> }
  /** Sends the text; resolves true once the board has it. */
  onSend: (text: string) => Promise<boolean>
}

const offlineHint = "Offline: devchat can't be reached. Sending comes back when it can."

/**
 * One auto-growing field with an inline send button and a hint (components.md, Composer). Enter
 * sends and Shift+Enter starts a new line. The text stays until the board has it, and a refusal
 * keeps it with the reason.
 */
export function Composer({ label, hint, offline, write, onSend }: ComposerProps) {
  const id = useId()
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const busy = write.state.status === 'busy'
  const error = write.state.status === 'error' ? write.state : null

  async function send() {
    if (busy || offline || text.trim() === '') return
    if (await onSend(text)) setText('')
    field.current?.focus()
  }

  async function retry() {
    if (await write.retry()) setText('')
    field.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
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
          aria-describedby={`${id}-hint`}
          aria-invalid={error ? 'true' : undefined}
          aria-errormessage={error ? `${id}-error` : undefined}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button data-size="sm" data-icon-only aria-label="Send" aria-busy={busy ? 'true' : undefined} disabled={offline || busy} onClick={() => void send()}>
          <Icon name="send" />
        </Button>
      </div>
      {error && (
        <div className="composer-error">
          <p className="field-error" id={`${id}-error`}>{error.message}</p>
          {error.retry && <Button data-variant="text" data-size="sm" disabled={offline || busy} onClick={() => void retry()}>Retry</Button>}
        </div>
      )}
      <p className="composer-hint" id={`${id}-hint`}>{offline ? offlineHint : hint}</p>
    </div>
  )
}
