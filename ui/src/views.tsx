import { Switch, SwitchThumb } from '@ui-sdk/react/switch'
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs'
import { useLayoutEffect, useRef } from 'react'
import type { NeedsYou, Tab, ThreadSummary } from './api.ts'
import { Composer } from './composer.tsx'
import { channelName } from './format.ts'
import { MessageStream } from './message.tsx'
import { routeHref, type Route, type View } from './route.ts'
import { byTime, threadItem, type RowMode } from './rows.tsx'

type Shared = {
  route: Route
  repos: string[]
  navigate: (route: Route) => void
}

/** The rows of a list of threads, each linking to its thread in this view. */
function ThreadList({ label, threads, mode, route, repos }: Shared & { label: string; threads: ThreadSummary[]; mode: RowMode }) {
  const items = threads.map((summary) => {
    const rid = summary.message.labels.rid ?? ''
    return threadItem({ summary, mode, repos, href: routeHref({ view: route.view, thread: rid }), current: route.thread === rid })
  }).sort(byTime)
  return <MessageStream label={label} items={items} />
}

/**
 * Needs you (§12): open questions and blocked items, then the threads the user answered, which wait
 * for an agent. Release 1 has no coordinator, so the empty state is plain text.
 */
export function NeedsYouView({ data, ...shared }: Shared & { data: NeedsYou | undefined }) {
  return (
    <>
      <header className="toolbar"><h1>Needs you</h1></header>
      <div className="view-body">
        {!data && <p className="quiet">Loading…</p>}
        {data && data.open.length === 0 && (
          <p className="quiet">Nothing needs you. An agent's question or blocked work item shows here.</p>
        )}
        {data && data.open.length > 0 && <ThreadList {...shared} label="Needs you" threads={data.open} mode="needs-you" />}
        {data && data.answered.length > 0 && (
          <section className="list-section" aria-labelledby="answered-heading">
            <h2 id="answered-heading">You answered</h2>
            <ThreadList {...shared} label="You answered" threads={data.answered} mode="answered" />
          </section>
        )}
      </div>
    </>
  )
}

type ChannelViewProps = Shared & {
  view: Extract<View, { kind: 'channel' }>
  /** The list as last read for this view; undefined while it loads. */
  threads: ThreadSummary[] | undefined
  offline: boolean
  onSaved: (announcement: string) => Promise<void>
}

/**
 * A channel (§12): #global or one repo, with its Todos and Work tabs. Resolved threads stay hidden
 * until "Show resolved" lists them, and the composer adds a todo or work item to the tab in view.
 */
export function ChannelView({ view, threads, offline, onSaved, ...shared }: ChannelViewProps) {
  const { navigate, route, repos } = shared
  const name = channelName(view.repo, repos)
  const body = useRef<HTMLDivElement>(null)
  const setView = (change: Partial<typeof view>) => navigate({ view: { ...view, ...change }, thread: route.thread })

  // A conversation reads from the bottom: show the newest items, next to the composer.
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight
  }, [threads?.length, view.tab, view.resolved])


  const list = (tab: Tab) => tab !== view.tab ? null : !threads ? <p className="quiet">Loading…</p>
    : threads.length === 0 ? <p className="quiet">No {view.resolved ? 'resolved' : 'open'} {tab === 'todos' ? 'todos' : 'work items'} in {name}.</p>
    : <ThreadList {...shared} label={`${view.resolved ? 'Resolved' : 'Open'} ${tab === 'todos' ? 'todos' : 'work items'} in ${name}`} threads={threads} mode={view.resolved ? 'resolved' : 'channel'} />

  return (
    <Tabs className="view" value={view.tab} onValueChange={(tab) => tab && setView({ tab: tab === 'work' ? 'work' : 'todos' })}>
      <header className="toolbar">
        <h1>{name}</h1>
        <TabsList aria-label={`${name} lists`} data-size="sm">
          <TabsIndicator />
          <TabsTab value="todos">Todos</TabsTab>
          <TabsTab value="work">Work</TabsTab>
        </TabsList>
        <label data-slot="label" data-size="sm" className="toolbar-end">
          <Switch checked={view.resolved} onCheckedChange={(checked) => setView({ resolved: checked === true })}><SwitchThumb /></Switch>
          Show resolved
        </label>
      </header>
      <div className="view-body" ref={body}>
        <TabsPanel value="todos">{list('todos')}</TabsPanel>
        <TabsPanel value="work">{list('work')}</TabsPanel>
      </div>
      <div className="view-foot">
        {/* One composer per tab, both kept mounted: each holds its own draft and unconfirmed write. */}
        {(['todos', 'work'] as const).map((tab) => (
          <div key={`${name}:${tab}`} hidden={tab !== view.tab}>
            <Composer label={`New ${tab === 'todos' ? 'todo' : 'work item'} in ${name}`} offline={offline} onSaved={() => onSaved('Saved to the board')}
              toDraft={(text) => ({ kind: tab === 'todos' ? 'todo' : 'work', text, ...(view.repo ? { repo: view.repo } : {}) })} />
          </div>
        ))}
      </div>
    </Tabs>
  )
}

/** A link this page can't read. */
export function NotFoundView() {
  return (
    <>
      <header className="toolbar"><h1>Not found</h1></header>
      <div className="view-body">
        <p className="quiet">This link doesn't name a devchat view. <a href={routeHref({ view: { kind: 'needs-you' }, thread: null })}>Go to Needs you</a></p>
      </div>
    </>
  )
}

/** Search (§12): the board's text filter over todos and work, resolved threads included. */
export function SearchView({ q, threads, ...shared }: Shared & { q: string; threads: ThreadSummary[] | undefined }) {
  return (
    <>
      <header className="toolbar"><h1>Search</h1></header>
      <div className="view-body">
        {!q && <p className="quiet">Type in the search field to find todos and work items, resolved ones included.</p>}
        {q && !threads && <p className="quiet">Searching…</p>}
        {q && threads && (
          <>
            <p className="quiet" role="status">
              {threads.length === 0 ? `Nothing matches “${q}”.` : `${threads.length === 1 ? '1 thread matches' : `${threads.length} threads match`} “${q}”.`}
            </p>
            {threads.length > 0 && <ThreadList {...shared} label={`Results for ${q}`} threads={threads} mode="search" />}
          </>
        )}
      </div>
    </>
  )
}
