import type { Board, MessageView } from '@vercel/board'
import { readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const exportsKept = 14
const exportName = /^devchat-\d{8}T\d{6}Z\.json$/

/** The export files beyond the newest `keep`, oldest first. Names sort by time. */
export function exportsToPrune(names: readonly string[], keep = exportsKept) {
  const ours = names.filter((name) => exportName.test(name)).sort()
  return ours.slice(0, Math.max(0, ours.length - keep))
}

async function readAll(handle: Board) {
  const records: Record<string, MessageView> = {}
  let channelsAfter: string | undefined
  do {
    const page = await handle.channels(channelsAfter === undefined ? {} : { after: channelsAfter })
    for (const { path } of page.channels) {
      let after: string | undefined
      while (true) {
        const { messages } = await handle.channel(path).messages({ limit: 500, ...(after === undefined ? {} : { after }) })
        const last = messages.at(-1)
        if (!last) break
        // A devchat record is keyed by its rid; a post without one (an intent, a marker) by its Board ID.
        for (const message of messages) records[message.labels.rid ?? `board:${message.id}`] = message
        after = last.id
      }
    }
    channelsAfter = page.next ?? undefined
  } while (channelsAfter !== undefined)
  return records
}

/** Writes every channel's posts as JSON keyed by `rid` to `dir`, then keeps the newest 14 files. */
export async function exportBoard(handle: Board, dir: string, now = new Date()) {
  const records = await readAll(handle)
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const file = join(dir, `devchat-${stamp}.json`)
  await writeFile(`${file}.tmp`, JSON.stringify({ exportedAt: now.toISOString(), records }, null, 2), { mode: 0o600 })
  await rename(`${file}.tmp`, file)
  const pruned = exportsToPrune(await readdir(dir))
  await Promise.all(pruned.map((name) => rm(join(dir, name))))
  return { file, records: Object.keys(records).length, pruned }
}
