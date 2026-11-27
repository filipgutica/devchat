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

// A canonical Board client ID adds the four-character app: prefix to the intent's rid.
const rid = z.string().min(1).max(196)
const text = z.string().refine((value) => value.trim().length > 0, 'Post text is required')
const base = {
  v: z.literal(1),
  rid,
  by: z.string().min(1).refine((profile) => profile !== 'user', 'The user profile is reserved'),
}
const provenance = {
  repo: z.string().min(1).optional(),
  machine: z.string().min(1).optional(),
  thread: z.string().min(1).optional(),
}
const reply = {
  ...base,
  root: rid,
  re: rid.optional(),
}

const todoIntent = z.strictObject({
  ...base,
  ...provenance,
  kind: z.literal('todo'),
  channel: z.literal(channels.todos),
  text,
  work: z.literal(1).optional(),
}).refine(({ work, repo }) => work === undefined || repo === undefined, {
  path: ['work'],
  message: 'A work-lane todo cannot carry a repo',
})

export const intentSchema = z.discriminatedUnion('kind', [
  todoIntent,
  z.strictObject({
    ...base,
    ...provenance,
    kind: z.literal('work'),
    channel: z.literal(channels.work),
    text,
    issue: z.string().min(1).optional(),
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
