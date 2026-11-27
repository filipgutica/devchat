import { board, BoardError, type Board, type MessageView } from '@vercel/board'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  appMarker, boardMarker, channels, deferredIntentKinds, intentSchema, type Intent, type RefusalReason,
} from '../shared/layout.ts'
import type { Settings } from '../host/settings.ts'
import { createBoardPort, type BoardPort } from './board-port.ts'
import { foldState, stateChange } from './fold.ts'

const conversationChannels: readonly string[] = [channels.todos, channels.work, channels.msg]

/**
 * The app's own state, beside the board: the `epoch` it last ran under and, per conversation
 * channel, the fold cursor, a Board read cursor up to which every thread is folded (§12).
 */
const appStateSchema = z.object({
  epoch: z.string().nullable(),
  folded: z.record(z.string(), z.string()),
})
type AppState = z.infer<typeof appStateSchema>

async function readAppState(file: string): Promise<AppState | null> {
  try {
    return appStateSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeAppState(file: string, state: AppState) {
  await writeFile(`${file}.tmp`, JSON.stringify(state))
  await rename(`${file}.tmp`, file)
}

/** The app's own post with this client ID, or null. Any other error ends the pass. */
async function findOwn(port: BoardPort, id: string) {
  try {
    return await port.getPost(id)
  } catch (error) {
    if (error instanceof BoardError && error.code === 'post_not_found') return null
    throw error
  }
}

/** Every page of a channel's messages after `after` (Board's `'0'` is the start), oldest first. */
async function* channelPages(port: BoardPort, channel: string, after: string) {
  for (let page = await port.readChannel(channel, { after }); page.messages.length > 0;
    page = await port.readChannel(channel, { after: page.cursor })) {
    yield page
  }
}

/** Refolds a thread from its root and writes the state labels that changed (§2, "State is a fold"). */
async function foldThread(port: BoardPort, rootId: string) {
  let page = await port.readThread(rootId, { after: rootId })
  const root = page.message
  const replies: MessageView[] = []
  for (let last = page.replies.at(-1); last; last = page.replies.at(-1)) {
    replies.push(...page.replies)
    page = await port.readThread(rootId, { after: last.id })
  }
  const state = foldState(replies.filter(({ deleted }) => !deleted).map(({ labels }) => labels))
  const change = stateChange(root.labels, state)
  if (change) await port.setLabels(root.id, change)
  return state
}

/** `<owner>/<repo>` with its owner on the allowlist, ignoring case (§5). */
const isAllowlisted = (repo: string, allowlist: readonly string[]) => {
  const owner = /^([^/]+)\/[^/]+$/.exec(repo)?.[1]?.toLowerCase()
  return owner !== undefined && allowlist.some((entry) => entry.toLowerCase() === owner)
}

/** The PR number of a pull request URL, for its `pr.<n>` label, or null. */
const prNumber = (url: string) => /\/pull\/(\d{1,9})\/?$/.exec(new URL(url).pathname)?.[1] ?? null

/**
 * A canonical write, or null when Board answers 400: it refused that post as given and wrote
 * nothing, so the intent is refused and the queue moves on. Any other error ends the pass, and the
 * next pass retries the same intent.
 */
async function writeCanonical(write: () => Promise<MessageView>) {
  try {
    return await write()
  } catch (error) {
    if (error instanceof BoardError && error.status === 400) {
      console.error(`devchat: board refused a canonical post (${error.code}): ${error.message}`)
      return null
    }
    throw error
  }
}

/** Whether `post` is what the normal write path writes for `intent`: a reused rid that names another post is not. */
const isCanonicalFor = (intent: Intent, post: MessageView) => ('root' in intent
  ? post.re !== null && post.labels.kind === intent.kind && conversationChannels.includes(post.channel)
  : post.re === null && post.channel === intent.channel)

const definedLabels = (labels: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, string] => entry[1] !== undefined))

type WriterOptions = {
  settings: Pick<Settings, 'allowlist' | 'machines'>
  /** Where the app keeps its epoch and fold cursors: a file in its state directory. */
  stateFile: string
  openBoard?: () => Board
}

/**
 * The state writer (§2, §12): the only writer in the conversation channels. Each pass cancels
 * pending `inbox` schedules, ingests `inbox` from `applied` in log order, then folds every thread
 * with a post after the fold cursors. Run one pass at a time.
 */
