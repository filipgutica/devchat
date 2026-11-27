import { Button } from '@ui-sdk/react/button'
import { useState } from 'react'
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

/** A `pr.<n>` value that is a GitHub pull request URL for that same number: its repo, else null. */
const pullRequest = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/pull\/([0-9]+)\/?$/

function isUrl(value: string) {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/**
 * A pull request's words and link. A URL value links only as `https://github.com/<owner>/<repo>/pull/<n>`
 * with the label's own `<n>`, so a link never opens another number; a value that is not a URL links on
 * the item's GitHub repo. Anything else is text.
 */
function pullRequestRef(n: string, value: string, repo: string | null): Ref {
  const key = `pr.${n}`
  if (!number.test(n)) return { key, text: `PR ${n}`, href: null }
  if (!isUrl(value)) return { key, text: `PR #${n}`, href: repo ? `https://github.com/${repo}/pull/${n}` : null }
  const [, target, linked] = pullRequest.exec(value) ?? []
  if (!target || linked !== n || !isGithubRepo(target)) return { key, text: `PR #${n}`, href: null }
  return { key, text: target === repo ? `PR #${n}` : `PR ${target}#${n}`, href: `https://github.com/${target}/pull/${n}` }
}

/**
 * The work item's issue and pull requests (`pr.<n>`), as the root's labels give them (§2). The
 * source thread is shown apart: its label is a bare T3 Code thread ID, which no link can open.
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
  for (const n of prs) refs.push(pullRequestRef(n, labels[`pr.${n}`] ?? '', repo))
  return refs
}

/** Copies through the Clipboard API, or, where the page is not a secure context, the copy command. */
async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    const field = document.createElement('textarea')
    field.value = value
    field.setAttribute('readonly', '')
    field.className = 'sr-only'
    document.body.append(field)
    field.select()
    const copied = document.execCommand('copy')
    field.remove()
    return copied
  }
}

/** The source thread's ID as text, with a button that copies it to paste into T3 Code. */
function SourceThread({ id }: { id: string }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  return (
    <span className="source-thread">
      From thread {id}
      <Button data-variant="text" data-size="sm" onClick={async () => setCopied(await copyText(id))} onBlur={() => setCopied(null)}>
        {copied === null ? 'Copy ID' : copied ? 'Copied' : 'Copy failed'}
      </Button>
    </span>
  )
}

/** The root's references as a message's links line; nothing when it has none. */
export function ThreadRefs({ root }: { root: Message }) {
  const refs = threadRefs(root)
  const thread = root.labels.thread
  if (refs.length === 0 && !thread) return null
  return (
    <p className="msg-links">
      {refs.map(({ key, text, href }) => href
        ? <a key={key} href={href} target="_blank" rel="noreferrer">{text}</a>
        : <span key={key}>{text}</span>)}
      {thread && <SourceThread id={thread} />}
    </p>
  )
}
