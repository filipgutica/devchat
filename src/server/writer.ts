import { board, BoardError, type Board, type MessageView } from '@vercel/board'
import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  appMarker, boardMarker, channels, deferredIntentKinds, intentSchema, isUiNamespace, type Intent, type RefusalReason,
  type UserWrite,
} from '../shared/layout.ts'
import type { Settings } from '../host/settings.ts'
import { createBoardPort, type BoardPort } from './board-port.ts'
import { foldState, isStateLabel, stateChange } from './fold.ts'

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
export async function findOwn(port: BoardPort, id: string) {
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

/** A thread's root and every reply, oldest first. */
export async function readWholeThread(port: BoardPort, rootId: string) {
  let page = await port.readThread(rootId, { after: rootId })
  const root = page.message
  const replies: MessageView[] = []
  for (let last = page.replies.at(-1); last; last = page.replies.at(-1)) {
    replies.push(...page.replies)
    page = await port.readThread(rootId, { after: last.id })
  }
  return { root, replies }
}

/** Refolds a thread from its root and writes the state labels that changed (§2, "State is a fold"). */
async function foldThread(port: BoardPort, rootId: string) {
  const { root, replies } = await readWholeThread(port, rootId)
  const state = foldState(replies.filter(({ deleted }) => !deleted).map(({ labels }) => labels))
  const change = stateChange(root.labels, state)
  try {
    if (change) await port.setLabels(root.id, change)
  } catch (error) {
    // A root deleted on the board keeps no labels: its thread has no state left to write.
    if (!(error instanceof BoardError && error.code === 'message_deleted')) throw error
  }
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
 * A canonical write, or why Board refused it for good, having written nothing: `invalid` for a 400,
 * the post as given, and `taken` for a 409 `duplicate_id`, its client ID held by a post of another
 * author, which the app cannot see. Either way the write is refused and the queue moves on. Any
 * other error ends the pass, and the next pass retries the same intent.
 */
async function writeCanonical(write: () => Promise<MessageView>): Promise<MessageView | 'invalid' | 'taken'> {
  try {
    return await write()
  } catch (error) {
    if (!(error instanceof BoardError)) throw error
    const refused = error.status === 400 ? 'invalid' : error.status === 409 && error.code === 'duplicate_id' ? 'taken' : null
    if (!refused) throw error
    console.error(`devchat: board refused a canonical post (${error.code}): ${error.message}`)
    return refused
  }
}

type Labels = Record<string, string>
/** A post as the app writes it: its channel, the root it replies to (null for a root), text, and labels. */
type PlannedPost = { channel: string; parent: string | null; text: string; labels: Labels }

/**
 * The post with its `digest` label: the SHA-256 of the exact text the app asks Board to write, in
 * hex. Board rewrites a known `@handle` in the text it stores, so a replay compares this label, not
 * the stored text. Only the app's canonical write sets it: no intent or UI write carries labels.
 */
const withDigest = <T extends { text: string; labels: Labels }>(post: T): T => ({
  ...post,
  labels: { ...post.labels, digest: createHash('sha256').update(post.text).digest('hex') },
})

/**
 * Whether `written`, the app's post with a rid's client ID, is `post`: the same channel, parent
 * root, and labels, its text's `digest` among them. A root's state labels change with its thread,
 * and its `env` with the host's machine map, so neither is compared. A deleted post keeps no
 * labels, and a post without `digest` was not written as `post`, so neither is.
 */
function isWrittenAs(written: MessageView, post: PlannedPost) {
  const fixed = (labels: Labels) => (written.re === null
    ? Object.fromEntries(Object.entries(labels).filter(([key]) => !isStateLabel(key) && key !== 'env'))
    : labels)
  return !written.deleted && written.channel === post.channel && written.re === post.parent
    && isDeepStrictEqual(fixed(written.labels), fixed(post.labels))
}

const definedLabels = (labels: Record<string, string | undefined>): Labels =>
  Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, string] => entry[1] !== undefined))

type WriterOptions = {
  settings: Pick<Settings, 'allowlist' | 'machines'>
  /** Where the app keeps its epoch and fold cursors: a file in its state directory. */
  stateFile: string
  openBoard?: () => Board
}

