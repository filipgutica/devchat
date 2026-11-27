import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { GrantView } from '@vercel/board'
import { desiredGrants, lockProblems } from '../src/host/grants.ts'
import { parseSelfName, parseServeStatus, planServe } from '../src/host/serve.ts'
import { rootFileProblems, settingsSchema, type Settings } from '../src/host/settings.ts'
import { parseUnitShow } from '../src/host/verify.ts'

const settings: Settings = { login: 'user@example.com', host: 'host.example.ts.net', httpsPort: 8443, boardPort: 4100, appPort: 4101, allowlist: [], machines: {} }
/** A serve status with HTTPS listeners on every port the routes use, and Funnel on for `funnel`. */
const web = (routes: Record<string, Record<string, string>>, { funnel = [] as string[], http = [] as string[] } = {}) => JSON.stringify({
  TCP: Object.fromEntries(Object.keys(routes).map((origin) => [origin.slice(origin.lastIndexOf(':') + 1), http.includes(origin) ? { HTTP: true } : { HTTPS: true }])),
  Web: Object.fromEntries(Object.entries(routes).map(([origin, handlers]) =>
    [origin, { Handlers: Object.fromEntries(Object.entries(handlers).map(([path, proxy]) => [path, { Proxy: proxy }])) }])),
  AllowFunnel: Object.fromEntries(funnel.map((origin) => [origin, true])),
})
const t3 = { '/': 'http://127.0.0.1:3773' }
const metrics = { '/metrics': 'http://127.0.0.1:9100' }
const devchat = (board: number, app: number) => ({ '/api/board': `http://127.0.0.1:${board}/api/board`, '/': `http://127.0.0.1:${app}` })
const ours = 'host.example.ts.net:8443'

const self = 'host.example.ts.net'
const plan = (status: string, options = {}, host = self) => planServe(parseServeStatus(status), settings, host, options)

test('planServe sets the routes only on a port devchat has to itself, over HTTPS with Funnel off', () => {
  assert.deepEqual(plan('No serve config'), ['set'])
  assert.deepEqual(plan(web({ 'host.example.ts.net:443': t3 })), ['set'])
  assert.deepEqual(plan(web({ 'host.example.ts.net:443': t3, [ours]: devchat(4100, 4101) })), ['unchanged'])
  // A partial set, or devchat's recorded targets on the same port, is devchat's to set again.
  assert.deepEqual(plan(web({ [ours]: { '/': 'http://127.0.0.1:4101' } })), ['set'])
  assert.deepEqual(plan(web({ [ours]: devchat(4200, 4201) }), { recorded: { httpsPort: 8443, boardPort: 4200, appPort: 4201 } }), ['set'])
  // Anything else on the port refuses, with nothing to apply, and says how to clear it.
  for (const [status, blocker] of [
    [web({ [ours]: { ...devchat(4100, 4101), ...metrics } }), /:8443\/metrics serves http:\/\/127\.0\.0\.1:9100/],
    [web({ [ours]: { ...devchat(4100, 4101), '/api/board/': 'http://127.0.0.1:4100/api/board' } }), /:8443\/api\/board\/ serves/],
    [web({ [ours]: devchat(4100, 4200) }), /:8443\/ serves http:\/\/127\.0\.0\.1:4200/],
    [web({ [ours]: devchat(4100, 4101) }, { funnel: [ours] }), /Funnel is on for host\.example\.ts\.net:8443/],
    [web({ [ours]: devchat(4100, 4101) }, { http: [ours] }), /port 8443 is not only an HTTPS listener/],
    [web({ 'svc.example.ts.net:8443': t3 }), /svc\.example\.ts\.net:8443 shares port 8443/],
    [JSON.stringify({ Foreground: { s1: { TCP: { 8443: { HTTPS: true } } } } }), /a foreground tailscale serve session \(s1\) uses port 8443: stop that session/],
  ] as const) {
    assert.throws(() => plan(status), (error: Error) => blocker.test(error.message) && error.message.includes('`tailscale serve --https=8443 off`'), String(blocker))
  }
})

