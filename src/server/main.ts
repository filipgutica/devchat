import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { boardUrl, hostPaths, readSettings } from '../host/settings.ts'
import { createApp } from './app.ts'
import { createStateWriter } from './writer.ts'

// The app runs as the service account on loopback only; `tailscale serve` is its one way in.
const settings = await readSettings(process.env.DEVCHAT_CONFIG ?? hostPaths.configFile)
process.env.BOARD_URL = boardUrl(settings)
// package.json sits two levels up from both src/server and dist/server.
const { version } = z.object({ version: z.string() })
  .parse(JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')))
const writer = createStateWriter({ settings, stateFile: join(hostPaths.stateDir, 'app-state.json') })
const server = createApp({ version, writerStats: writer.stats })
server.listen(settings.appPort, '127.0.0.1')
await once(server, 'listening')
console.log(`devchat app on http://127.0.0.1:${settings.appPort}`)

// The state writer's loop: one pass now, then 15 s after each pass ends, so passes never overlap.
// A failed pass moved `applied` past only what it finished; the next pass resumes from there.
async function ingestLoop() {
  try {
    await writer.pass()
  } catch (error) {
    console.error('devchat: state writer pass failed:', error instanceof Error ? error.message : error)
  }
  setTimeout(ingestLoop, 15_000)
}
void ingestLoop()
