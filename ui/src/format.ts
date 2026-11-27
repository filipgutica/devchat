import type { Message } from './api.ts'

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
const yesterday = () => new Date(Date.now() - 86_400_000)
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

export const clock = (iso: string) => clockFormat.format(new Date(iso))

/** A post's time: "Today 09:40", "Yesterday 09:40", or "20 Nov 09:40". */
export function when(iso: string) {
  const date = new Date(iso)
  const day = sameDay(date, new Date()) ? 'Today' : sameDay(date, yesterday()) ? 'Yesterday' : dateFormat.format(date)
  return `${day} ${clockFormat.format(date)}`
}

/** A day divider's label. */
export function dayLabel(iso: string) {
  const date = new Date(iso)
  return sameDay(date, new Date()) ? 'Today' : sameDay(date, yesterday()) ? 'Yesterday' : dayFormat.format(date)
}

/** The name a post shows: its profile, `by`, or "You" for the user's own. */
export const authorName = (by: string) => (by === 'user' ? 'You' : by)
export const isAgent = (by: string) => by !== 'user'
export const byOf = (message: Message) => message.labels.by ?? 'unknown'

/** Up to two initials: "desktop-claude" gives "DC", and "You" gives "Y". */
export const initials = (name: string) => name.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join('')

/**
 * A channel's name: `#global`, or `#<repo>` for a project channel, with its owner when another
 * owner has a repo of the same name.
 */
export function channelName(repo: string | undefined | null, repos: readonly string[]) {
  if (!repo) return '#global'
  const name = repo.split('/')[1] ?? repo
  return repos.some((other) => other !== repo && other.split('/')[1] === name) ? `#${repo}` : `#${name}`
}

/** A thread's first line, cut to a link's length. */
export function title(text: string) {
  const line = text.split('\n')[0]!.trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export const replyCount = (count: number) => (count === 0 ? 'Open thread' : count === 1 ? '1 reply' : `${count} replies`)