test('planServe plans against the live name, and refuses a --host that is not it', () => {
  assert.throws(() => plan('No serve config', {}, 'host.other.ts.net'), /--host host\.example\.ts\.net is not this node's tailnet name, host\.other\.ts\.net/)
  assert.equal(parseSelfName('{"Self":{"DNSName":"Host.Example.ts.net."}}'), self)
  assert.throws(() => parseSelfName('{"Self":{"DNSName":""}}'), /MagicDNS/)
  // Removal needs no --host match: it removes devchat's mounts at the live name.
  assert.deepEqual(plan(web({ 'host.other.ts.net:8443': devchat(4100, 4101) }), { remove: true }, 'host.other.ts.net'), ['off 8443 /api/board', 'off 8443 /'])
})

test('planServe removes only devchat mounts on its recorded and current ports', () => {
  const old = 'host.example.ts.net:9443'
  const recorded = { httpsPort: 9443, boardPort: 4200, appPort: 4201 }
  // An interrupted move from 9443: the record still names it, so its mounts go; /metrics stays.
  assert.deepEqual(plan(web({ [old]: { ...devchat(4200, 4201), ...metrics } }), { recorded }), ['off 9443 /api/board', 'off 9443 /', 'set'])
  assert.deepEqual(plan(web({ [old]: devchat(4200, 4201), [ours]: devchat(4100, 4101) }), { recorded }), ['off 9443 /api/board', 'off 9443 /'])
  assert.deepEqual(plan(web({ [old]: { ...devchat(4200, 4201), ...metrics }, [ours]: devchat(4100, 4101) }), { recorded, remove: true }),
    ['off 9443 /api/board', 'off 9443 /', 'off 8443 /api/board', 'off 8443 /'])
  // Without the record, a port devchat never recorded is someone else's.
  assert.deepEqual(plan(web({ [old]: devchat(4200, 4201) })), ['set'])
  assert.deepEqual(plan(web({ [old]: devchat(4200, 4201) }), { remove: true }), [])
})

test('lockProblems accepts only devchat grants, with the login grant at most as intended', () => {
  const grant = (id: string, principals: GrantView['principals'], can: GrantView['can']): GrantView =>
    ({ id, principals, can, capped: false, by: null, at: null })
  const user = (userId: string) => ({ kind: 'user' as const, userId, email: null })
  const desired = desiredGrants({ login: 'user@example.com', account: 'devchat' })
  const closed = grant('g4', [{ kind: 'everyone' }], { '*': [] })
  const owner = grant('g5', [user('devchat')], { '*': 'all' })
  const tailnet = grant('g6', [user('user@example.com')], Object.fromEntries(
    Object.entries(desired[2]?.can ?? {}).map(([pattern, can]) => [pattern, can === 'all' || can === 'none' ? [] : [...can]])))
  assert.deepEqual(lockProblems([closed, owner], desired), [])
  assert.deepEqual(lockProblems([closed, owner, tailnet], desired), [])
  assert.deepEqual(lockProblems([grant('g1', [{ kind: 'all-users' }], { '*': 'all' }), closed, owner], desired),
    ["g1 is not one of devchat's grants"])
  assert.deepEqual(lockProblems([closed, owner, grant('g9', [{ kind: 'everyone' }], { todos: ['read'] })], desired),
    ["g9 is not one of devchat's grants"])
  // The login with more than its split is as unsafe as a default grant.
  assert.deepEqual(lockProblems([closed, owner, grant('g7', [user('user@example.com')], { '*': 'all' })], desired),
    ["g7 is not one of devchat's grants"])
  assert.deepEqual(lockProblems([owner], desired), ['missing everyone *='])
})

test('parseUnitShow names every file a unit uses and its environment', () => {
  const shown = [
    'ExecStart={ path=/opt/devchat/bin/node ; argv[]=/opt/devchat/bin/node /opt/devchat/app/x/cli.mjs serve --port 4100 --dir /var/lib/devchat/board ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
    'Environment=HOME=/var/lib/devchat NODE_OPTIONS=--require=/tmp/x.js',
    'EnvironmentFiles=/etc/default/devchat (ignore_errors=yes)',
    'DropInPaths=/usr/lib/systemd/system/service.d/10-timeout-abort.conf /etc/systemd/system/devchat-board.service.d/override.conf',
    'FragmentPath=/etc/systemd/system/devchat-board.service',
  ].join('\n')
  const { files, environment, unshipped } = parseUnitShow(shown)
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
  assert.deepEqual(unshipped, ['EnvironmentFiles'])
  const hooked = parseUnitShow(['ExecStartPre={ path=/bin/sh ; argv[]=/bin/sh -c x ; ignore_errors=no }', 'ExecStop=', 'ExecReload={ path=/bin/kill ; argv[]=/bin/kill -HUP ; ignore_errors=no }'].join('\n'))
  assert.deepEqual(hooked.unshipped, ['ExecStartPre', 'ExecReload'])
})

test('a tailnet login is lowercased at input and must fit Board\'s login rule', () => {
  const parse = (login: string) => settingsSchema.safeParse({ ...settings, login })
  assert.equal(parse(' User@Example.COM ').data?.login, 'user@example.com')
  for (const login of ['user+tag@example.com', '.user@example.com', `${'a'.repeat(65)}@example.com`, 'user@', 'user']) {
    assert.equal(parse(login).success, false, login)
  }
})

test('an app.json from before the allowlist parses with an empty allowlist and machine map', () => {
  const { allowlist: _allowlist, machines: _machines, ...before } = settings
  assert.deepEqual(settingsSchema.parse(before), { ...before, allowlist: [], machines: {} })
  assert.equal(settingsSchema.safeParse({ ...settings, allowlist: ['owner/repo'] }).success, false)
})

test('rootFileProblems trusts only a root-owned regular file that only root can write', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'devchat-routes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'routes.json')
  await writeFile(file, '{}')
  await symlink(file, join(dir, 'link.json'))
  assert.ok((await rootFileProblems(file)).includes(`${file} is not root-owned`))
  assert.ok((await rootFileProblems(join(dir, 'link.json'))).includes(`${join(dir, 'link.json')} is not a regular file`))
})
