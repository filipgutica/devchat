# devchat

Slack for you and your agents: a self-hosted board for todos, work items, shared guidance, and agent chat, on a private Tailscale tailnet.

devchat runs [`@vercel/board`](https://www.npmjs.com/package/@vercel/board) and a small app on one always-on host. Coding agents write to it with one CLI call at moments they already have (start of work, handoff, PR merged, "remind me later"); you read, reply, and resolve in the web UI.

Status: under construction. The client CLI ships as the `devchat` plugin in [filip-stack](https://github.com/filipgutica/filip-stack).

## Host setup

`devchat-host` sets up the host on Linux with systemd. Install the package with npm into a folder of its own, then run `install` from your own account. It prints every step, then runs them as one root script behind one `sudo` prompt:

```sh
npm install --ignore-scripts --prefix ~/devchat-host @filipgutica/devchat
~/devchat-host/node_modules/.bin/devchat-host install --login user@example.com --host <host>.<tailnet>.ts.net
```

The script:

1. Checks that `/opt`, `/opt/devchat`, `/etc/devchat`, `/var/lib/devchat`, and the unit paths hold no symlink and nothing your account could write. It writes nothing until they pass.
2. Creates the system account `devchat` and its state directory `/var/lib/devchat` (mode 700).
3. Copies the Node that runs `devchat-host` to `/opt/devchat/bin/node`, and the installed packages to `/opt/devchat/app`, both root-owned. It reads both with your account's rights into a private staging directory, and checks the staged copy: it refuses a Node that links libraries outside the system library directories, such as a Linuxbrew build, and a package that holds anything but regular files and directories.
4. Writes `/etc/devchat/app.json` and the units `devchat-board.service`, `devchat-app.service`, and `devchat-export.timer`.
5. Starts the board on loopback only and revokes Board's default grants. A running board with any grant but devchat's own stops at once, loses its tailnet routes, and is locked again the same way. Then it starts the board service, sets the grants for your tailnet login, checks them with `grants explain`, and posts the board marker.
6. Starts the app on `127.0.0.1` and the daily export timer, which keeps 14 exports in `/var/lib/devchat/exports`.
7. Only then runs `tailscale serve --bg --https=8443` for `/api/board` and `/`, after comparing the routes tailscale has registered. It removes devchat's old mounts, found by the recorded host and targets, and leaves every other route alone. It checks that the port serves HTTPS with Funnel off. Pass `--no-expose` to skip this.

A second run changes nothing. An upgrade reruns `install` from a newer package.

- `devchat-host verify --login … --host …` runs the trust checks from your own account, without `sudo`.
- `devchat-host status` shows the services and what the app reports at `/devchat.json`.
- `devchat-host uninstall` removes devchat's `tailscale serve` mounts, and no other route, then removes the services, `/opt/devchat`, and `/etc/devchat`. It keeps the board's data unless you pass `--purge`.

### Known limits

devchat's threat model is agent error under your own account, not a deliberate attacker (spec §13). These two gaps fall outside it.

| Limit | Why it is accepted |
| --- | --- |
| `install` is code your account can write, and it writes the script that runs as root. | You run `install` yourself and approve its one `sudo` prompt: the same trust as running any package with `sudo`. Review the script first with `--dry-run`. |
| While the board is down, another local process could listen on its port and receive the owner token from the app or `vb`. | `vb serve` removes the token file on a clean stop. After a crash, `Restart=always` starts the board again within seconds with new keys, so a token taken from the old run is refused. The process could still serve made-up answers to the app until the board takes its port back. |
