import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { forgedTailnetClient, type BoardRequest } from '../host/board-http.ts'

type BoardServerOptions = {
  directory?: string
  host?: string
  login?: string
  /** Serve the fake tailnet host, as `vb serve --tailscale` does. On by default. */
  tailscale?: boolean
}

const boardConfig = z.object({
  url: z.string(),
  token: z.string().min(1),
})

/** The loopback client that acts as the fake tailnet login. */
function tailnetClient(options: { url: string; host: string; login: string }) {
  const send = forgedTailnetClient(options)
  return { request: (path: string, init?: BoardRequest) => send(path, init) }
}

export async function startBoardServer({
  directory = tmpdir(),
  host = 'board.example.test',
  login = 'user@example.com',
  tailscale = true,
}: BoardServerOptions = {}) {
  const cli = fileURLToPath(new URL('./dist/cli.mjs', import.meta.resolve('@vercel/board/package.json')))
  // Absolute, because the child resolves paths from its own working directory.
  const runDir = await mkdtemp(join(resolve(directory), 'devchat-board-'))
  const configHome = join(runDir, 'config')

  // Starts `vb serve` and resolves once it has written its owner credential.
  async function launch(port: number, tailnet: boolean) {
    let child: ChildProcessByStdio<null, Readable, null>
    try {
      child = spawn(process.execPath, [
        cli, 'serve', '--port', String(port), '--dir', join(runDir, 'data'),
        ...(tailnet ? ['--tailscale', host] : []), '--no-inspect',
      ], {
        cwd: runDir,
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (error) {
      await rm(runDir, { recursive: true, force: true })
      throw error
    }
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    async function kill() {
      child.kill()
      const forceStop = setTimeout(() => child.kill('SIGKILL'), 2_000)
      await closed
      clearTimeout(forceStop)
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
      return { url, token, kill }
    } catch (error) {
      await kill()
      await rm(runDir, { recursive: true, force: true })
      throw error
    } finally {
      output.close()
      child.stdout.resume()
    }
  }

  let current = await launch(0, tailscale)
  const url = current.url
  const server = {
    url,
    configHome,
    ownerToken: current.token,
    tailnet: tailnetClient({ url, host, login }),
    /**
     * Stops `vb serve` and starts it again on the same port and data, as a service restart does,
     * with or without the fake tailnet host.
     */
    async restart({ tailscale: tailnet = tailscale }: { tailscale?: boolean } = {}) {
      await current.kill()
      current = await launch(Number(new URL(url).port), tailnet)
      server.ownerToken = current.token
    },
    async stop() {
      await current.kill()
      await rm(runDir, { recursive: true, force: true })
    },
  }
  return server
}
