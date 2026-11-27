import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { boardUrl, hostPaths, readSettings } from '../host/settings.ts'
import { createApp } from './app.ts'

// The app runs as the service account on loopback only; `tailscale serve` is its one way in.
const settings = await readSettings(process.env.DEVCHAT_CONFIG ?? hostPaths.configFile)
process.env.BOARD_URL = boardUrl(settings)
// package.json sits two levels up from both src/server and dist/server.
const { version } = z.object({ version: z.string() })
  .parse(JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')))
const server = createApp({ version })
server.listen(settings.appPort, '127.0.0.1')
await once(server, 'listening')
console.log(`devchat app on http://127.0.0.1:${settings.appPort}`)
