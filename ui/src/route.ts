import type { Tab } from './api.ts'

export type View =
  | { kind: 'needs-you' }
  | { kind: 'channel'; repo: string | null; tab: Tab; resolved: boolean }
  | { kind: 'search'; q: string }
  /** A hash this page can't read, such as a malformed escape. */
  | { kind: 'not-found' }

/** The page's state, kept in the URL hash so a link or a reload opens the same view and thread. */
export type Route = { view: View; thread: string | null }

/** A repo label in a path: each segment encoded, so `%`, `?`, or `#` in a name stays part of it. */
const repoPath = (repo: string) => repo.split('/').map(encodeURIComponent).join('/')

/**
 * `#/needs-you`, `#/global`, `#/repo/<owner>/<repo>`, or `#/search`, with `tab`, `resolved`, `q`, and
 * `thread`. A malformed repo path, such as a missing or empty segment or a bad escape, reads as not found.
 */
export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?')
  const query = new URLSearchParams(search)
  const thread = query.get('thread')
  const tab: Tab = query.get('tab') === 'work' ? 'work' : 'todos'
  const resolved = query.get('resolved') === '1'
  if (path === '/repo' || path.startsWith('/repo/')) {
    // A repo is `<owner>/<name>`: exactly two non-empty segments, neither of which decodes to hold a
    // `/`. Anything else, such as `/repo/example/` or `/repo/example/one%2Ftwo`, is not found.
    const [, owner, name] = /^\/repo\/([^/]+)\/([^/]+)$/.exec(path) ?? []
    try {
      const parts = owner && name ? [owner, name].map(decodeURIComponent) : []
      if (parts.length === 2 && parts.every((part) => part !== '' && !part.includes('/'))) {
        return { view: { kind: 'channel', repo: parts.join('/'), tab, resolved }, thread }
      }
    } catch {
      // A malformed escape, such as a lone `%`.
    }
    return { view: { kind: 'not-found' }, thread: null }
  }
  const view: View = path === '/global' ? { kind: 'channel', repo: null, tab, resolved }
    : path === '/search' ? { kind: 'search', q: query.get('q') ?? '' }
    : { kind: 'needs-you' }
  return { view, thread }
}

export function routeHref({ view, thread }: Route) {
  const query = new URLSearchParams()
  let path = '/needs-you'
  if (view.kind === 'channel') {
    path = view.repo ? `/repo/${repoPath(view.repo)}` : '/global'
    if (view.tab === 'work') query.set('tab', 'work')
    if (view.resolved) query.set('resolved', '1')
  } else if (view.kind === 'search') {
    path = '/search'
    query.set('q', view.q)
  }
  if (thread) query.set('thread', thread)
  const search = query.toString()
  return `#${path}${search ? `?${search}` : ''}`
}
