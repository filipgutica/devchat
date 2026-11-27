import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installSteps, renderPlan, renderScript, uninstallSteps } from '../src/host/script.ts'
import type { Settings } from '../src/host/settings.ts'
import { renderUnits } from '../src/host/units.ts'

const settings: Settings = { login: 'user@example.com', host: 'host.example.ts.net', httpsPort: 8443, boardPort: 4100, appPort: 4101 }
const sources = {
  nodeSource: '/home/user/.nvm/versions/node/v24.0.0/bin/node',
  modulesSource: "/tmp/it's here/node_modules",
  sourceUid: 1000,
  sourceGid: 1000,
}

const bash = (script: string, input = '') => spawnSync('bash', ['-c', script], { input, encoding: 'utf8' })

test('install closes the default grants before the board serves the tailnet, and exposes last', () => {
  const steps = installSteps({ settings, ...sources, expose: true })
  const index = (pattern: RegExp) => steps.findIndex(({ title }) => pattern.test(title))
  const lock = index(/lock it, on loopback only/)
  const boardStart = index(/^Start devchat-board/)
  const grants = index(/the tailnet login's grant/)
  assert.ok(lock > 0 && lock < boardStart && boardStart < grants && grants < index(/^Start devchat-app/))
  assert.equal(index(/expose both on the tailnet/), steps.length - 1)
  const plan = renderPlan(steps)
  assert.match(plan, /^1\. Check the prerequisites/)
  assert.match(plan, new RegExp(`${steps.length}\\. Only now, expose both on the tailnet at https://host\\.example\\.ts\\.net:8443/$`))

  // The lock runs on loopback only, on a port no route points to; --tailscale arrives with the unit.
  const serves = (steps[lock]?.bash ?? '').split('\n').filter((line) => line.includes('cli.mjs serve'))
  assert.equal(serves.length, 2)
  for (const line of serves) assert.match(line, /serve --port 14100 .*--no-inspect'?( >\/dev\/null 2>&1 &)?$/)
  // A board that is not running locked stops, confirmed, before the lock; no route is touched.
  assert.match(steps[lock]?.bash ?? '', /board_setup --lock-check[\s\S]*disable_board \|\| fail[\s\S]*board_setup --lock --board-port 14100[\s\S]*systemctl enable/)
  assert.doesNotMatch(steps[lock]?.bash ?? '', /apply_serve_plan|serve_plan/)
})

test('install checks every destination before its first write, and stages only in its own directory', () => {
  const script = renderScript(installSteps({ settings, ...sources, expose: true }))
  const firstWrite = script.indexOf('ensure_dir /opt/devchat root')
  for (const path of ['/opt/devchat', '/opt/devchat/app', '/etc/devchat/app.json', '/etc/systemd/system/devchat-board.service']) {
    const check = script.indexOf(`safe_path ${path}\n`)
    assert.ok(check > 0 && check < firstWrite, path)
  }
  assert.ok(script.indexOf('safe_path /var/lib/devchat/config /var/lib/devchat devchat') < firstWrite)
  assert.match(script, /^unset TMPDIR$/m)
  assert.doesNotMatch(script.replaceAll('mktemp -p "$STAGE"', ''), /\bmktemp\b|\bcp -R/)
  // Root reads the sources as their owner and checks the staged snapshot, never the source.
  assert.match(script, /"\$\{AS_SOURCE\[@\]\}" cat "\$NODE_SRC" > "\$staged"/)
  assert.match(script, /"\$\{AS_SOURCE\[@\]\}" tar -C "\$MODULES_SRC" --exclude=\.bin -cf - \./)
  assert.match(script, /find "\$STAGE\/app" ! -type f ! -type d -print -quit/)
  assert.match(script, /ldd "\$staged"/)
})

test('safe_path refuses a symlink and a world-writable directory on the path', (t) => {
  // A sandbox that maps root to another user shows system files as someone else's.
  if (bash('stat -c %U /etc/systemd/system').stdout.trim() !== 'root') return t.skip('system files are not root-owned here')
  const safePath = (path: string) => bash(renderScript([{ title: 'path', bash: `safe_path ${path}` }]))
  // install checks this directory on every host it runs on.
  for (const path of ['/etc/systemd/system', '/etc/systemd/system/devchat-missing/x']) {
    const result = safePath(path)
    assert.equal(result.status, 0, `${path}: ${result.stderr}`)
  }
  const tmp = safePath('/tmp/devchat-x')
  assert.equal(tmp.status, 1)
  assert.match(tmp.stderr, /\/tmp is group- or world-writable/)
  const link = bash('ls -ld /bin').stdout.startsWith('l') ? safePath('/bin/sh') : undefined
  if (link) assert.match(link.stderr, /\/bin is a symlink/)
})

test('--no-expose leaves tailscale out of install, and uninstall keeps data unless --purge', () => {
  const local = installSteps({ settings, ...sources, expose: false })
  assert.ok(!local.some(({ title }) => /expose/.test(title)))
  assert.doesNotMatch(renderScript(local), /^plan=\$\(serve_plan\)/m)
  const kept = renderScript(uninstallSteps({ expose: true, purge: false }))
  // Uninstall removes devchat's mounts as planned from the recorded routes, never a whole port, and
  // forgets the record only once a fresh plan finds none left.
  assert.match(kept, /\[ -z "\$plan" \] \\\n\s+&& run rm -f \/etc\/devchat\/routes\.json/)
  assert.match(kept, /if \[ -e \/etc\/devchat\/routes\.json \]; then\n  run rm -f \/etc\/devchat\/app\.json/)
  assert.doesNotMatch(kept, /tailscale serve --https=\S+ off/)
  assert.doesNotMatch(kept, /userdel|rm -rf \/var\/lib\/devchat/)
  assert.match(renderScript(uninstallSteps({ expose: false, purge: true })), /userdel devchat/)
})

test('the root scripts parse, and quote the source paths', () => {
  for (const script of [
    renderScript(installSteps({ settings, ...sources, expose: true })),
    renderScript(uninstallSteps({ expose: true, purge: true })),
  ]) {
    const result = bash(`set -n\n${script}`)
    assert.equal(result.status, 0, result.stderr)
  }
  assert.match(renderScript(installSteps({ settings, ...sources, expose: true })), /MODULES_SRC='\/tmp\/it'\\''s here\/node_modules'/)
})

test('the Node check refuses missing libraries and libraries outside the system directories', () => {
  const foreignLibs = (ldd: string) => bash(renderScript([{ title: 'libs', bash: 'foreign_libs' }]), ldd)
    .stdout.split('\n').filter((line) => line && !line.startsWith('==>') && !line.startsWith('Done'))
  const system = [
    '\tlinux-vdso.so.1 (0x00007ffd)',
    '\tlibdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x00007f1)',
    '\tlibstdc++.so.6 => /usr/lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f2)',
    '\t/lib64/ld-linux-x86-64.so.2 (0x00007f3)',
  ].join('\n')
  assert.deepEqual(foreignLibs(system), [])
  assert.deepEqual(foreignLibs(`${system}\n\tlibstdc++.so.6 => /home/linuxbrew/.linuxbrew/lib/libstdc++.so.6 (0x1)`),
    ['\tlibstdc++.so.6 => /home/linuxbrew/.linuxbrew/lib/libstdc++.so.6 (0x1)'])
  assert.deepEqual(foreignLibs('\tlibicu.so.74 => not found'), ['\tlibicu.so.74 => not found'])
})

test('the units run root-owned files as the service account, with no access to any home', () => {
  const units = renderUnits(settings)
  const board = units['devchat-board.service'] ?? ''
  const app = units['devchat-app.service'] ?? ''
  assert.match(board, /^ExecStart=\/opt\/devchat\/bin\/node \/opt\/devchat\/app\/node_modules\/@vercel\/board\/dist\/cli\.mjs serve --port 4100 --dir \/var\/lib\/devchat\/board --no-open --no-inspect --tailscale host\.example\.ts\.net --tailscale host\.example\.ts\.net:8443$/m)
  for (const line of ['Restart=always', 'RuntimeMaxSec=14d']) assert.ok(board.includes(`\n${line}\n`), line)
  for (const line of ['Requires=devchat-board.service', 'PartOf=devchat-board.service', 'Restart=always']) assert.ok(app.includes(`\n${line}\n`), line)
  for (const [name, text] of Object.entries(units)) {
    if (!name.endsWith('.service')) continue
    for (const line of ['User=devchat', 'ProtectHome=yes', 'Environment=XDG_CONFIG_HOME=/var/lib/devchat/config']) {
      assert.ok(text.includes(`\n${line}\n`), `${name}: ${line}`)
    }
    const execStart = /^ExecStart=(\S+) (\S+)/m.exec(text)
    assert.equal(execStart?.[1], '/opt/devchat/bin/node', name)
    assert.ok(execStart?.[2]?.startsWith('/opt/devchat/app/'), name)
  }
})

/** Runs one install step with the install script's helpers, the given stubs, and a private staging directory. */
function runStep(pattern: RegExp, stubs: string) {
  const steps = installSteps({ settings, ...sources, expose: true })
  const first = steps[0]?.bash ?? ''
  const step = steps.find(({ title }) => pattern.test(title))
  const stage = mkdtempSync(join(tmpdir(), 'devchat-stage-'))
  try {
    return bash(renderScript([{ title: 'stubbed', bash: `STAGE=${stage}\n${first.slice(first.indexOf('board_setup() {'))}\n${stubs}\n${step?.bash}` }]))
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** systemctl stubs: the board runs, and systemd reports `state` and `enabled` for every unit. */
const systemctl = (state: string, enabled = 'disabled') =>
  `systemctl() { case "$1" in is-active) return 0 ;; show) echo ${state} ;; is-enabled) echo ${enabled} ;; *) echo "systemctl $*" ;; esac; }`
const disabled = /systemctl disable --now devchat-export\.timer devchat-board\.service devchat-app\.service[\s\S]*stopped and disabled [^\n]*, confirmed/

test('a board that is not locked is stopped and disabled, confirmed, and locked on loopback without touching any route', () => {
  const relock = (tailscale: string, state = 'inactive', enabled = 'disabled') => runStep(/lock it, on loopback only/, `
${systemctl(state, enabled)}
board_setup() { echo "board_setup $*"; [ "$1" != --lock-check ]; }
AS_DEVCHAT=(env)
tailscale() { ${tailscale}; }`)
  // Any failed relock leaves all three units stopped and disabled, so no reboot starts them.
  const noStatus = relock('return 1')
  assert.equal(noStatus.status, 1)
  assert.match(noStatus.stdout, disabled)
  assert.match(noStatus.stderr, /tailscale serve status failed; the board stays stopped and disabled/)
  assert.doesNotMatch(noStatus.stdout, /board_setup --lock |systemctl (enable|start|restart)/)
  const routed = relock(`echo '{"Web":{"h:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:14100"}}}}}'`)
  assert.equal(routed.status, 1)
  assert.match(routed.stdout, disabled)
  assert.match(routed.stderr, /a tailscale serve route points at port 14100; the board stays stopped and disabled/)
  assert.doesNotMatch(routed.stdout, /systemctl enable/)
  // A unit systemd does not report stopped and disabled is never relocked, and install says so.
  for (const [state, enabled, problem] of [['active', 'disabled', /devchat-export\.timer is active/], ['inactive', 'enabled', /devchat-export\.timer is enabled at boot/]] as const) {
    const result = relock('return 1', state, enabled)
    assert.equal(result.status, 1)
    assert.match(result.stderr, problem)
    assert.match(result.stderr, /could not be confirmed stopped and disabled/)
    assert.doesNotMatch(result.stdout, /, confirmed|board_setup --lock |systemctl enable/)
  }
  // A successful relock enables the units again only after the lock.
  const locked = relock(`echo '{}'`)
  assert.equal(locked.status, 0, locked.stderr)
  assert.match(locked.stdout, new RegExp(`${disabled.source}[\\s\\S]*board_setup --lock --board-port 14100\\n[\\s\\S]*systemctl enable devchat-export\\.timer devchat-board\\.service devchat-app\\.service`))
})

test('a failure after the routes change stops and disables the board, confirmed, and names the commands that remove its routes', () => {
  const expose = (state: string) => runStep(/^Only now, expose/, `
${systemctl(state)}
serve_plan() { echo set; }
tailscale() { echo "tailscale $*"; case "$*" in *'--set-path=/ http'*) return 1 ;; esac; }`)
  const stopped = expose('inactive')
  assert.equal(stopped.status, 1)
  assert.match(stopped.stdout, disabled)
  assert.match(stopped.stderr, /applying the tailnet routes failed[\s\S]*the board is stopped and disabled, so devchat's routes reach nothing\. Remove them with: tailscale serve --https=8443 --set-path=\/api\/board off; tailscale serve --https=8443 --set-path=\/ off/)
  assert.doesNotMatch(stopped.stdout, / off$/m)
  const running = expose('active')
  assert.equal(running.status, 1)
  assert.match(running.stderr, /could not be confirmed stopped and disabled/)
  assert.doesNotMatch(running.stderr + running.stdout, /the board is stopped|, confirmed/)
})
