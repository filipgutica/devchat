import { z } from 'zod'

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

export const labelKeys = [
  'rid', 'status', 'host', 'repo', 'work', 'kind', 'issue', 'machine', 'env',
  'thread', 'ask', 'turn', 'pushed', 'by', 'fwd', 'dest', 'every', 'last', 'src',
  'root', 're', 'date', 'to', 'done', 'refused', 'applied', 'state', 'act',
  'subject', 'origin', 'generic', 'created', 'linked', 'superseded-by', 'pin',
  'signal', 'ctx', 'counts', 'run', 'epoch', 'migrating', 'mode', 'synced',
  'private', 'block', 'react',
] as const

export const labelKeyPrefixes = ['pr.', 'trigger.', 'used.', 'mig.'] as const

export const release1IntentKinds = ['todo', 'work', 'note', 'ask', 'done', 'drop'] as const
export const deferredIntentKinds = ['msg', 'queue', 'ack', 'react'] as const

// A canonical Board client ID adds the four-character app: prefix to the intent's rid. A rid is
// also a label value and a label-query term, so it excludes `|`, which Board reads as OR.
const rid = z.string().max(196).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'A rid uses letters, digits, and . _ : -')
// Fields the app copies into labels must fit Board's label values: 1 to 256 characters.
const labelValue = z.string().min(1).max(256)
const text = z.string().refine((value) => value.trim().length > 0, 'Post text is required')
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
    pr: z.url().optional(),
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
