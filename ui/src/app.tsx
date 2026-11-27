import { Input } from '@ui-sdk/react/input'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { read, readChannel, readThread, Unreachable, type NeedsYou, type Thread, type ThreadSummary } from './api.ts'
import { channelName, clock } from './format.ts'
import { Icon, IconSprite } from './icons.tsx'
import { parseRoute, routeHref, type Route, type View } from './route.ts'
import { ThreadPane } from './thread-pane.tsx'
import { ChannelView, NeedsYouView, SearchView } from './views.tsx'

/** The open page reads the board again this often (§12); nothing uses watchers. */
const pollMs = 15_000

/** A view's list identity: a list read for one view never shows under another. */
const viewKey = (view: View) => JSON.stringify(view)

async function readList(view: View): Promise<ThreadSummary[] | null> {
  if (view.kind === 'needs-you') return null
  if (view.kind === 'channel') return readChannel(view)
  if (!view.q) return []
  return (await read<{ threads: ThreadSummary[] }>(`search?q=${encodeURIComponent(view.q)}`)).threads
}

/**
 * The devchat web UI (§12): Needs you, the channels with their Todos and Work tabs, search, and the
 * thread pane. It polls every 15 s. When the host can't be reached it says so, keeps what it has
 * shown, and queues nothing.
 */
export function App() {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  const [needsYou, setNeedsYou] = useState<NeedsYou>()
  const [repos, setRepos] = useState<string[]>([])
  const [list, setList] = useState<{ key: string; threads: ThreadSummary[] | null }>()
  const [thread, setThread] = useState<{ rid: string; value: Thread | null }>()
  const [offline, setOffline] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [query, setQuery] = useState(route.view.kind === 'search' ? route.view.q : '')
  const routeRef = useRef(route)
  routeRef.current = route
  const latest = useRef(0)
  const opener = useRef<HTMLElement | null>(null)

  const refresh = useCallback(async () => {
    const asked = routeRef.current
    const run = ++latest.current
    try {
      const [needs, channels, threads, opened] = await Promise.all([
        read<NeedsYou>('needs-you'),
        read<{ repos: string[] }>('channels'),
        readList(asked.view),
        asked.thread ? readThread(asked.thread) : Promise.resolve(undefined),
      ])
      // A newer read started meanwhile: its answer is the one to show.
      if (run !== latest.current) return
      setNeedsYou(needs)
      setRepos(channels.repos)
      setList({ key: viewKey(asked.view), threads })
      setThread(asked.thread && opened !== undefined ? { rid: asked.thread, value: opened } : undefined)
      setOffline(false)
      setReadError(null)
      setLoadedAt(new Date().toISOString())
    } catch (error) {
      if (run !== latest.current) return
      if (error instanceof Unreachable) setOffline(true)
      else setReadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Read now on every route change, then every 15 s, and again when the browser goes on or off line
  // or the tab comes back into view.
  useEffect(() => void refresh(), [route, refresh])
  useEffect(() => {
    const timer = setInterval(() => void refresh(), pollMs)
    const onVisible = () => document.visibilityState === 'visible' && void refresh()
    const onNetwork = () => void refresh()
    window.addEventListener('online', onNetwork)
    window.addEventListener('offline', onNetwork)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', onNetwork)
      window.removeEventListener('offline', onNetwork)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  const navigate = useCallback((next: Route) => {
    location.hash = routeHref(next)
  }, [])

  const onSaved = useCallback(async (message: string) => {
    await refresh()
    // The same words twice in a row would not be announced again.
    setAnnouncement((current) => (current === message ? `${message} ` : message))
  }, [refresh])

  function closeThread() {
    location.hash = routeHref({ view: route.view, thread: null })
    // Closing returns focus to what opened the thread, or to the view's heading.
    requestAnimationFrame(() => {
      const back = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('main h1')
      back?.focus()
      opener.current = null
    })
  }

  // Remember the link that opened a thread, so closing it can return focus there.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href*="thread="]') : null
      if (link instanceof HTMLElement) opener.current = link
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  function onSearch(event: FormEvent) {
    event.preventDefault()
    const q = query.trim()
    if (q) navigate({ view: { kind: 'search', q }, thread: null })
  }

  const { view } = route
  const threads = list?.key === viewKey(view) ? list.threads ?? undefined : undefined
  const shared = { route, repos, navigate }
  const channelRoute = (repo: string | null): Route => ({ view: { kind: 'channel', repo, tab: view.kind === 'channel' ? view.tab : 'todos', resolved: false }, thread: null })
  const isChannel = (repo: string | null) => view.kind === 'channel' && view.repo === repo
  const waiting = needsYou?.open.length ?? 0

  return (
    <>
      <IconSprite />
      <a className="skip" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus() }}>Skip to content</a>
      <div className={route.thread ? 'shell has-thread' : 'shell'}>
        <aside className="sidebar" aria-label="devchat">
          <p className="app-name">devchat</p>
          <form role="search" className="search" onSubmit={onSearch}>
            <Icon name="search" />
            <Input type="search" data-size="sm" aria-label="Search todos and work" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </form>
          <nav className="navlist" aria-label="Views">
            <a href={routeHref({ view: { kind: 'needs-you' }, thread: null })} aria-current={view.kind === 'needs-you' ? 'page' : undefined}>
              Needs you{waiting > 0 && <span className="count">{waiting}</span>}
            </a>
          </nav>
          <nav className="navlist" aria-label="Channels">
            <span className="group-label">Channels</span>
            {[null, ...repos].map((repo) => (
              <a key={repo ?? '#global'} href={routeHref(channelRoute(repo))} aria-current={isChannel(repo) ? 'page' : undefined}>{channelName(repo, repos)}</a>
            ))}
          </nav>
        </aside>
        <main id="main" tabIndex={-1}>
          {offline && (
            <div className="alert warning" role="status">
              <Icon name="alert" />
              <p>Offline: devchat can't be reached. {loadedAt ? `Showing what loaded at ${clock(loadedAt)}. ` : ''}It checks again every 15 seconds.</p>
            </div>
          )}
          {readError && !offline && <div className="alert danger" role="alert"><Icon name="alert" /><p>{readError}</p></div>}
          {view.kind === 'needs-you' && <NeedsYouView {...shared} data={needsYou} />}
          {view.kind === 'channel' && <ChannelView {...shared} view={view} threads={threads} offline={offline} onSaved={onSaved} />}
          {view.kind === 'search' && <SearchView {...shared} q={view.q} threads={threads} />}
        </main>
        {route.thread && (
          <ThreadPane key={route.thread} rid={route.thread} repos={repos} offline={offline} onClose={closeThread} onSaved={onSaved}
            thread={thread?.rid === route.thread ? thread.value : undefined} />
        )}
      </div>
      <p className="sr-only" role="status">{announcement}</p>
    </>
  )
}
