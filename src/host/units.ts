import { appMain, boardCli, hostCli, hostPaths, tailnetHost, unitNames, type Settings } from './settings.ts'

/** Hardening shared by every devchat unit: no access to any home, and writes only in the state directory. */
const sandbox = [
  `User=${hostPaths.account}`,
  `Group=${hostPaths.account}`,
  `Environment=HOME=${hostPaths.stateDir}`,
  `Environment=XDG_CONFIG_HOME=${hostPaths.configHome}`,
  `WorkingDirectory=${hostPaths.stateDir}`,
  'UMask=0077',
  'NoNewPrivileges=yes',
  'ProtectHome=yes',
  'ProtectSystem=strict',
  `ReadWritePaths=${hostPaths.stateDir}`,
  'PrivateTmp=yes',
]

export function boardServeArgs(settings: Settings, { tailnet }: { tailnet: boolean }) {
  return [
    hostPaths.node, boardCli, 'serve',
    '--port', String(settings.boardPort),
    '--dir', hostPaths.boardDir,
    '--no-open', '--no-inspect',
    ...(tailnet ? ['--tailscale', settings.host, '--tailscale', tailnetHost(settings)] : []),
  ]
}

const unit = (sections: Record<string, string[]>) =>
  Object.entries(sections).map(([name, lines]) => [`[${name}]`, ...lines].join('\n')).join('\n\n') + '\n'

/** The systemd units install writes, by file name. */
export function renderUnits(settings: Settings): Record<string, string> {
  return {
    [unitNames.board]: unit({
      Unit: ['Description=devchat board (vb serve, loopback only)', 'After=network.target'],
      Service: [
        ...sandbox,
        `ExecStart=${boardServeArgs(settings, { tailnet: true }).join(' ')}`,
        'Restart=always',
        'RestartSec=2',
        // The owner token lasts 30 days; a restart mints a new one (Phase 0).
        'RuntimeMaxSec=14d',
      ],
      Install: ['WantedBy=multi-user.target'],
    }),
    [unitNames.app]: unit({
      Unit: [
        'Description=devchat app (loopback only)',
        `Requires=${unitNames.board}`,
        `After=${unitNames.board}`,
        `PartOf=${unitNames.board}`,
      ],
      Service: [
        ...sandbox,
        `Environment=DEVCHAT_CONFIG=${hostPaths.configFile}`,
        `ExecStart=${hostPaths.node} ${appMain}`,
        'Restart=always',
        'RestartSec=2',
      ],
      Install: ['WantedBy=multi-user.target'],
    }),
    [unitNames.exportService]: unit({
      Unit: ['Description=devchat daily export', `Requires=${unitNames.board}`, `After=${unitNames.board}`],
      Service: [
        'Type=oneshot',
        ...sandbox,
        `ExecStart=${hostPaths.node} ${hostCli} export --config ${hostPaths.configFile} --dir ${hostPaths.exportDir}`,
      ],
    }),
    [unitNames.exportTimer]: unit({
      Unit: ['Description=devchat daily export'],
      Timer: ['OnCalendar=daily', 'Persistent=true', 'RandomizedDelaySec=15m'],
      Install: ['WantedBy=timers.target'],
    }),
  }
}
