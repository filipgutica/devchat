import { Button } from '@ui-sdk/react/button'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { newRid, type Message, type Thread } from './api.ts'
import { attemptWrite, readComposer, stamp, updateComposer, useComposerState, type PendingWrite } from './composer-store.ts'
import { Composer, type Question } from './composer.tsx'
import { byOf, channelName, replyCount } from './format.ts'
import { Icon } from './icons.tsx'
import { MessageRow, MessageStream, type RowStatus } from './message.tsx'
import { ThreadRefs } from './refs.tsx'

type ThreadPaneProps = {
  rid: string
  /** The thread as last read; undefined while the first read runs, null when the board has no such thread. */
  thread: Thread | null | undefined
  /** The `stamp` of the finish of the read that gave `thread`; 0 before one. */
  readAt: number
  repos: string[]
  offline: boolean
  onClose: () => void
  /** Reads the board again after a write and announces it. */
  onSaved: (announcement: string) => Promise<void>
}

const isResolved = (status: string | undefined) => status === 'done' || status === 'dropped'

/** The thread's state badge (components.md, Thread panel): only the exceptions get one. */
function StateBadge({ labels }: { labels: Record<string, string> }) {
  if (labels.status === 'done') return <span className="badge success">Done</span>
  if (labels.status === 'dropped') return <span className="badge">Dropped</span>
  if (labels.ask !== 'open') return null
  return labels.status === 'blocked' ? <span className="badge warning">Blocked</span> : <span className="badge info">Needs you</span>
}

/** A reply's status: the question that waits for the reader, or the post that resolved the thread. */
function replyStatus(reply: Message, root: Message): RowStatus | undefined {
  const kind = reply.labels.kind
  if (kind === 'done') return { kind: 'resolved' }
  if (kind === 'drop') return { kind: 'dropped' }
  if (kind === 'ask' && root.labels.ask === 'open' && root.labels.turn === reply.labels.rid) {
    return reply.labels.block === '1' ? { kind: 'blocked' } : { kind: 'asks' }
  }
  return undefined
}

const minWidth = 20
const defaultWidth = 26
/** The widest the pane may be, in rem: 40, and never so wide that the channel beside it drops below 16rem. */
const maxWidth = () => Math.max(minWidth, Math.min(40, Math.floor(window.innerWidth / 16 - 15 - 16)))
const clampWidth = (rem: number) => Math.min(maxWidth(), Math.max(minWidth, rem))

/** The pane's start edge (components.md, Thread panel): Left Arrow widens it by 1rem, Right Arrow narrows it, and a drag sets it. */
function PaneResize({ width, onWidth }: { width: number; onWidth: (rem: number) => void }) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    onWidth(clampWidth(width + step))
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const rem = (window.innerWidth - event.clientX) / parseFloat(getComputedStyle(document.documentElement).fontSize)
    onWidth(clampWidth(Math.round(rem)))
  }
  return (
    <div
      className="pane-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize thread panel"
      aria-controls="thread-pane"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth()}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={onPointerMove}
    />
  )
}

/**
 * The composer's name and hint: it answers the agent while a question waits, and its hint says
 * what a reply does (§12, "Honest delivery text").
 */
function composerWording({ root, replies }: Thread) {
  const { ask, status, turn } = root.labels
  const lastAgent = [root, ...replies].reverse().find((post) => byOf(post) !== 'user')
  const label = !lastAgent ? 'Reply in this thread' : ask === 'open' ? `Answer ${byOf(lastAgent)}` : `Reply to ${byOf(lastAgent)}`
  const hint = isResolved(status) ? 'A reply reopens the thread.' : ask === 'answered' ? 'Waiting for the agent.' : undefined
  // While a question waits, a reply answers it: `re` names the post `turn` names (§2, DC-40).
  const asked = ask === 'open' && turn ? replies.find((reply) => reply.labels.rid === turn) : undefined
  const question: Question | undefined = asked && turn ? { rid: turn, text: asked.text } : undefined
  return { label, hint, question }
}

/**
 * The open thread beside its channel (components.md, Thread panel): the root and its replies,
 * Resolve while it is open, and, under a work item, a composer for the user's answer.
 */