export function createStateWriter({ settings, stateFile, openBoard = () => board() }: WriterOptions) {
  let inboxSchedulesCanceled = 0

  async function cancelInboxSchedules(port: BoardPort) {
    for (const schedule of await port.listSchedules({ channel: channels.inbox, all: true })) {
      if (schedule.state === 'pending' && (await port.cancelSchedule(schedule.id)).canceled) inboxSchedulesCanceled += 1
    }
  }

  async function writeRoot(port: BoardPort, intent: Extract<Intent, { kind: 'todo' | 'work' }>): Promise<RefusalReason | null> {
    if (intent.repo !== undefined && !isAllowlisted(intent.repo, settings.allowlist)) return 'repo'
    const { machine } = intent
    // Routing labels are set here, once; no later post or fold changes them.
    const labels = definedLabels({
      rid: intent.rid,
      by: intent.by,
      repo: intent.repo,
      machine,
      env: machine !== undefined && Object.hasOwn(settings.machines, machine) ? settings.machines[machine] : undefined,
      thread: intent.thread,
      issue: intent.kind === 'work' ? intent.issue : undefined,
    })
    const root = await writeCanonical(() => port.post(intent.channel, { id: `app:${intent.rid}`, text: intent.text, labels }))
    if (!root) return 'invalid'
    await foldThread(port, root.id)
    return null
  }

  async function writeReply(port: BoardPort, intent: Extract<Intent, { root: string }>): Promise<RefusalReason | null> {
    const target = await findOwn(port, `app:${intent.root}`)
    if (!target || target.re !== null || !conversationChannels.includes(target.channel)) return 'root'
    if (target.channel === channels.msg && intent.by !== 'coordinator') return 'profile'
    const labels: Record<string, string> = definedLabels({ rid: intent.rid, by: intent.by, kind: intent.kind, re: intent.re })
    let text = intent.text
    if (intent.kind === 'note' && intent.pr !== undefined) {
      const number = prNumber(intent.pr)
      if (number === null) return 'pr'
      labels[`pr.${number}`] = intent.pr
    } else if (intent.kind === 'ask' && intent.block === 1) {
      labels.block = '1'
    } else if (intent.kind === 'done' || intent.kind === 'drop') {
      // Pending guard, from a fresh fold: the root's labels may predate a crash.
      const state = await foldThread(port, target.id)
      if (state.ask === 'answered' && intent.re !== state.turn) return 'pending'
      text = intent.kind === 'done' ? 'Resolved.' : 'Dropped.'
    }
    if (!await writeCanonical(() => port.reply(target.id, { id: `app:${intent.rid}`, text, labels }))) return 'invalid'
    await foldThread(port, target.id)
    return null
  }

  /** Writes the canonical post for one `inbox` root, or says why it is refused. */
  async function ingest(port: BoardPort, message: MessageView): Promise<RefusalReason | null> {
    if (message.re !== null) return 'reply'
    let json: unknown
    try {
      json = JSON.parse(message.text)
    } catch {
      return 'json'
    }
    const kind = z.object({ kind: z.enum(deferredIntentKinds) }).safeParse(json)
    if (kind.success) return 'deferred'
    const parsed = intentSchema.safeParse(json)
    if (!parsed.success) return 'invalid'
    const intent = parsed.data
    // The decision already made: a canonical post means the intent was applied, whatever was written
    // since, so a replay folds that post's thread and checks nothing else (§12, Recovery). No intent
    // Board accepted fails the schema, so checking it first refuses nothing that was applied.
    const written = await findOwn(port, `app:${intent.rid}`)
    if (written) {
      if (!isCanonicalFor(intent, written)) return 'rid'
      await foldThread(port, written.re ?? written.id)
      return null
    }
    return 'root' in intent ? writeReply(port, intent) : writeRoot(port, intent)
  }

  /** Decides every `inbox` post after `after`, a page at a time, and moves `applied` past each page. */
  async function ingestInbox(port: BoardPort, marker: MessageView, after: string) {
    for await (const page of channelPages(port, channels.inbox, after)) {
      for (const message of page.messages) {
        if (message.id === marker.id || message.deleted || message.labels.refused !== undefined) continue
        const reason = await ingest(port, message)
        if (reason) await port.setLabels(message.id, { set: { refused: reason } })
      }
      // Only now: every intent of the page has its canonical post and its root labels, or `refused`.
      await port.setLabels(marker.id, { set: { applied: page.messages.at(-1)?.id ?? page.cursor } })
    }
  }

  async function pass() {
    // Board caches its owner token and never rereads it, and a board restart mints a new one (app.ts).
    const port = createBoardPort(openBoard())
    await cancelInboxSchedules(port)

    const epoch = (await findOwn(port, boardMarker.id))?.labels.epoch ?? null
    const saved = await readAppState(stateFile)
    // A new epoch means a restored board: every cursor holds an old board's message IDs.
    const fresh = saved === null || saved.epoch !== epoch
    const folded = fresh ? {} : saved.folded

    const marker = await findOwn(port, appMarker.id)
      ?? await port.post(appMarker.channel, { id: appMarker.id, text: 'devchat app marker' })
    await ingestInbox(port, marker, fresh ? '0' : marker.labels.applied ?? '0')

    // Recovery, and the posts this pass wrote: fold every thread with a post after the fold cursor.
    for (const channel of conversationChannels) {
      for await (const page of channelPages(port, channel, folded[channel] ?? '0')) {
        for (const rootId of new Set(page.messages.map((message) => message.re ?? message.id))) await foldThread(port, rootId)
        folded[channel] = page.cursor
      }
    }
    await writeAppState(stateFile, { epoch, folded })
  }

  return { pass, stats: () => ({ inboxSchedulesCanceled }) }
}
