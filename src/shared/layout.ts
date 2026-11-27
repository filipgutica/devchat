import { z } from 'zod'
import { githubRepoPattern, isDotRepoName } from './github.ts'

export const channels = {
  inbox: 'inbox',
  todos: 'todos',
  work: 'work',
  msg: 'msg',
  sched: 'sched',
  out: 'out',
  sys: 'sys',
  guideGlobal: 'guide/global',
  dream: 'dream',
} as const

/** The board marker in `sys`, posted once by host setup with `epoch=1`. */
export const boardMarker = { id: 'board', channel: channels.sys } as const

/** The app marker in `inbox`: its `applied` label is the message ID of the last `inbox` post the app handled. */
export const appMarker = { id: 'app', channel: channels.inbox } as const

/** The values of `refused` on an `inbox` post the app rejected; docs/layout.md says what each means. */
export const refusalReasons = ['reply', 'json', 'deferred', 'invalid', 'rid', 'repo', 'root', 'profile', 'pr', 'pending'] as const
export type RefusalReason = typeof refusalReasons[number]

export const labelKeys = [
  'rid', 'status', 'host', 'repo', 'work', 'kind', 'issue', 'machine', 'env',
  'thread', 'ask', 'turn', 'pushed', 'by', 'fwd', 'dest', 'every', 'last', 'src',
  'root', 're', 'date', 'to', 'done', 'refused', 'applied', 'state', 'act',
  'subject', 'origin', 'generic', 'created', 'linked', 'superseded-by', 'pin',
  'signal', 'ctx', 'counts', 'run', 'epoch', 'migrating', 'mode', 'synced',
  'private', 'block', 'react', 'digest',
] as const

export const labelKeyPrefixes = ['pr.', 'trigger.', 'used.', 'mig.'] as const

export const release1IntentKinds = ['todo', 'work', 'note', 'ask', 'done', 'drop'] as const
export const deferredIntentKinds = ['msg', 'queue', 'ack', 'react'] as const

// A canonical Board client ID adds the four-character app: prefix to the intent's rid. A rid is
// also a label value and a label-query term, so it excludes `|`, which Board reads as OR.
export const rid = z.string().max(196).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'A rid uses letters, digits, and . _ : -')
/**
 * The rids the web UI makes: `ui-` and a lowercase UUID. The app refuses an intent whose rid starts
 * with `ui-`, ignoring case, so no agent can claim or forge a UI post's rid.
 */
export const uiRid = z.string().regex(/^ui-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'A UI rid is ui-<lowercase UUID>')
export const isUiNamespace = (value: string) => /^ui-/i.test(value)
const githubRepo = z.string()
  .regex(githubRepoPattern, 'A repo is <owner>/<repo> as GitHub names it')
  .refine((repo) => !isDotRepoName(repo), 'A repo name is not . or ..')
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
// Fields the app copies into labels must fit Board's label values: 1 to 256 characters, with no
// control characters and no lone surrogates. The host's settings use it for the machine map too.
export const labelValue = z.string().min(1).max(256)
  .refine((value) => !/\p{Cc}/u.test(value), 'A label value has no control characters')
  .refine((value) => !loneSurrogate.test(value), 'A label value has no lone surrogates')
// Board 0.56.1 stores a message text of at most 10,000 characters, not blank, with no NUL and no
// lone surrogate: anything else it refuses after the intent was accepted.
const text = z.string().max(10_000)
  .refine((value) => value.trim().length > 0, 'Post text is required')
  .refine((value) => !value.includes('\0') && !loneSurrogate.test(value), 'Post text has no NUL and no lone surrogates')
const base = {
  v: z.literal(1),
  rid,
  by: labelValue.refine((profile) => profile !== 'user', 'The user profile is reserved'),
}
const provenance = {
  repo: labelValue.optional(),
  machine: labelValue.optional(),
  thread: labelValue.optional(),
}
const reply = {
  ...base,
  root: rid,
  re: rid.optional(),
}

// Work-lane todos (`work: 1`) arrive in release 3; release 1 refuses the field.
const todoIntent = z.strictObject({
  ...base,
  ...provenance,
  kind: z.literal('todo'),
  channel: z.literal(channels.todos),
  text,
})

export const intentSchema = z.discriminatedUnion('kind', [
  todoIntent,
  z.strictObject({
    ...base,
    ...provenance,
    kind: z.literal('work'),
    channel: z.literal(channels.work),
    text,
    issue: labelValue.optional(),
  }),
  z.strictObject({
    ...reply,
    kind: z.literal('note'),
    text,
    // The app copies it into a `pr.<n>` label.
    pr: labelValue.pipe(z.url()).optional(),
  }),
  z.strictObject({
    ...reply,
    kind: z.literal('ask'),
    text,
    block: z.literal(1).optional(),
  }),
  z.strictObject({
    ...reply,
    kind: z.enum(['done', 'drop']),
    text: z.literal(''),
  }),
])

export type Intent = z.infer<typeof intentSchema>

/**
 * A write the user makes in the web UI, as the UI route takes it (§12). The browser makes the
 * post's `rid` once per write, in the UI namespace, and sends the same body with it on every retry;
 * the app adds `by=user`. A new todo or work item takes the `repo` of the project channel in view,
 * or none in #global. An answer carries `re`, the `turn` the UI showed, while the root has
 * `ask=open` (§2, DC-40).
 */
export const userWriteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['todo', 'work']), rid: uiRid, text, repo: githubRepo.optional() }),
  z.strictObject({ kind: z.literal('answer'), rid: uiRid, root: rid, re: rid.optional(), text }),
  z.strictObject({ kind: z.literal('done'), rid: uiRid, root: rid }),
])

export type UserWrite = z.infer<typeof userWriteSchema>
