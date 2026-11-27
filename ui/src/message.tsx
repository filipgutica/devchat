import type { ReactNode } from 'react'
import { Icon } from './icons.tsx'
import { authorName, clock, dayLabel, initials, isAgent, when } from './format.ts'

/** The Needs you tag, or the resolution note, in a message row's header (components.md, Message row). */
export type RowStatus =
  | { kind: 'asks' }
  | { kind: 'blocked' }
  | { kind: 'resolved' | 'dropped'; by?: string }

function StatusTag({ status }: { status: RowStatus }) {
  if (status.kind === 'asks') return <span className="tag">Asks you</span>
  if (status.kind === 'blocked') return <span className="tag warning">Blocked on you</span>
  // A list of resolved roots names the resolver; the resolving post itself is by the resolver.
  const verb = status.kind === 'resolved' ? 'Resolved' : 'Dropped'
  const text = status.by ? `${verb} by ${authorName(status.by)}` : `${verb} the thread`
  return <span className="tag resolved">{status.kind === 'resolved' && <Icon name="check" />}{text}</span>
}

type RowProps = {
  by: string
  at: string
  /** A continuation row in its group: no avatar or header. */
  cont?: boolean
  /** The open thread's message. */
  current?: boolean
  status?: RowStatus | undefined
  children?: ReactNode
}

/** One message: a flat row with the avatar, the header line, and the body (components.md, Message row). */
export function MessageRow({ by, at, cont = false, current = false, status, children }: RowProps) {
  const name = authorName(by)
  const agent = isAgent(by)
  return (
    <li className={cont ? 'msg cont' : 'msg'} aria-current={current ? 'true' : undefined}>
      {cont
        ? <span className="gutter" aria-hidden="true">{clock(at)}</span>
        : <span className="avatar" aria-hidden="true">{initials(name)}</span>}
      <div>
        {cont ? <span className="sr-only">{name}, {when(at)}</span> : (
          <div className="msg-head">
            <span className={agent ? 'author agent' : 'author'}>{name}</span>
            {agent && <span className="badge">Agent</span>}
            {status && <StatusTag status={status} />}
            <time dateTime={at}>{when(at)}</time>
          </div>
        )}
        {children && <div className="msg-body">{children}</div>}
      </div>
    </li>
  )
}

export type StreamItem = {
  key: string
  by: string
  at: string
  /** A row with a status starts a group: its header holds the status. */
  status?: RowStatus | undefined
  row: (cont: boolean) => ReactNode
}

const groupGap = 5 * 60_000

/**
 * Message rows in groups (components.md, Message group): one author's consecutive messages within
 * about 5 minutes, split by day dividers and by a message with a status.
 */
export function MessageStream({ label, items, since }: { label: string; items: StreamItem[]; since?: string | undefined }) {
  const rows: ReactNode[] = []
  let previous: StreamItem | undefined
  for (const item of items) {
    // `since` is the time of the post shown just above this list, such as a thread's root.
    const before = previous?.at ?? since
    const newDay = !before || dayLabel(before) !== dayLabel(item.at)
    if (newDay) rows.push(<li className="day" key={`day:${item.key}`}>{dayLabel(item.at)}</li>)
    const cont = !newDay && previous?.by === item.by && !item.status
      && Date.parse(item.at) - Date.parse(previous.at) < groupGap
    rows.push(item.row(cont))
    previous = item
  }
  return <ol className="stream" aria-label={label}>{rows}</ol>
}
