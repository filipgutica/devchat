import { readFileSync } from 'node:fs'
import { z } from 'zod'

const labels = z.record(z.string(), z.string())

/** `fixtures/fold.json`, the fold contract shared with filip-stack (docs/layout.md). */
export const foldFixture = z.array(z.object({
  name: z.string(),
  channel: z.enum(['todos', 'work']),
  steps: z.array(z.object({ post: z.object({ text: z.string(), labels }), rootLabels: labels })).min(1),
})).parse(JSON.parse(readFileSync(new URL('../fixtures/fold.json', import.meta.url), 'utf8')))
