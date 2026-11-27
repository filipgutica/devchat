import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

type BoardServerOptions = {
  directory?: string
  host?: string
  login?: string
}

type TailnetRequest = {
  method?: string
  body?: unknown
}

const boardConfig = z.object({
  url: z.string(),
  token: z.string().min(1),
})

function tailnetClient({ url, host, login }: { url: string; host: string; login: string }) {
  const endpoint = new URL(url)
  return {
    request(path: string, { method = 'GET', body }: TailnetRequest = {}) {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const req = request({
          hostname: endpoint.hostname,
          port: endpoint.port,
          path: endpoint.pathname + path,
          method,
          headers: {
            Host: host,
            'Tailscale-User-Login': login,
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          signal: AbortSignal.timeout(5_000),
        }, (res) => {
          res.setEncoding('utf8')
          let text = ''
          res.on('data', (chunk: string) => { text += chunk })
          res.on('error', reject)
          res.on('end', () => resolve({ status: res.statusCode, body: text }))
        })
        req.on('error', reject)
        req.end(payload)
      })
    },
  }
}

export async function startBoardServer({
  directory = tmpdir(),
  host = 'board.example.test',
  login = 'user@example.com',
}: BoardServerOptions = {}) {
  const cli = fileURLToPath(new URL('./dist/cli.mjs', import.meta.resolve('@vercel/board/package.json')))
  const runDir = await mkdtemp(join(directory, 'devchat-board-'))
  const configHome = join(runDir, 'config')
  const child = spawn(process.execPath, [
    cli, 'serve', '--port', '0', '--dir', join(runDir, 'data'),
    '--tailscale', host, '--no-inspect',
  ], {
    cwd: runDir,
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  async function stop() {
    child.kill()
    const forceStop = setTimeout(() => child.kill('SIGKILL'), 2_000)
    await closed
    clearTimeout(forceStop)
    await rm(runDir, { recursive: true, force: true })
  }

  const output = createInterface({ input: child.stdout })
  try {
    await Promise.race([
      once(output, 'line', { signal: AbortSignal.timeout(10_000) }),
      once(child, 'close').then(([code, signal]) => {
        throw new Error(`vb serve stopped during startup (${code ?? signal})`)
      }),
    ])
    const tokenDir = join(configHome, 'board', 'local')
    const [tokenFile] = (await readdir(tokenDir)).filter((name) => name.endsWith('.json'))
    if (!tokenFile) throw new Error('vb serve did not write an owner credential')

    const { url, token } = boardConfig.parse(JSON.parse(await readFile(join(tokenDir, tokenFile), 'utf8')))
    return { url, configHome, ownerToken: token, tailnet: tailnetClient({ url, host, login }), stop }
  } catch (error) {
    await stop()
    throw error
  } finally {
    output.close()
    child.stdout.resume()
  }
}
