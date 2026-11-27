import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('The app serves the built shell at / and its listed files, and nothing outside them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'devchat-shell-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>devchat</title>')
  await writeFile(join(dir, 'assets', 'app-1a2b.js'), 'console.log(1)')
  await writeFile(join(dir, 'notes.txt'), 'not a shell file')

  const app = createApp({ version: '0.0.0', shell: dir, openBoard: () => { throw new Error('no board in this test') } })
  app.listen(0, '127.0.0.1')
  await once(app, 'listening')
  t.after(() => app.close())
  const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`

  const page = await fetch(`${url}/`)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('cache-control'), 'no-cache')
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/)
  assert.equal(await page.text(), '<!doctype html><title>devchat</title>')
  const script = await fetch(`${url}/assets/app-1a2b.js`)
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.match(script.headers.get('cache-control') ?? '', /immutable/)
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff')
  assert.equal((await fetch(`${url}/`, { method: 'HEAD' })).status, 200)
  assert.equal((await fetch(`${url}/`, { method: 'POST' })).status, 405)
  for (const path of ['/notes.txt', '/assets/../index.html.bak', '/%2e%2e/package.json', '/assets/missing.js', '/assets']) {
    assert.equal((await fetch(`${url}${path}`)).status, 404, path)
  }
  // Without a build the app still starts, and serves no shell.
  const bare = createApp({ version: '0.0.0', shell: join(dir, 'missing') })
  bare.listen(0, '127.0.0.1')
  await once(bare, 'listening')
  t.after(() => bare.close())
  assert.equal((await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/`)).status, 404)
})
