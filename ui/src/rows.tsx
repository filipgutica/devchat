import type { Message, ThreadSummary } from './api.ts'
import { byOf, channelName, replyCount, title, when } from './format.ts'
import { MessageRow, type RowStatus, type StreamItem } from './message.tsx'

/** How a list shows a thread: which post stands for it, and what its links line says. */
export type RowMode = 'needs-you' | 'answered' | 'channel' | 'resolved' | 'search'

type ThreadItemOptions = {
  summary: ThreadSummary
  mode: RowMode
  repos: string[]
  /** The link that opens this thread in the pane, in the current view. */
  href: string
  current: boolean
}

const resolution = (last: Message | null) => (last && (last.labels.kind === 'done' || last.labels.kind === 'drop') ? last : null)

/** The tag a root's state gives its row: the Needs you tag, or, for a resolved root, who resolved it. */
function rootStatus({ message, last }: ThreadSummary): RowStatus | undefined {
  const { status, ask } = message.labels
  if (status === 'done' || status === 'dropped') {
    const by = resolution(last)?.labels.by
    return { kind: status === 'done' ? 'resolved' : 'dropped', ...(by ? { by } : {}) }
  }
  if (ask === 'open') return status === 'blocked' ? { kind: 'blocked' } : { kind: 'asks' }
  return undefined
}

/**
 * One thread as a message row in a list. In Needs you the row is the post that waits: the agent's
 * question, or under "You answered" the user's answer; elsewhere it is the root.
 */
export function threadItem({ summary, mode, repos, href, current }: ThreadItemOptions): StreamItem {
  const { message: root, last, replies } = summary
  const turnPost = last?.labels.rid === root.labels.turn ? last : null
  const shown = mode === 'needs-you' ? turnPost ?? root : mode === 'answered' ? last ?? root : root
  const status = mode === 'answered' ? undefined : rootStatus(summary)
  const resolvedBy = mode === 'resolved' || mode === 'search' ? resolution(last) : null
  const linkText = shown === root ? replyCount(replies) : title(root.text)
  return {
    key: root.id,
    by: byOf(shown),
    at: shown.createdAt,
    status,
    row: (cont) => (
      <MessageRow key={root.id} by={byOf(shown)} at={shown.createdAt} cont={cont} current={current} status={status}>
        <p>{shown.text}</p>
        <p className="msg-links">
          <a href={href}>{linkText}</a>
          {(mode === 'needs-you' || mode === 'answered' || mode === 'search') && <span>{channelName(root.labels.repo, repos)}</span>}
          {root.labels.ask === 'answered' && !resolvedBy && <span>Waiting for the agent</span>}
          {resolvedBy && (
            <span>{resolvedBy.labels.kind === 'done' ? 'Resolved' : 'Dropped'} <time dateTime={resolvedBy.createdAt}>{when(resolvedBy.createdAt)}</time></span>
          )}
        </p>
      </MessageRow>
    ),
  }
}

/** Oldest first, as a conversation reads. */
export const byTime = (a: StreamItem, b: StreamItem) => a.at.localeCompare(b.at)
