import { z } from 'zod'
import { boardUrl, type Settings } from './settings.ts'

/** The part of `tailscale serve status --json` the plan reads. */
const serveStatus = z.object({
  TCP: z.record(z.string(), z.object({ HTTPS: z.boolean().optional() }).passthrough()).optional(),
  Web: z.record(z.string(), z.object({
    Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
  AllowFunnel: z.record(z.string(), z.boolean()).optional(),
}).passthrough()

/** `tailscale serve status --json` prints text, not JSON, when nothing is served. */
export function parseServeStatus(text: string) {
  return serveStatus.parse(text.trim().startsWith('{') ? JSON.parse(text) : {})
}

/** devchat's two mounts for one set of settings: path and the loopback target it proxies to. */
const mounts = (settings: Settings) => [
  { path: '/api/board', target: boardUrl(settings) },
  { path: '/', target: `http://127.0.0.1:${settings.appPort}` },
] as const

type PlanOptions = {
  /** The settings an earlier install recorded, so its mounts are found after a port change. */
  previous?: Settings | undefined
  /** Plan only the removal of every devchat mount. */
  remove?: boolean
}

/**
 * What to change so tailscale serves devchat exactly at the settings' HTTPS port, as lines:
 * `off <port> <path>` for each devchat mount to remove, then `set` when the port is not exactly
 * devchat's, over HTTPS, with Funnel off (`tailscale serve` turns Funnel off for the port it sets),
 * or `unchanged` when nothing changes. A devchat mount is one at the recorded host whose path and target are
 * devchat's under the current or previous settings; nothing else on any port is touched.
 */
export function planServe(status: z.infer<typeof serveStatus>, settings: Settings, { previous, remove = false }: PlanOptions = {}) {
  const ours = [settings, ...(previous ? [previous] : [])].flatMap((recorded) =>
    mounts(recorded).map(({ path, target }) => ({ host: recorded.host, path, target })))
  const wanted = mounts(settings)
  const origin = `${settings.host}:${settings.httpsPort}`
  const lines: string[] = []
  for (const [key, { Handlers = {} }] of Object.entries(status.Web ?? {})) {
    const at = key.lastIndexOf(':')
    const host = key.slice(0, at)
    const port = Number(key.slice(at + 1))
    for (const [path, { Proxy }] of Object.entries(Handlers)) {
      const isOurs = ours.some((mount) => mount.host === host && mount.path === path && mount.target === Proxy)
      const isWanted = key === origin && wanted.some((mount) => mount.path === path && mount.target === Proxy)
      if (isOurs && (remove || !isWanted)) lines.push(`off ${port} ${path}`)
      else if (key === origin && !isOurs && wanted.some((mount) => mount.path === path)) {
        throw new Error(`${origin}${path} already serves ${Proxy ?? 'something else'}; pick another --https-port`)
      }
    }
  }
  if (remove) return lines
  const handlers = status.Web?.[origin]?.Handlers ?? {}
  const exact = wanted.every(({ path, target }) => handlers[path]?.Proxy === target)
  const https = status.TCP?.[String(settings.httpsPort)]?.HTTPS === true
  const funnel = status.AllowFunnel?.[origin] === true
  if (!exact || !https || funnel) return [...lines, 'set']
  return lines.length > 0 ? lines : ['unchanged']
}
