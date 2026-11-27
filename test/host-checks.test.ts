import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GrantView } from '@vercel/board'
import { lockProblems } from '../src/host/grants.ts'
import { parseServeStatus, planServe } from '../src/host/serve.ts'
import { settingsSchema, type Settings } from '../src/host/settings.ts'
import { parseUnitShow } from '../src/host/verify.ts'

const settings: Settings = { login: 'user@example.com', host: 'host.example.ts.net', httpsPort: 8443, boardPort: 4100, appPort: 4101 }
const web = (routes: Record<string, Record<string, string>>) => JSON.stringify({
  Web: Object.fromEntries(Object.entries(routes).map(([origin, handlers]) =>
    [origin, { Handlers: Object.fromEntries(Object.entries(handlers).map(([path, proxy]) => [path, { Proxy: proxy }])) }])),
})
const t3 = { '/': 'http://127.0.0.1:3773' }
const devchat = (board: number, app: number) => ({ '/api/board': `http://127.0.0.1:${board}/api/board`, '/': `http://127.0.0.1:${app}` })

test('planServe sets the routes once, removes devchat routes left on another port, and spares other services', () => {
  const plan = (status: string, options = {}) => planServe(parseServeStatus(status), settings, options)
  assert.deepEqual(plan('No serve config'), ['set'])
  assert.deepEqual(plan(web({ 'host.example.ts.net:443': t3 })), ['set'])
  assert.deepEqual(plan(web({ 'host.example.ts.net:443': t3, 'host.example.ts.net:8443': devchat(4100, 4101) })), ['unchanged'])
  assert.deepEqual(plan(web({ 'host.example.ts.net:8443': devchat(4100, 4199) })), ['off 8443', 'set'])
  assert.deepEqual(plan(web({ 'host.example.ts.net:443': t3, 'host.example.ts.net:9443': devchat(4100, 4101) })), ['off 9443', 'set'])
  assert.deepEqual(plan(web({ 'host.example.ts.net:443': t3, 'host.example.ts.net:9443': devchat(4100, 4101) }), { remove: true }), ['off 9443'])
  assert.throws(() => plan(web({ 'host.example.ts.net:8443': t3 })), /already serves something else/)
})

test('lockProblems accepts only a board with no group grant and nothing for everyone', () => {
  const grant = (id: string, principals: GrantView['principals'], can: GrantView['can']): GrantView =>
    ({ id, principals, can, capped: false, by: null, at: null })
  const closed = grant('g4', [{ kind: 'everyone' }], { '*': [] })
  const owner = grant('g5', [{ kind: 'user', userId: 'devchat', email: null }], { '*': 'all' })
  assert.deepEqual(lockProblems([closed, owner]), [])
  assert.deepEqual(lockProblems([grant('g1', [{ kind: 'all-users' }], { '*': 'all' }), closed, owner]), ['g1 names a group'])
  assert.deepEqual(lockProblems([closed, owner, grant('g9', [{ kind: 'everyone' }], { 'todos': ['read'] })]), ['g9 gives everyone access'])
  assert.deepEqual(lockProblems([owner]), ["no grant gives everyone nothing at '*'"])
})

test('parseUnitShow names every file a unit uses and its environment', () => {
  const shown = [
    'ExecStart={ path=/opt/devchat/bin/node ; argv[]=/opt/devchat/bin/node /opt/devchat/app/x/cli.mjs serve --port 4100 --dir /var/lib/devchat/board ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
    'Environment=HOME=/var/lib/devchat NODE_OPTIONS=--require=/tmp/x.js',
    'EnvironmentFiles=/etc/default/devchat (ignore_errors=yes)',
    'DropInPaths=/usr/lib/systemd/system/service.d/10-timeout-abort.conf /etc/systemd/system/devchat-board.service.d/override.conf',
    'FragmentPath=/etc/systemd/system/devchat-board.service',
  ].join('\n')
  const { files, environment } = parseUnitShow(shown)
  assert.deepEqual(files.sort(), [
    '/etc/default/devchat',
    '/etc/systemd/system/devchat-board.service',
    '/etc/systemd/system/devchat-board.service.d/override.conf',
    '/opt/devchat/app/x/cli.mjs',
    '/opt/devchat/bin/node',
    '/usr/lib/systemd/system/service.d/10-timeout-abort.conf',
    '/var/lib/devchat',
    '/var/lib/devchat/board',
  ])
  assert.deepEqual(environment, ['HOME=/var/lib/devchat', 'NODE_OPTIONS=--require=/tmp/x.js'])
})

test('a tailnet login is lowercased at input and must fit Board\'s login rule', () => {
  const parse = (login: string) => settingsSchema.safeParse({ ...settings, login })
  assert.equal(parse(' User@Example.COM ').data?.login, 'user@example.com')
  for (const login of ['user+tag@example.com', '.user@example.com', `${'a'.repeat(65)}@example.com`, 'user@', 'user']) {
    assert.equal(parse(login).success, false, login)
  }
})
