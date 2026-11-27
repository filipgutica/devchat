import { createHash } from 'node:crypto'
import type { MessageView } from '@vercel/board'

/** The `digest` label the app writes on a canonical post: the SHA-256 of its text, in hex. */
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** A post as a test compares it: without its `digest` label, which tests check on their own. */
export const withoutDigest = (post: MessageView): MessageView => ({
  ...post,
  labels: Object.fromEntries(Object.entries(post.labels).filter(([key]) => key !== 'digest')),
})
