import { z } from 'zod'
import { boardUrl, type Settings } from './settings.ts'

/** The part of `tailscale serve status --json` the plan reads: each `<host>:<port>` and its handlers. */
const serveStatus = z.object({
  Web: z.record(z.string(), z.object({
    Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough()

const boardProxy = /^http:\/\/127\.0\.0\.1:\d+\/api\/board$/

/** `tailscale serve status --json` prints text, not JSON, when nothing is served. */
export function parseServeStatus(text: string) {
  return serveStatus.parse(text.trim().startsWith('{') ? JSON.parse(text) : {})
}

/**
 * What to change so tailscale serves devchat exactly at the settings' HTTPS port: one line each,
 * `off <port>` for a port that serves devchat's board route but should not, then `set`, or
 * `unchanged`. With `remove`, only the `off` lines for every port that serves devchat.
 * A port that serves anything else is never turned off.
 */
export function planServe(status: z.infer<typeof serveStatus>, settings: Settings, { remove = false } = {}) {
  const want = { '/api/board': boardUrl(settings), '/': `http://127.0.0.1:${settings.appPort}` }
  const ports = new Map<number, Record<string, string | undefined>>()
  for (const [origin, { Handlers = {} }] of Object.entries(status.Web ?? {})) {
    const port = Number(origin.slice(origin.lastIndexOf(':') + 1))
    ports.set(port, { ...ports.get(port), ...Object.fromEntries(Object.entries(Handlers).map(([path, { Proxy }]) => [path, Proxy])) })
  }
  const isDevchat = (handlers: Record<string, string | undefined>) =>
    boardProxy.test(handlers['/api/board'] ?? '')
    && Object.values(handlers).every((proxy) => proxy !== undefined && /^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(proxy))
  const lines: string[] = []
  for (const [port, handlers] of ports) {
    if (isDevchat(handlers) && (remove || port !== settings.httpsPort)) lines.push(`off ${port}`)
  }
  if (remove) return lines
  const current = ports.get(settings.httpsPort)
  if (current !== undefined && Object.keys(current).length > 0) {
    const exact = Object.keys(current).length === 2 && current['/api/board'] === want['/api/board'] && current['/'] === want['/']
    if (exact) return [...lines, 'unchanged']
    if (!isDevchat(current)) throw new Error(`:${settings.httpsPort} already serves something else; pick another --https-port`)
    lines.push(`off ${settings.httpsPort}`)
  }
  return [...lines, 'set']
}
