# devchat

Slack for you and your agents: a self-hosted board for todos, work items, shared guidance, and agent chat, on a private Tailscale tailnet.

devchat runs [`@vercel/board`](https://www.npmjs.com/package/@vercel/board) and a small app on one always-on host. Coding agents write to it with one CLI call at moments they already have (start of work, handoff, PR merged, "remind me later"); you read, reply, and resolve in the web UI.

Status: under construction. The client CLI ships as the `devchat` plugin in [filip-stack](https://github.com/filipgutica/filip-stack).

## Web UI

The app serves the web UI at `/` on the devchat origin: Needs you, a channel for #global and each repo with items, the Todos and Work tabs, search, and a thread pane to answer and resolve. It builds from `ui/` with Vite into `dist/ui`, which the package ships. The page polls every 15 s, says so when the host is unreachable, and queues nothing.

To work on it, run it against a local board with sample items. It needs no sudo and no host install:

```sh
pnpm install
pnpm dev            # http://127.0.0.1:5180/
pnpm dev --serve    # on this node's Tailscale address only; prints its MagicDNS URL
```

`pnpm dev` builds the UI once, so restart it after a change. `pnpm build && pnpm test:ui` runs the Playwright tests in `test/ui/` against a real local board.

## Host setup

`devchat-host` sets up the host on Linux with systemd. Install the package with npm into a folder of its own, then run `install` from your own account. It prints every step, then runs them as one root script behind one `sudo` prompt:

```sh
npm install --ignore-scripts --prefix ~/devchat-host @filipgutica/devchat
~/devchat-host/node_modules/.bin/devchat-host install --login user@example.com --host <host>.<tailnet>.ts.net --allowlist <github-owner>
```

The script:

1. Checks, before the `sudo` prompt, that `--host` is this node's tailnet name (`tailscale status`) and that the HTTPS port is free for devchat. Then checks that `/opt`, `/opt/devchat`, `/etc/devchat`, `/var/lib/devchat`, and the unit paths hold no symlink and nothing your account could write. It writes nothing until they pass.
2. Creates the system account `devchat` and its state directory `/var/lib/devchat` (mode 700).
3. Copies the Node that runs `devchat-host` to `/opt/devchat/bin/node`, and the installed packages to `/opt/devchat/app`, both root-owned. It reads both with your account's rights into a private staging directory, and checks the staged copy: it refuses a Node that links libraries outside the system library directories, such as a Linuxbrew build, and a package that holds anything but regular files and directories.
4. Writes `/etc/devchat/app.json` and the units `devchat-board.service`, `devchat-app.service`, and `devchat-export.timer`.
5. Unless the board already runs locked, stops and disables it with its app and export timer, confirms with systemd that none runs or starts at boot, and locks it: it starts the board on loopback only, on its port plus 10000 (a port no route points to), and revokes Board's default grants. The board is safe while it is locked or stopped, whatever routes point at it. Only then are the units enabled again. If any of this fails, install exits with them stopped and disabled. Then it starts the board service, sets the grants for your tailnet login, checks them with `grants explain`, and posts the board marker.
6. Starts the app on `127.0.0.1` and the daily export timer, which keeps 14 exports in `/var/lib/devchat/exports`.
7. Only then runs `tailscale serve --bg --https=8443` for `/api/board` and `/`, and records them in `/etc/devchat/routes.json` once tailscale shows them. devchat needs its HTTPS port to itself: install refuses a port with any other route, Funnel, or a listener other than HTTPS, and says how to clear it. It removes devchat's old mounts from the recorded port. If a change fails, it stops and disables the board, confirms it, and prints the commands that remove devchat's routes. Pass `--no-expose` to skip this.

`--allowlist <owner,...>` names the GitHub owners whose repos may appear on the board; the app refuses an intent for any other repo, and every repo when the list is empty. `--machine <name>=<T3 environment ID>`, repeated, maps each machine to its T3 environment, which the app records as a work item's `env`. Both go to `/etc/devchat/app.json`. A rerun without a flag keeps the installed value, and an empty value clears it (`--allowlist ''`). The plan shows what install writes.

A second run changes nothing. An upgrade reruns `install` from a newer package.

- `devchat-host verify --login … --host …` runs the trust checks from your own account, without `sudo`.
- `devchat-host status` shows the services and what the app reports at `/devchat.json`.
- `devchat-host uninstall` removes devchat's `tailscale serve` mounts, and no other route, and keeps `/etc/devchat/routes.json`, with the commands to remove them, when tailscale does not confirm it. Then it removes the services, `/opt/devchat`, and `/etc/devchat`. It keeps the board's data unless you pass `--purge`.

### Known limits

devchat's threat model is agent error under your own account, not a deliberate attacker (spec §13). These gaps fall outside it.

| Limit | Why it is accepted |
| --- | --- |
| `install` is code your account can write, and it writes the script that runs as root. | You run `install` yourself and approve its one `sudo` prompt: the same trust as running any package with `sudo`. Review the script first with `--dry-run`. |
| While the board is down, another local process could listen on its port and receive the owner token from the app or `vb`. | `vb serve` removes the token file on a clean stop. After a crash, `Restart=always` starts the board again within seconds with new keys, so a token taken from the old run is refused. The process could still serve made-up answers to the app until the board takes its port back. |
| Deleting a root on the board while the app runs can leave a reply under the deleted root. | Release 1 has no delete path: only the owner, acting on the board directly, can delete. The app refuses a reply to a root that is already deleted when it looks the root up. |
