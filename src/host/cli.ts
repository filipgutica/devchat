#!/usr/bin/env node
import { board, type Board } from '@vercel/board'
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { exportBoard } from './export.ts'
import { boardLockProblems, lockBoard, setupBoard } from './grants.ts'
import { parseSelfName, parseServeStatus, planServe, routesSchema, type Routes } from './serve.ts'
import { installSteps, renderPlan, renderScript, uninstallSteps, type Step } from './script.ts'
import { boardUrl, defaultPorts, hostPaths, readSettings, settingsSchema, unitNames, type Settings } from './settings.ts'
import { verifyHost } from './verify.ts'

const usage = `usage: devchat-host <command> [options]

  install     set up the devchat host with one sudo prompt (prints every step first)
              --login <tailnet login> --host <name>.ts.net [--https-port 8443]
              [--board-port 4100] [--app-port 4101] [--node <path>] [--no-expose] [--dry-run]
  verify      run the release 1 trust checks from your own account, without sudo
              --login <tailnet login> --host <name>.ts.net [ports as install] [--no-expose]
  status      show the services and what the app reports   [--app-port 4101] [--wait <seconds>]
  uninstall   reverse install with one sudo prompt
              [--no-expose] [--purge: also delete the board's data] [--dry-run]
  export      write the daily export (the export timer runs it as the service account)
              --config <file> --dir <dir>`

const settingFlags = {
  login: { type: 'string' },
  host: { type: 'string' },
  'https-port': { type: 'string' },
  'board-port': { type: 'string' },
  'app-port': { type: 'string' },
  'no-expose': { type: 'boolean' },
} as const

async function ask(question: string) {
  if (!process.stdin.isTTY) return undefined
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await prompt.question(question)).trim() || undefined
  } finally {
    prompt.close()
  }
}

async function resolveSettings(values: { login?: string; host?: string; 'https-port'?: string; 'board-port'?: string; 'app-port'?: string }): Promise<Settings> {
  const port = (value: string | undefined, fallback: number) => (value === undefined ? fallback : Number(value))
  return settingsSchema.parse({
    login: values.login ?? await ask('Tailnet login (user@example.com): '),
    host: values.host ?? await ask('Host name on the tailnet (<host>.<tailnet>.ts.net): '),
    httpsPort: port(values['https-port'], defaultPorts.httpsPort),
    boardPort: port(values['board-port'], defaultPorts.boardPort),
    appPort: port(values['app-port'], defaultPorts.appPort),
  })
}

/** The npm `node_modules` this CLI was installed into, which install copies to /opt. */
function installedModules() {
  const packageRoot = dirname(dirname(dirname(realpathSync(fileURLToPath(import.meta.url)))))
  const modules = dirname(dirname(packageRoot))
  if (basename(dirname(packageRoot)) !== '@filipgutica' || basename(modules) !== 'node_modules') {
    throw new Error('run devchat-host from an npm install: npm install --ignore-scripts --prefix <dir> @filipgutica/devchat')
  }
  return modules
}

