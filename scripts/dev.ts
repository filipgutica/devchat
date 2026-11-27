// `pnpm dev [--serve] [--port <n>]`: builds the web UI and serves it against a local board with sample
// items, through scripts/ui-host.ts. It needs no sudo and no host install. With --serve it listens on
// this node's Tailscale address only and answers its MagicDNS name; otherwise on loopback.
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { build } from 'vite'
import { parseSelfName } from '../src/host/serve.ts'
import { startUiHost } from './ui-host.ts'

const { values } = parseArgs({ options: { serve: { type: 'boolean', default: false }, port: { type: 'string', default: '5180' } } })
const tailscale = (...args: string[]) => execFileSync('tailscale', args, { encoding: 'utf8' })

let bind = '127.0.0.1'
let host = '127.0.0.1'
if (values.serve) {
  bind = tailscale('ip', '-4').trim().split('\n')[0] ?? ''
  host = parseSelfName(tailscale('status', '--json'))
  if (!bind) throw new Error('tailscale reports no IPv4 address for this node')
}

// One build: the app lists the shell's files when it starts, so restart after a UI change.
await build({ configFile: new URL('../ui/vite.config.ts', import.meta.url).pathname, logLevel: 'warn' })
const ui = await startUiHost({ bind, host, port: Number(values.port), ingestEvery: 15_000 })
await ui.seed()
console.log(`devchat UI: ${ui.url}  (local board with sample items; Ctrl+C stops it)`)

const stop = async () => {
  await ui.stop()
  process.exit(0)
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
