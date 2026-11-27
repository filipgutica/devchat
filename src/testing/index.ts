import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'

export { startBoardServer } from './board-server.ts'

export function createMemoryBoard() {
  const backend = local({ memory: true })
  return { handle: board({ backend }), close: () => backend.close() }
}