/** Prints the plan, then runs the whole script as root with one sudo prompt. */
function runAsRoot(steps: Step[], dryRun: boolean) {
  console.log(`devchat-host will run these steps as root:\n${renderPlan(steps)}`)
  const script = renderScript(steps)
  if (dryRun) {
    console.log(`\n--- root script ---\n${script}`)
    return 0
  }
  // The script goes as an argument, never as a file the user's account could change while it runs.
  const [command, ...args] = process.getuid?.() === 0 ? ['bash'] : ['sudo', 'bash']
  const result = spawnSync(command ?? 'bash', [...args, '-c', script, 'devchat-host'], { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

async function openBoardWhenReady(waitSeconds: number) {
  const deadline = Date.now() + waitSeconds * 1000
  while (true) {
    // A new handle per attempt: each one reads the owner token file again.
    const handle: Board = board()
    try {
      await handle.me()
      return handle
    } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(500)
    }
  }
}

/** The routes a finished install recorded, if any. */
function readRoutes(file: string = hostPaths.routesFile): Routes | undefined {
  try {
    return routesSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function tailscale(...args: string[]) {
  const result = spawnSync('tailscale', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`tailscale ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`)
  return result.stdout
}

const appInfo = z.object({ board: z.object({ reachable: z.boolean() }) }).passthrough()

async function status(appPort: number, waitSeconds: number) {
  for (const unit of [unitNames.board, unitNames.app, unitNames.exportTimer]) {
    const state = spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8' }).stdout.trim() || 'unknown'
    console.log(`${unit}: ${state}`)
  }
  const deadline = Date.now() + waitSeconds * 1000
  while (true) {
    let line: string
    let ready = false
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/devchat.json`, { signal: AbortSignal.timeout(5_000) })
      const body = await response.text()
      ready = response.ok && appInfo.parse(JSON.parse(body)).board.reachable
      line = `app /devchat.json: ${body}`
    } catch (error) {
      line = `app /devchat.json: not answering (${error instanceof Error ? error.message : error})`
    }
    if (ready || Date.now() > deadline) {
      console.log(line)
      return ready ? 0 : 1
    }
    await sleep(1_000)
  }
}

async function main(argv: string[]) {
  const [command, ...rest] = argv
  switch (command) {
    case 'install': {
      const { values } = parseArgs({ args: rest, options: { ...settingFlags, node: { type: 'string' }, 'dry-run': { type: 'boolean' } } })
      const settings = await resolveSettings(values)
      const expose = !values['no-expose']
      // The same plan the root script runs before it exposes anything, here before any change.
      if (expose) planServe(parseServeStatus(tailscale('serve', 'status', '--json')), settings, parseSelfName(tailscale('status', '--json')), { recorded: readRoutes() })
      const steps = installSteps({
        settings,
        nodeSource: realpathSync(values.node ?? process.execPath),
        modulesSource: installedModules(),
        sourceUid: process.getuid?.() ?? 0,
        sourceGid: process.getgid?.() ?? 0,
        expose,
      })
      const code = runAsRoot(steps, values['dry-run'] ?? false)
      if (code === 0 && !values['dry-run']) {
        console.log(`\nCheck it from your own account: devchat-host verify --login ${settings.login} --host ${settings.host}` +
          ` --https-port ${settings.httpsPort} --board-port ${settings.boardPort} --app-port ${settings.appPort}${expose ? '' : ' --no-expose'}`)
        if (expose) console.log(`devchat: https://${settings.host}:${settings.httpsPort}/`)
      }
      return code
    }
    case 'uninstall': {
      const { values } = parseArgs({ args: rest, options: {
        'no-expose': settingFlags['no-expose'], purge: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
      } })
      return runAsRoot(uninstallSteps({ expose: !values['no-expose'], purge: values.purge ?? false }), values['dry-run'] ?? false)
    }
    case 'verify': {
      const { values } = parseArgs({ args: rest, options: settingFlags })
      const results = await verifyHost(await resolveSettings(values), { expose: !values['no-expose'] })
      for (const { name, ok, detail } of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${detail})`)
      const failed = results.filter(({ ok }) => !ok).length
      console.log(failed === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed} of ${results.length} checks failed.`)
      return failed === 0 ? 0 : 1
    }
    case 'status': {
      const { values } = parseArgs({ args: rest, options: { 'app-port': settingFlags['app-port'], wait: { type: 'string' } } })
      return status(settingsSchema.shape.appPort.parse(Number(values['app-port'] ?? defaultPorts.appPort)), Number(values.wait ?? 0))
    }
    case 'export': {
      const { values } = parseArgs({ args: rest, options: { config: { type: 'string' }, dir: { type: 'string' } } })
      process.env.BOARD_URL = boardUrl(await readSettings(values.config))
      const { file, records, duplicates, pruned } = await exportBoard(board(), values.dir ?? hostPaths.exportDir)
      console.log(`exported ${records} records (${duplicates} with a repeated rid) to ${file}; removed ${pruned.length} old exports`)
      return 0
    }
    // Internal: the install script runs these as the service account, through loopback.
    case 'board-setup': {
      const { values } = parseArgs({ args: rest, options: {
        config: { type: 'string' }, wait: { type: 'string' }, lock: { type: 'boolean' }, 'lock-check': { type: 'boolean' },
      } })
      const settings = await readSettings(values.config)
      process.env.BOARD_URL ??= boardUrl(settings)
      const handle = await openBoardWhenReady(Number(values.wait ?? 30))
      if (values['lock-check']) {
        const problems = await boardLockProblems(handle, settings.login)
        for (const problem of problems) console.log(`not locked: ${problem}`)
        return problems.length === 0 ? 0 : 1
      }
      await (values.lock ? lockBoard : setupBoard)(handle, settings.login, (line) => console.log(line))
      return 0
    }
    case 'serve-plan': {
      const { values } = parseArgs({ args: rest, options: {
        config: { type: 'string' }, routes: { type: 'string' }, status: { type: 'string' }, self: { type: 'string' }, remove: { type: 'boolean' },
      } })
      if (values.status === undefined || values.self === undefined) throw new Error('serve-plan needs --status <file> --self <file>')
      const plan = planServe(parseServeStatus(readFileSync(values.status, 'utf8')), await readSettings(values.config),
        parseSelfName(readFileSync(values.self, 'utf8')), { recorded: readRoutes(values.routes), remove: values.remove ?? false })
      for (const line of plan) console.log(line)
      return 0
    }
    default:
      console.log(usage)
      return command === undefined || command === 'help' || command === '--help' ? 0 : 2
  }
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  const message = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error)
  console.error(`error: ${message}`)
  process.exitCode = 1
}