/** Why the app refuses a UI write it parsed: see `writeUser`. */
export type UserWriteRefusal = 'repo' | 'root' | 're' | 'invalid' | 'conflict'

/**
 * The state writer (§2, §12): the only writer in the conversation channels. Each pass cancels
 * pending `inbox` schedules, ingests `inbox` from `applied` in log order, then folds every thread
 * with a post after the fold cursors. A UI write posts and folds its thread. Passes and UI writes
 * run one at a time, in call order, so no two interleave on the board.
 */
export function createStateWriter({ settings, stateFile, openBoard = () => board() }: WriterOptions) {
  let inboxSchedulesCanceled = 0
  // The tail of the queue of passes and UI writes. A failed task still lets the next one start.
  let queue: Promise<unknown> = Promise.resolve()
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.catch(() => {})
    return run
  }

  async function cancelInboxSchedules(port: BoardPort) {
    for (const schedule of await port.listSchedules({ channel: channels.inbox, all: true })) {
      if (schedule.state === 'pending' && (await port.cancelSchedule(schedule.id)).canceled) inboxSchedulesCanceled += 1
    }
  }

  /**
   * The text and labels of the canonical post `intent` stands for. A root's routing labels are set
   * here, once; no later post or fold changes them.
   */
  function canonicalPost(intent: Intent): { text: string; labels: Labels } | RefusalReason {
    if (!('root' in intent)) {
      const { machine } = intent
      return withDigest({
        text: intent.text,
        labels: definedLabels({
          rid: intent.rid,
          by: intent.by,
          repo: intent.repo,
          machine,
          env: machine !== undefined && Object.hasOwn(settings.machines, machine) ? settings.machines[machine] : undefined,
          thread: intent.thread,
          issue: intent.kind === 'work' ? intent.issue : undefined,
        }),
      })
    }
    const labels = definedLabels({ rid: intent.rid, by: intent.by, kind: intent.kind, re: intent.re })
    if (intent.kind === 'note' && intent.pr !== undefined) {
      const number = prNumber(intent.pr)
      if (number === null) return 'pr'
      labels[`pr.${number}`] = intent.pr
    }
    if (intent.kind === 'ask' && intent.block === 1) labels.block = '1'
    const text = intent.kind === 'done' ? 'Resolved.' : intent.kind === 'drop' ? 'Dropped.' : intent.text
    return withDigest({ text, labels })
  }

  /** Whether `written`, the app's post `app:<rid>`, is the canonical post of this very intent. A rid reused by another intent is not. */
  function isReplay(intent: Intent, written: MessageView, post: { text: string; labels: Labels }, target: MessageView | null) {
    if (!('root' in intent)) return isWrittenAs(written, { channel: intent.channel, parent: null, ...post })
    return target !== null && isWrittenAs(written, { channel: target.channel, parent: target.id, ...post })
  }

  async function writeRoot(port: BoardPort, intent: Extract<Intent, { kind: 'todo' | 'work' }>, post: { text: string; labels: Labels }) {
    if (intent.repo !== undefined && !isAllowlisted(intent.repo, settings.allowlist)) return 'repo'
    const root = await writeCanonical(() => port.post(intent.channel, { id: `app:${intent.rid}`, ...post }))
    if (typeof root === 'string') return root === 'taken' ? 'rid' : root
    await foldThread(port, root.id)
    return null
  }

  async function writeReply(port: BoardPort, intent: Extract<Intent, { root: string }>, post: { text: string; labels: Labels }, target: MessageView | null) {
    if (!target || target.deleted || target.re !== null || !conversationChannels.includes(target.channel)) return 'root'
    if (target.channel === channels.msg && intent.by !== 'coordinator') return 'profile'
    if (intent.kind === 'done' || intent.kind === 'drop') {
      // Pending guard, from a fresh fold: the root's labels may predate a crash.
      const state = await foldThread(port, target.id)
      if (state.ask === 'answered' && intent.re !== state.turn) return 'pending'
    }
    const reply = await writeCanonical(() => port.reply(target.id, { id: `app:${intent.rid}`, ...post }))
    if (typeof reply === 'string') return reply === 'taken' ? 'rid' : reply
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
    const post = canonicalPost(intent)
    if (typeof post === 'string') return post
    const target = 'root' in intent ? await findOwn(port, `app:${intent.root}`) : null
    // The decision already made: this intent's canonical post means it was applied, whatever was
    // written since, so a replay folds that post's thread and checks nothing else (§12, Recovery).
    // No intent Board accepted fails the checks above, so they refuse nothing that was applied.
    const written = await findOwn(port, `app:${intent.rid}`)
    if (written) {
      if (!isReplay(intent, written, post, target)) return 'rid'
      await foldThread(port, written.re ?? written.id)
      return null
    }
    // The UI namespace: only the UI route makes new posts with these rids. A UI post never replays
    // as an intent above, since no intent carries `by=user`.
    if (isUiNamespace(intent.rid)) return 'rid'
    return 'root' in intent ? writeReply(port, intent, post, target) : writeRoot(port, intent, post)
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

  async function runPass() {
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

  type UserWriteResult = { rid: string; state: Labels; replayed: boolean } | { refused: UserWriteRefusal }

  /** The post a UI write stands for, or `root` when it names no root it may go under. */
  async function plannedUserPost(port: BoardPort, write: UserWrite): Promise<PlannedPost | 'root'> {
    if (!('root' in write)) {
      const channel = write.kind === 'todo' ? channels.todos : channels.work
      return withDigest({ channel, parent: null, text: write.text, labels: definedLabels({ rid: write.rid, by: 'user', repo: write.repo }) })
    }
    // An answer goes under a work item; a resolve under a todo or work item.
    const target = await findOwn(port, `app:${write.root}`)
    const targetChannels: readonly string[] = write.kind === 'answer' ? [channels.work] : [channels.todos, channels.work]
    if (!target || target.deleted || target.re !== null || !targetChannels.includes(target.channel)) return 'root'
    const re = write.kind === 'answer' ? write.re : undefined
    const text = write.kind === 'done' ? 'Resolved.' : write.text
    return withDigest({ channel: target.channel, parent: target.id, text, labels: definedLabels({ rid: write.rid, by: 'user', kind: write.kind, re }) })
  }

  /** Why a new UI write is refused: `repo` off the allowlist, or `re` not a question in its thread. */
  async function checkNewUserPost(port: BoardPort, write: UserWrite, post: PlannedPost): Promise<UserWriteRefusal | null> {
    if ('repo' in write && write.repo !== undefined && !isAllowlisted(write.repo, settings.allowlist)) return 'repo'
    if (post.labels.re === undefined) return null
    const question = await findOwn(port, `app:${post.labels.re}`)
    return question?.re === post.parent && question.labels.kind === 'ask' ? null : 're'
  }

  /**
   * Writes the user's post with `by=user` and the browser's `rid`, then folds its thread (§2, §12),
   * and returns the root's folded state. A retry replays: when `app:<rid>` already is this post, the
   * app writes nothing, folds its thread again, and answers `replayed`. Refused: `root`, `repo`,
   * `re` (see above), `conflict` when the rid holds another post, or `invalid` when Board refuses it.
   */
  async function writeUserPost(write: UserWrite): Promise<UserWriteResult> {
    const port = createBoardPort(openBoard())
    const post = await plannedUserPost(port, write)
    if (post === 'root') return { refused: 'root' }
    const id = `app:${write.rid}`
    const written = await findOwn(port, id)
    if (written) {
      if (!isWrittenAs(written, post)) return { refused: 'conflict' }
      return { rid: write.rid, state: await foldThread(port, written.re ?? written.id), replayed: true }
    }
    const refused = await checkNewUserPost(port, write, post)
    if (refused) return { refused }
    const { channel, parent, ...content } = post
    const message = await writeCanonical(() => (parent ? port.reply(parent, { id, ...content }) : port.post(channel, { id, ...content })))
    if (typeof message === 'string') return { refused: message === 'taken' ? 'conflict' : message }
    return { rid: write.rid, state: await foldThread(port, parent ?? message.id), replayed: false }
  }

  return {
    pass: () => exclusive(runPass),
    writeUser: (write: UserWrite) => exclusive(() => writeUserPost(write)),
    stats: () => ({ inboxSchedulesCanceled }),
  }
}
export type StateWriter = ReturnType<typeof createStateWriter>
