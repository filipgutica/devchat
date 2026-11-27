import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { z } from 'zod'
import { startBoardServer } from '../src/testing/index.ts'

const openapi = z.object({
  info: z.object({ version: z.literal('0.56.1') }),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
})

test('vb serve integration', async (t) => {
  const server = await startBoardServer()
  t.after(server.stop)

  await t.test('the pinned OpenAPI lists every board port route', async () => {
    const response = await fetch(`${server.url}/openapi.json`)
    assert.equal(response.status, 200)
    const document = openapi.parse(await response.json())
    for (const [method, path] of [
      ['post', '/messages'],
      ['get', '/messages'],
      ['get', '/messages/{id}'],
      ['get', '/posts/{id}'],
      ['get', '/threads'],
      ['post', '/messages/{id}/labels'],
      ['get', '/schedules'],
      ['post', '/schedules/{id}/cancel'],
      ['post', '/grants/batch'],
      ['post', '/grants/{id}/revoke'],
    ] as const) {
      assert.ok(document.paths[path]?.[method], `${method.toUpperCase()} ${path}`)
    }
  })

  await t.test('the Node handle discovers the owner token via XDG_CONFIG_HOME', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
      import { board } from '@vercel/board'
      const me = await board().me()
      console.log(me.principal.startsWith('local:user:') && me.can['*']?.includes('manage'))
    `], {
      env: { ...process.env, XDG_CONFIG_HOME: server.configHome, BOARD_URL: server.url, BOARD_TOKEN: '', BOARD_PROFILE: '' },
    })
    assert.equal(stdout.trim(), 'true')
  })

  await t.test('the loopback HTTP client acts as the fake tailnet login', async () => {
    const response = await server.tailnet.request('/me')
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).principal, 'tailscale:user:user@example.com')
  })
})