export function ThreadPane({ rid, thread, readAt, repos, offline, onClose, onSaved }: ThreadPaneProps) {
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const resolveButton = useRef<HTMLButtonElement>(null)
  const [width, setWidth] = useState(defaultWidth)
  const resolveKey = `resolve:${rid}`
  const { status: resolveStatus, pending: resolvePending } = useComposerState(resolveKey)

  // Opening a thread moves focus to the pane's heading.
  useEffect(() => heading.current?.focus(), [rid])

  const root = thread?.root
  const labels = root?.labels ?? {}
  const resolved = isResolved(labels.status)
  const resolveError = resolveStatus.status === 'error' ? resolveStatus : null
  const resolving = resolveStatus.status === 'busy'
  // After a confirmed resolve, Resolve stays locked until a read of this thread finishes after it,
  // whatever that read shows, so a second click before the pane catches up writes nothing.
  const resolveLocked = resolving || resolvePending !== null || (resolveStatus.status === 'saved' && readAt <= resolveStatus.stamp)

  async function sendResolve(write: PendingWrite) {
    const confirmed = await attemptWrite(resolveKey, write, () => ({ status: { status: 'saved', stamp: stamp() } }))
    if (confirmed) void onSaved('Thread resolved')
    // Resolve removes itself, so focus moves to the heading; a refusal returns it to Resolve.
    if (confirmed) heading.current?.focus()
    else resolveButton.current?.focus()
  }

  function onResolve() {
    if (resolveLocked || readComposer(resolveKey).status.status === 'busy') return
    const write: PendingWrite = Object.freeze({ text: '', body: Object.freeze({ kind: 'done', root: rid, rid: newRid() } as const) })
    updateComposer(resolveKey, () => ({ pending: write }))
    void sendResolve(write)
  }

  function retryResolve() {
    const { pending, status } = readComposer(resolveKey)
    if (pending && status.status !== 'busy') void sendResolve(pending)
  }

  function discardResolve() {
    updateComposer(resolveKey, () => ({ pending: null, status: { status: 'idle' } }))
    resolveButton.current?.focus()
  }


  const replies = thread?.replies ?? []

  return (
    <aside className="thread-pane" id="thread-pane" aria-labelledby={headingId} style={{ width: `${width}rem` }}>
      <PaneResize width={width} onWidth={setWidth} />
      <div className="pane-head">
        {/* On a phone the thread replaces the list, so Back takes the place of Close. */}
        <Button className="pane-back" data-variant="ghost" data-size="sm" onClick={onClose}>Back</Button>
        <h4 id={headingId} ref={heading} tabIndex={-1}>
          Thread <span>{root ? `${channelName(labels.repo, repos)} · ${root.channel === 'work' ? 'Work item' : 'Todo'}` : ''}</span>
        </h4>
        {root && <StateBadge labels={labels} />}
        {root && !resolved && (
          <Button ref={resolveButton} data-variant="secondary" data-size="sm" aria-busy={resolving ? 'true' : undefined}
            disabled={offline || resolveLocked} onClick={onResolve}>
            Resolve
          </Button>
        )}
        <Button className="pane-close" data-variant="ghost" data-size="sm" data-icon-only aria-label="Close thread" onClick={onClose}>
          <Icon name="close" />
        </Button>
      </div>
      <div className="pane-body">
        {resolveError && (
          <div className="alert danger" role="alert">
            <Icon name="alert" />
            <div className="alert-body">
              <p>{resolveError.message}</p>
              {/* An unconfirmed resolve is retried or discarded; Resolve stays locked until then. */}
              {resolveError.retry && resolvePending && (
                <p className="alert-actions">
                  <Button data-variant="text" data-size="sm" disabled={offline} onClick={retryResolve}>Retry</Button>
                  <Button data-variant="text" data-size="sm" onClick={discardResolve}>Discard</Button>
                </p>
              )}
            </div>
          </div>
        )}
        {thread === undefined && <p className="quiet">Loading the thread…</p>}
        {thread === null && <p className="quiet">This thread isn't on the board.</p>}
        {root && (
          <>
            <ol className="stream" aria-label="Thread root">
              <MessageRow by={byOf(root)} at={root.createdAt}><p>{root.text}</p><ThreadRefs root={root} /></MessageRow>
            </ol>
            <p className="reply-count">{replies.length === 0 ? 'No replies' : replyCount(replies.length)}</p>
            <MessageStream label="Replies" since={root.createdAt} items={replies.map((reply) => {
              const status = replyStatus(reply, root)
              const resolution = reply.labels.kind === 'done' || reply.labels.kind === 'drop'
              return {
                key: reply.id, by: byOf(reply), at: reply.createdAt, status,
                row: (cont: boolean) => (
                  <MessageRow key={reply.id} by={byOf(reply)} at={reply.createdAt} cont={cont} status={status}>
                    {/* A resolution posted from a button has no body. */}
                    {!resolution && <p>{reply.text}</p>}
                  </MessageRow>
                ),
              }
            })} />
          </>
        )}
      </div>
      {thread?.root.channel === 'work' && (
        <Composer storeKey={`thread:${rid}`} {...composerWording(thread)} offline={offline} onSaved={() => onSaved('Saved to the board')}
          toDraft={(text, re) => ({ kind: 'answer', root: rid, text, ...(re ? { re } : {}) })} />
      )}
    </aside>
  )
}

