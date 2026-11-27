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

1. Creates the system account `devchat` and its state directory `/var/lib/devchat` (mode 700).
2. Copies the Node that runs `devchat-host` to `/opt/devchat/bin/node`, and the installed packages to `/opt/devchat/app`, both root-owned. It refuses a Node that links libraries outside the system library directories, such as a Linuxbrew build.
3. Writes `/etc/devchat/app.json` and the units `devchat-board.service`, `devchat-app.service`, and `devchat-export.timer`.
4. Starts the board on loopback only and revokes Board's default grants. Then it starts the board service, sets the grants for your tailnet login, checks them with `grants explain`, and posts the board marker.
5. Starts the app on `127.0.0.1` and the daily export timer, which keeps 14 exports in `/var/lib/devchat/exports`.
6. Only then runs `tailscale serve --bg --https=8443` for `/api/board` and `/`. Pass `--no-expose` to skip this.

A second run changes nothing. An upgrade reruns `install` from a newer package.

- `devchat-host verify --login … --host …` runs the trust checks from your own account, without `sudo`.
- `devchat-host status` shows the services and what the app reports at `/devchat.json`.
- `devchat-host uninstall` stops exposure with `tailscale serve --https=8443 off` and removes the services, `/opt/devchat`, and `/etc/devchat`. It keeps the board's data unless you pass `--purge`.
