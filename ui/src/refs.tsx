import { isGithubRepo } from '../../src/shared/github.ts'
import type { Message } from './api.ts'

/** A reference the thread shows: its words, and a link only when the value checked out as safe. */
type Ref = { key: string; text: string; href: string | null }

/** An agent wrote these labels, so a value is a link only as an http(s) URL; anything else stays text. */
function webUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

const number = /^[1-9][0-9]{0,9}$/

/** `owner/repo#n`, or `#n` on the item's repo, links to that GitHub issue; a URL links as itself. */
function issueHref(value: string, repo: string | null) {
  const match = /^(?:([^#\s]+))?#([0-9]+)$/.exec(value)
  const target = match ? match[1] ?? repo : null
  if (match && target && isGithubRepo(target) && number.test(match[2]!)) return `https://github.com/${target}/issues/${match[2]}`
  return webUrl(value)
}

/**
 * The work item's issue, pull requests (`pr.<n>`), and source thread (§2), as the root's labels give
 * them. A pull request links on the item's GitHub repo, else by its URL; the thread ref is text
 * unless it is a URL.
 */
export function threadRefs(root: Message): Ref[] {
  const { labels } = root
  const repo = labels.repo && isGithubRepo(labels.repo) ? labels.repo : null
  const refs: Ref[] = []
  if (labels.issue) refs.push({ key: 'issue', text: `Issue ${labels.issue}`, href: issueHref(labels.issue, repo) })
  const prs = Object.keys(labels).flatMap((key) => {
    const n = /^pr\.(.+)$/.exec(key)?.[1]
    return n === undefined ? [] : [n]
  }).sort((a, b) => Number(a) - Number(b))
  for (const n of prs) {
    const valid = number.test(n)
    const href = valid && repo ? `https://github.com/${repo}/pull/${n}` : webUrl(labels[`pr.${n}`] ?? '')
    refs.push({ key: `pr.${n}`, text: valid ? `PR #${n}` : `PR ${n}`, href })
  }
  if (labels.thread) refs.push({ key: 'thread', text: `From thread ${labels.thread}`, href: webUrl(labels.thread) })
  return refs
}

/** The root's references as a message's links line; nothing when it has none. */
export function ThreadRefs({ root }: { root: Message }) {
  const refs = threadRefs(root)
  if (refs.length === 0) return null
  return (
    <p className="msg-links">
      {refs.map(({ key, text, href }) => href
        ? <a key={key} href={href} target="_blank" rel="noreferrer">{text}</a>
        : <span key={key}>{text}</span>)}
    </p>
  )
}
