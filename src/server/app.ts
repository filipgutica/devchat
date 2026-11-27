import { board, BoardError, type Board } from '@vercel/board'
import { createServer } from 'node:http'
import { boardMarker } from '../shared/layout.ts'
import { createBoardPort } from './board-port.ts'

export type AppInfo = { app: 'devchat'; version: string; board: { reachable: boolean }; epoch?: number }

/**
 * The board client caches its owner token until it expires and never reads the file again, while
 * each board restart mints a new one. So every request opens a fresh handle, which reads the
 * current token from `vb serve`'s file.
 */
async function describe(openBoard: () => Board, version: string): Promise<AppInfo> {
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

/** The app's HTTP server. Release 1 serves only `/devchat.json`; it never sends a token. */
export function createApp({ version, openBoard = () => board() }: { version: string; openBoard?: () => Board }) {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://app.invalid').pathname
    if (path !== '/devchat.json') return void response.writeHead(404).end()
    if (request.method !== 'GET') return void response.writeHead(405, { Allow: 'GET' }).end()
    describe(openBoard, version).then((info) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(info))
    }, (error: unknown) => {
      console.error('devchat: /devchat.json failed:', error)
      response.writeHead(500).end()
    })
  })
}
