import type { Board, MessageView } from '@vercel/board'
import { readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rid as ridSchema } from '../shared/layout.ts'

const exportsKept = 14
const exportName = /^devchat-\d{8}T\d{6}Z\.json$/

/** The export files beyond the newest `keep`, oldest first. Names sort by time. */
export function exportsToPrune(names: readonly string[], keep = exportsKept) {
  const ours = names.filter((name) => exportName.test(name)).sort()
  return ours.slice(0, Math.max(0, ours.length - keep))
}

/**
 * Every post on the board, keyed by its `rid`; a post without a well-formed one (an intent, a
 * marker) by its Board ID, as `#<id>`. A Map, so a key such as `__proto__` is data. A second post with a `rid` already seen
 * is kept under its Board ID and listed in `duplicates`: an export loses nothing.
 */
async function readAll(handle: Board) {
  const records = new Map<string, MessageView>()
  const duplicates: { rid: string; id: string }[] = []
  let channelsAfter: string | undefined
  do {
    const page = await handle.channels(channelsAfter === undefined ? {} : { after: channelsAfter })
    for (const { path } of page.channels) {
      let after: string | undefined
      while (true) {
        const { messages } = await handle.channel(path).messages({ limit: 500, ...(after === undefined ? {} : { after }) })
        const last = messages.at(-1)
        if (!last) break
        for (const message of messages) {
          // Only a rid in the layout's shape keys a record. It never starts with `#`, so it cannot
          // collide with a Board ID key; Board itself accepts any label value.
          const rid = ridSchema.safeParse(message.labels.rid).data
          if (rid !== undefined && records.has(rid)) duplicates.push({ rid, id: message.id })
          records.set(rid === undefined || records.has(rid) ? `#${message.id}` : rid, message)
        }
        after = last.id
      }
    }
    channelsAfter = page.next ?? undefined
  } while (channelsAfter !== undefined)
  return { records, duplicates }
}

/** Writes every channel's posts as JSON keyed by `rid` to `dir`, then keeps the newest 14 files. */
export async function exportBoard(handle: Board, dir: string, now = new Date()) {
  const { records, duplicates } = await readAll(handle)
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const file = join(dir, `devchat-${stamp}.json`)
  // Object.fromEntries defines each key as an own property, `__proto__` included.
  const document = { exportedAt: now.toISOString(), records: Object.fromEntries(records), duplicates }
  await writeFile(`${file}.tmp`, JSON.stringify(document, null, 2), { mode: 0o600 })
  await rename(`${file}.tmp`, file)
  const pruned = exportsToPrune(await readdir(dir))
  await Promise.all(pruned.map((name) => rm(join(dir, name))))
  return { file, records: records.size, duplicates: duplicates.length, pruned }
}
