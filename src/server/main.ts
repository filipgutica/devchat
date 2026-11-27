import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { boardUrl, hostPaths, readSettings } from '../host/settings.ts'
import { createApp } from './app.ts'
import { guardReason } from './guard.ts'
import { createStateWriter } from './writer.ts'

// The app runs as the service account on loopback only; `tailscale serve` is its one way in.
const settings = await readSettings(process.env.DEVCHAT_CONFIG ?? hostPaths.configFile)
process.env.BOARD_URL = boardUrl(settings)
// package.json sits two levels up from both src/server and dist/server.
const { version } = z.object({ version: z.string() })
  .parse(JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')))
const writer = createStateWriter({ settings, stateFile: join(hostPaths.stateDir, 'app-state.json') })
// A UI write wakes the ingest loop, so a pass runs right after it (§12).
const server = createApp({ version, writerStats: writer.stats, ui: { settings, guard: guardReason, writer, onWrite: () => void ingestLoop() } })
server.listen(settings.appPort, '127.0.0.1')
await once(server, 'listening')
console.log(`devchat app on http://127.0.0.1:${settings.appPort}`)

// The state writer's loop: one pass now, then 15 s after each pass ends. A wake during a pass runs
// one more pass when it ends; one between passes runs it now. The writer also runs one task at a time.
// A failed pass moved `applied` past only what it finished; the next pass resumes from there.
let timer: NodeJS.Timeout | undefined
let running = false
let again = false
async function ingestLoop() {
  if (running) return void (again = true)
  clearTimeout(timer)
  running = true
  do {
    again = false
    try {
      await writer.pass()
    } catch (error) {
      console.error('devchat: state writer pass failed:', error instanceof Error ? error.message : error)
    }
  } while (again)
  running = false
  timer = setTimeout(ingestLoop, 15_000)
}
void ingestLoop()
