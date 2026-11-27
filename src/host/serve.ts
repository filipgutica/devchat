import { z } from 'zod'
import { boardUrl, settingsSchema, type Settings } from './settings.ts'

/** The part of `tailscale serve status --json` the plan reads. */
const serveStatus = z.object({
  TCP: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  Web: z.record(z.string(), z.object({
    Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
  AllowFunnel: z.record(z.string(), z.boolean()).optional(),
}).passthrough()

/** `tailscale serve status --json` prints text, not JSON, when nothing is served. */
export function parseServeStatus(text: string) {
  return serveStatus.parse(text.trim().startsWith('{') ? JSON.parse(text) : {})
}

/** This node's live MagicDNS name from `tailscale status --json`: the name tailscale serve uses. */
export function parseSelfName(text: string) {
  const name = z.object({ Self: z.object({ DNSName: z.string() }).passthrough() }).passthrough()
    .parse(JSON.parse(text)).Self.DNSName.replace(/\.$/, '').toLowerCase()
  if (!name) throw new Error('tailscale reports no DNS name for this node: turn on MagicDNS for the tailnet')
  return name
}

/** The routes an install exposed, recorded in `/etc/devchat/routes.json` once tailscale serves them. */
export const routesSchema = settingsSchema.pick({ httpsPort: true, boardPort: true, appPort: true }).strict()
export type Routes = z.infer<typeof routesSchema>

/** devchat's two mounts: path and the loopback target it proxies to. */
const mounts = (routes: Routes) => [
  { path: '/api/board', target: boardUrl(routes) },
  { path: '/', target: `http://127.0.0.1:${routes.appPort}` },
]

type PlanOptions = {
  /** The routes a finished install recorded, so its mounts are found after a change. */
  recorded?: Routes | undefined
  /** Plan only the removal of devchat's mounts. */
  remove?: boolean
}

/**
 * What to change so tailscale serves devchat at `settings`, as lines: `off <port> <path>` for each
 * devchat mount to remove, then `set`, or `unchanged`. devchat owns its HTTPS port: the plan sets
 * routes only on a port that is empty or holds nothing but devchat's mounts, over HTTPS, with
 * Funnel off, and throws, naming what blocks it, otherwise. A devchat mount is a handler at this
 * node's live name `self`, on the recorded or the current port, with devchat's path and target.
 * With `remove`, the plan lists those mounts only, and skips the `--host` check.
 */
export function planServe(status: z.infer<typeof serveStatus>, settings: Settings, self: string, { recorded, remove = false }: PlanOptions = {}) {
  if (!remove && settings.host.toLowerCase() !== self) {
    throw new Error(`--host ${settings.host} is not this node's tailnet name, ${self}: tailscale serves ${self}, so rerun with --host ${self}`)
  }
  const handlersAt = (port: number) => status.Web?.[`${self}:${port}`]?.Handlers ?? {}
  const ours = (port: number) => [settings, ...(recorded ? [recorded] : [])]
    .filter((routes) => routes.httpsPort === port).flatMap(mounts)
  const isOurs = (port: number, path: string, proxy: string | undefined) =>
    ours(port).some((mount) => mount.path === path && mount.target === proxy)
  const lines = [...new Set([...(recorded ? [recorded.httpsPort] : []), settings.httpsPort])]
    .filter((port) => remove || port !== settings.httpsPort)
    .flatMap((port) => Object.entries(handlersAt(port))
      .filter(([path, { Proxy }]) => isOurs(port, path, Proxy)).map(([path]) => `off ${port} ${path}`))
  if (remove) return lines

  const port = settings.httpsPort
  const origin = `${self}:${port}`
  const clear = `clear the port with \`tailscale serve --https=${port} off\` (it removes every route on :${port}, and Funnel), or pick another --https-port`
  const blockers: string[] = []
  for (const [path, { Proxy }] of Object.entries(handlersAt(port))) {
    if (!isOurs(port, path, Proxy)) blockers.push(`${origin}${path} serves ${Proxy ?? 'something other than a proxy'}`)
  }
  for (const key of Object.keys(status.Web ?? {})) {
    if (key !== origin && key.endsWith(`:${port}`)) blockers.push(`${key} shares port ${port}`)
  }
  if (status.AllowFunnel?.[origin]) blockers.push(`Funnel is on for ${origin}`)
  const listener = status.TCP?.[String(port)]
  const https = listener !== undefined && listener.HTTPS === true && Object.keys(listener).length === 1
  if (listener && !https) blockers.push(`port ${port} is not only an HTTPS listener: ${JSON.stringify(listener)}${listener.TCPForward ? ` (a TCP forward clears with \`tailscale serve --tcp=${port} off\`)` : ''}`)
  if (!listener && Object.keys(handlersAt(port)).length > 0) blockers.push(`${origin} has routes but no HTTPS listener`)
  if (blockers.length > 0) throw new Error(`devchat needs port ${port} to itself: ${blockers.join('; ')}. To use it, ${clear}`)

  const handlers = handlersAt(port)
  const exact = https && Object.keys(handlers).length === 2 && mounts(settings).every(({ path, target }) => handlers[path]?.Proxy === target)
  if (!exact) return [...lines, 'set']
  return lines.length > 0 ? lines : ['unchanged']
}
