import { board, BoardError, type Board } from '@vercel/board'
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { extname, join, sep } from 'node:path'
import { boardMarker } from '../shared/layout.ts'
import { createBoardPort } from './board-port.ts'
import { createUiRoute, type UiRouteOptions } from './ui-route.ts'

type WriterStats = { inboxSchedulesCanceled: number }
export type AppInfo = { app: 'devchat'; version: string; board: { reachable: boolean }; epoch?: number } & Partial<WriterStats>

/**
 * The board client caches its owner token until it expires and never reads the file again, while
 * each board restart mints a new one. So every request opens a fresh handle, which reads the
 * current token from `vb serve`'s file.
 */
async function describe(openBoard: () => Board, version: string): Promise<Omit<AppInfo, keyof WriterStats>> {
  try {
    const marker = await createBoardPort(openBoard()).getPost(boardMarker.id)
    const epoch = Number(marker.labels.epoch)
    return { app: 'devchat', version, board: { reachable: true }, ...(Number.isInteger(epoch) ? { epoch } : {}) }
  } catch (error) {
    if (error instanceof BoardError && error.code === 'post_not_found') {
      return { app: 'devchat', version, board: { reachable: true } }
    }
    console.error('devchat: board unreachable:', error instanceof Error ? error.message : error)
    return { app: 'devchat', version, board: { reachable: false } }
  }
}

const shellTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
}

/**
 * The page's policy: everything from this origin, and nothing inline but styles, which ui-sdk adds
 * at run time (§12).
 */
const shellPolicy = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self'",
  "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ')

/**
 * The built web UI's files, by URL path, listed once at start. A request names a file in this map
 * or none: no URL is joined into a path. A missing directory serves no shell.
 */
function listShell(dir: string) {
  const files = new Map<string, string>()
  let names: string[]
  try {
    names = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return files
    throw error
  }
  for (const name of names) {
    if (Object.hasOwn(shellTypes, extname(name))) files.set(`/${name.split(sep).join('/')}`, join(dir, name))
  }
  return files
}

/** Answers a GET or HEAD for one of the shell's files: `/` is `index.html`, and `assets/` holds hashed names. */
async function serveShell(files: Map<string, string>, path: string, method: string | undefined, response: ServerResponse) {
  const urlPath = path === '/' ? '/index.html' : path
  const file = files.get(urlPath)
  if (!file) return void response.writeHead(404).end()
  if (method !== 'GET' && method !== 'HEAD') return void response.writeHead(405, { Allow: 'GET, HEAD' }).end()
  const body = await readFile(file)
  response.writeHead(200, {
    'Content-Type': shellTypes[extname(file)],
    'Content-Length': body.length,
    'Cache-Control': urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(urlPath.endsWith('.html') ? { 'Content-Security-Policy': shellPolicy } : {}),
  }).end(method === 'HEAD' ? undefined : body)
}

type AppOptions = {
  version: string
  openBoard?: () => Board
  /** The state writer's counts: `inboxSchedulesCanceled`, which `doctor` reports (§2). */
  writerStats?: () => WriterStats
  /** Serves the UI route under `/api/ui/` (§12). */
  ui?: Omit<UiRouteOptions, 'openBoard'>
  /** The built web UI's directory, which the app serves at `/` (§12). */
  shell?: string
}

/**
 * The app's HTTP server: `/devchat.json`, with `ui` the UI route, and with `shell` the web UI's
 * files. It never sends a token.
 */
export function createApp({ version, openBoard = () => board(), writerStats, ui, shell }: AppOptions) {
  const uiRoute = ui && createUiRoute({ ...ui, openBoard })
  const shellFiles = shell === undefined ? new Map<string, string>() : listShell(shell)
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://app.invalid')
    if (uiRoute && url.pathname.startsWith('/api/ui/')) {
      return void uiRoute(request, response, url).catch((error: unknown) => {
        console.error('devchat: UI route failed:', error instanceof Error ? error.message : error)
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    }
    if (url.pathname !== '/devchat.json') {
      return void serveShell(shellFiles, url.pathname, request.method, response).catch((error: unknown) => {
        console.error('devchat: shell file failed:', error instanceof Error ? error.message : error)
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    }
    if (request.method !== 'GET') return void response.writeHead(405, { Allow: 'GET' }).end()
    describe(openBoard, version).then((info) => {
      const body: AppInfo = { ...info, ...writerStats?.() }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body))
    }, (error: unknown) => {
      console.error('devchat: /devchat.json failed:', error)
      response.writeHead(500).end()
    })
  })
}
