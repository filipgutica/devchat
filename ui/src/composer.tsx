import { Button } from '@ui-sdk/react/button'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './icons.tsx'
import type { WriteState } from './use-write.ts'

type ComposerProps = {
  /** Names the field for where the text goes, such as "New todo in #global". */
  label: string
  /** What the reader should know before sending, such as "Waiting for the agent."; none by default. */
  hint?: string
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
  /** Set after the board confirms this composer's write, and cleared once the user types again (§12). */
  const [saved, setSaved] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const busy = write.state.status === 'busy'
  const error = write.state.status === 'error' ? write.state : null
  const shownHint = offline ? offlineHint : [saved && 'Saved to the board.', hint].filter(Boolean).join(' ')

  /** The text of the last send, which Retry resends whatever the field holds now. */
  const sent = useRef('')

  async function send() {
    if (busy || offline || text.trim() === '') return
    sent.current = text
    if (await onSend(text)) {
      setText('')
      setSaved(true)
    }
    field.current?.focus()
  }

  async function retry() {
    // Clear the field only if it still holds what was sent: an edit made since stays.
    if (await write.retry()) {
      setText((current) => (current === sent.current ? '' : current))
      setSaved(true)
    }
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
          aria-describedby={shownHint ? `${id}-hint` : undefined}
          aria-invalid={error ? 'true' : undefined}
          aria-errormessage={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setText(event.target.value)
            setSaved(false)
          }}
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
      {shownHint && <p className="composer-hint" id={`${id}-hint`}>{shownHint}</p>}
    </div>
  )
}
