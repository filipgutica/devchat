import { request } from 'node:http'

export type BoardRequest = { method?: string; body?: unknown }
export type BoardResponse = { status: number | undefined; body: string }
export type BoardRequester = (path: string, options?: BoardRequest) => Promise<BoardResponse>

/**
 * Calls a loopback board as the tailnet login: `tailscale serve` sends `Host: <host>` and
 * `Tailscale-User-Login`, and a loopback caller can forge both (Phase 0). `fetch` cannot set
 * `Host`, so this uses `node:http`.
 */
export function forgedTailnetClient({ url, host, login }: { url: string; host: string; login: string }): BoardRequester {
  const endpoint = new URL(url)
  return (path, { method = 'GET', body } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname + path,
        method,
        headers: {
          Host: host,
          'Tailscale-User-Login': login,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        signal: AbortSignal.timeout(5_000),
      }, (res) => {
        res.setEncoding('utf8')
        let text = ''
        res.on('data', (chunk: string) => { text += chunk })
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode, body: text }))
      })
      req.on('error', reject)
      req.end(payload)
    })
  }
}

/** Calls a board with no credentials: a plain HTTP call, as any program on the host or tailnet can make. */
export function plainClient(url: string): BoardRequester {
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(url + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    return { status: response.status, body: await response.text() }
  }
}
