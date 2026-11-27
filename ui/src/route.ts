import type { Tab } from './api.ts'

export type View =
  | { kind: 'needs-you' }
  | { kind: 'channel'; repo: string | null; tab: Tab; resolved: boolean }
  | { kind: 'search'; q: string }

/** The page's state, kept in the URL hash so a link or a reload opens the same view and thread. */
export type Route = { view: View; thread: string | null }

/** `#/needs-you`, `#/global`, `#/repo/<owner>/<repo>`, or `#/search`, with `tab`, `resolved`, `q`, and `thread`. */
export function parseRoute(hash: string): Route {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?')
  const query = new URLSearchParams(search)
  const thread = query.get('thread')
  const tab: Tab = query.get('tab') === 'work' ? 'work' : 'todos'
  const resolved = query.get('resolved') === '1'
  const repo = /^\/repo\/([^/]+\/[^/]+)$/.exec(path)?.[1]
  const view: View = path === '/global' ? { kind: 'channel', repo: null, tab, resolved }
    : repo ? { kind: 'channel', repo: decodeURIComponent(repo), tab, resolved }
    : path === '/search' ? { kind: 'search', q: query.get('q') ?? '' }
    : { kind: 'needs-you' }
  return { view, thread }
}

export function routeHref({ view, thread }: Route) {
  const query = new URLSearchParams()
  let path = '/needs-you'
  if (view.kind === 'channel') {
    path = view.repo ? `/repo/${view.repo}` : '/global'
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
