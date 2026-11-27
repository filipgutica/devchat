import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { board } from '@vercel/board'
import { createApp } from '../src/server/app.ts'
import { boardMarker } from '../src/shared/layout.ts'
import { startBoardServer } from '../src/testing/index.ts'

test('/devchat.json keeps working across a board restart, which mints a new owner token', async (t) => {
  const server = await startBoardServer()
  t.after(server.stop)
  process.env.BOARD_URL = server.url
  process.env.XDG_CONFIG_HOME = server.configHome
  await board().post(boardMarker.channel, { id: boardMarker.id, text: 'marker', labels: { epoch: '1' } })

  const app = createApp({ version: '1.2.3' })
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  t.after(() => app.close())
  const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
  const info = async () => {
    const response = await fetch(`${url}/devchat.json`)
    assert.equal(response.status, 200)
    return response.text()
  }

  const before = await info()
  assert.deepEqual(JSON.parse(before), { app: 'devchat', version: '1.2.3', board: { reachable: true }, epoch: 1 })
  assert.doesNotMatch(before, new RegExp(server.ownerToken))

  const cached = board()
  await cached.me()
  const oldToken = server.ownerToken
  await server.restart()
  assert.notEqual(server.ownerToken, oldToken)
  // A handle opened before the restart still holds the old token, so the app must not keep one.
  await assert.rejects(cached.me())
  assert.deepEqual(JSON.parse(await info()), JSON.parse(before))

  assert.equal((await fetch(`${url}/other`)).status, 404)
  assert.equal((await fetch(`${url}/devchat.json`, { method: 'POST' })).status, 405)
})
