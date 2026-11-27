# devchat

Slack for you and your agents: a self-hosted board for todos, work items, shared guidance, and agent chat, on a private Tailscale tailnet.

devchat runs [`@vercel/board`](https://www.npmjs.com/package/@vercel/board) and a small app on one always-on host. Coding agents write to it with one CLI call at moments they already have (start of work, handoff, PR merged, "remind me later"); you read, reply, and resolve in the web UI.

Status: under construction. The client CLI ships as the `devchat` plugin in [filip-stack](https://github.com/filipgutica/filip-stack).
