import { boardServeArgs, renderUnits } from './units.ts'
import { boardUrl, hostCli, hostPaths, unitNames, type Settings } from './settings.ts'

/** One step of a root script: what it prints before it runs, and the Bash that runs it. */
export type Step = { title: string; bash: string }

/** Quotes a value for Bash. */
export const shq = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

const { account, stateDir, configHome, node, optDir, appDir, configDir, configFile, unitDir } = hostPaths

/**
 * Helpers every root script starts with. Each change prints `applied:` and each check that finds
 * the host as wanted prints `unchanged:`, so a rerun that changes nothing prints no `applied:`.
 */
const prelude = String.raw`set -euo pipefail
umask 022
# The service account cannot enter the caller's working directory.
cd /
APPLIED=0
RESTART=0
fail() { printf 'error: %b\n' "$1" >&2; exit 1; }
step() { printf '\n==> [%s] %s\n' "$1" "$2"; }
applied() { printf '  applied: %s\n' "$1"; APPLIED=$((APPLIED + 1)); }
unchanged() { printf '  unchanged: %s\n' "$1"; }
run() { printf '  $ %s\n' "$*"; "$@"; }
AS_DEVCHAT=(setpriv --reuid=${account} --regid=${account} --init-groups env -i HOME=${stateDir} XDG_CONFIG_HOME=${configHome} PATH=/usr/bin:/bin)
owner_mode() { stat -c '%U:%G:%a' "$1"; }
ensure_dir() {
  if [ -d "$1" ] && [ "$(owner_mode "$1")" = "$2:$3:$4" ]; then unchanged "$1"
  else run install -d -o "$2" -g "$3" -m "$4" "$1"; applied "$1"; fi
}
# ensure_file <path> <owner> <group> <mode>, with the content on stdin. Sets FILE_CHANGED.
ensure_file() {
  local tmp
  tmp=$(mktemp)
  cat > "$tmp"
  FILE_CHANGED=0
  if [ -f "$1" ] && cmp -s "$tmp" "$1" && [ "$(owner_mode "$1")" = "$2:$3:$4" ]; then unchanged "$1"
  else run install -o "$2" -g "$3" -m "$4" "$tmp" "$1"; applied "$1"; FILE_CHANGED=1; fi
  rm -f "$tmp"
}
# Prints each library in ldd output on stdin that is missing or outside the system library directories.
foreign_libs() {
  awk '{ path = ($2 == "=>") ? $3 : $1 }
    /not found/ { print; next }
    path ~ /^linux-(vdso|gate)/ { next }
    path ~ /^\/(usr\/)?lib(32|64|x32)?\// { next }
    NF > 0 { print }'
}
version_at_least() { printf '%s\n%s\n' "$2" "$1" | sort -V -C; }
`

const ensureUnitActive = (unit: string) => `if systemctl is-enabled --quiet ${unit}; then unchanged "${unit} enabled"; else run systemctl enable ${unit}; applied "${unit} enabled"; fi
if systemctl is-active --quiet ${unit}; then unchanged "${unit} running"; else run systemctl start ${unit}; applied "${unit} started"; fi`

export type InstallOptions = {
  settings: Settings
  /** The Node binary to copy. It must link only system libraries. */
  nodeSource: string
  /** An npm `node_modules` holding `@filipgutica/devchat` and its dependencies. */
  modulesSource: string
  expose: boolean
}

/** The root script `devchat-host install` runs with one `sudo` (runbook step 3). */
export function installSteps({ settings, nodeSource, modulesSource, expose }: InstallOptions): Step[] {
  const units = renderUnits(settings)
  const url = boardUrl(settings)
  const setup = `"\${AS_DEVCHAT[@]}" BOARD_URL=${url} ${node} ${hostCli} board-setup --config ${configFile}`
  const steps: Step[] = [
    {
      title: 'Check the prerequisites',
      bash: `NODE_SRC=${shq(nodeSource)}
MODULES_SRC=${shq(modulesSource)}
[ "$(id -u)" = 0 ] || fail 'run as root'
for tool in systemctl setpriv ldd install cmp diff; do command -v "$tool" >/dev/null || fail "missing $tool"; done
${expose ? `command -v tailscale >/dev/null || fail 'missing tailscale'\n` : ''}[ -x "$NODE_SRC" ] || fail "no Node at $NODE_SRC"
[ -d "$MODULES_SRC/@filipgutica/devchat" ] && [ -d "$MODULES_SRC/@vercel/board" ] || fail "no installed package in $MODULES_SRC"
# Install never changes /opt itself; the services must not run from a tree another account can swap.
[ "$(stat -c %U /opt)" = root ] && [ -z "$(find /opt -maxdepth 0 -perm /022)" ] || fail '/opt must be root-owned and not group- or world-writable'
unchanged 'prerequisites'
# Runs board setup as ${account} through loopback, and counts its changes.
board_setup() {
  local out
  out=$(${setup} "$@") || { printf '%s\\n' "$out"; return 1; }
  printf '%s\\n' "$out" | sed 's/^/  /'
  APPLIED=$((APPLIED + $(printf '%s\\n' "$out" | grep -c '^applied:' || true)))
}`,
    },
    {
      title: `Create the system account ${account} and its state directory ${stateDir} (700)`,
      bash: `if getent passwd ${account} >/dev/null; then unchanged 'account ${account}'
else run useradd --system --user-group --home-dir ${stateDir} --no-create-home --shell /usr/sbin/nologin ${account}; applied 'account ${account}'; fi
ensure_dir ${stateDir} ${account} ${account} 700
ensure_dir ${configHome} ${account} ${account} 700
ensure_dir ${hostPaths.exportDir} ${account} ${account} 700`,
    },
    {
      title: `Copy Node to ${node}, root-owned, after checking it links only system libraries`,
      bash: `ensure_dir ${optDir} root root 755
ensure_dir ${optDir}/bin root root 755
staged=${node}.new
install -o root -g root -m 755 "$NODE_SRC" "$staged"
# ldd and the version check run as ${account}: root never executes the copied binary.
libs=$("\${AS_DEVCHAT[@]}" ldd "$staged") || { rm -f "$staged"; fail 'ldd failed on the Node binary'; }
foreign=$(printf '%s\\n' "$libs" | foreign_libs)
[ -z "$foreign" ] || { rm -f "$staged"; fail "refusing $NODE_SRC: it links libraries outside the system library directories (a Linuxbrew build does):\\n$foreign"; }
version=$("\${AS_DEVCHAT[@]}" "$staged" -p process.versions.node)
version_at_least "$version" 22.20.0 || { rm -f "$staged"; fail "Node $version is too old: Board 0.56.1 writes need 22.20 or later"; }
if [ -f ${node} ] && cmp -s "$staged" ${node} && [ "$(owner_mode ${node})" = root:root:755 ]; then rm -f "$staged"; unchanged "${node} (Node $version)"
else run mv -f "$staged" ${node}; applied "${node} (Node $version)"; RESTART=1; fi`,
    },
    {
      title: `Copy the server package to ${appDir}, root-owned and not group- or world-writable`,
      bash: `rm -rf ${appDir}.new
install -d -o root -g root -m 755 ${appDir}.new
# -L copies files, never links back into the source tree.
cp -RL "$MODULES_SRC" ${appDir}.new/node_modules
chown -R root:root ${appDir}.new
chmod -R u+rwX,go+rX,go-w ${appDir}.new
if [ -d ${appDir} ] && diff -rq ${appDir}.new ${appDir} >/dev/null \\
  && [ -z "$(find ${appDir} \\( ! -user root -o ! -group root -o -perm /022 \\) -print -quit)" ]; then
  rm -rf ${appDir}.new; unchanged '${appDir}'
else
  rm -rf ${appDir}.old
  if [ -d ${appDir} ]; then mv ${appDir} ${appDir}.old; fi
  run mv ${appDir}.new ${appDir}; rm -rf ${appDir}.old; applied '${appDir}'; RESTART=1
fi`,
    },
    {
      title: `Write the app's settings to ${configFile} (root:${account} 640)`,
      bash: `ensure_dir ${configDir} root ${account} 750
ensure_file ${configFile} root ${account} 640 <<'DEVCHAT_EOF'
${JSON.stringify(settings, null, 2)}
DEVCHAT_EOF
if [ "$FILE_CHANGED" = 1 ]; then RESTART=1; fi`,
    },
    {
      title: `Write the systemd units: ${Object.keys(units).join(', ')}`,
      bash: `UNITS_CHANGED=0
${Object.entries(units).map(([name, text]) => `ensure_file ${unitDir}/${name} root root 644 <<'DEVCHAT_EOF'
${text}DEVCHAT_EOF
if [ "$FILE_CHANGED" = 1 ]; then UNITS_CHANGED=1; fi`).join('\n')}
if [ "$UNITS_CHANGED" = 1 ]; then run systemctl daemon-reload; RESTART=1; fi`,
    },
    {
      title: `Before the board serves the tailnet: start it on loopback only and, as ${account}, revoke Board's default grants`,
      bash: `if systemctl is-active --quiet ${unitNames.board}; then
  unchanged '${unitNames.board} already runs; the next grant step checks every grant'
else
  # Board's default grant g1 lets a forged loopback tailnet header manage a board served with
  # --tailscale, so the first start leaves it out until g1 is gone.
  printf '  $ %s &\\n' ${shq(boardServeArgs(settings, { tailnet: false }).join(' '))}
  "\${AS_DEVCHAT[@]}" ${boardServeArgs(settings, { tailnet: false }).join(' ')} >/dev/null 2>&1 &
  BOOT_PID=$!
  trap 'kill "$BOOT_PID" 2>/dev/null || true' EXIT
  board_setup --lock || fail 'locking the board failed'
  kill "$BOOT_PID"; wait "$BOOT_PID" 2>/dev/null || true
  trap - EXIT
fi`,
    },
    {
      title: `Start ${unitNames.board}`,
      bash: `if [ "$RESTART" = 1 ] && systemctl is-active --quiet ${unitNames.board}; then
  run systemctl restart ${unitNames.board}; applied 'restarted ${unitNames.board} and, through PartOf, ${unitNames.app}'
fi
${ensureUnitActive(unitNames.board)}`,
    },
    {
      title: `As ${account} through loopback: the tailnet login's grant, no other grant, grants explain, board marker epoch=1`,
      bash: `board_setup || fail 'board setup failed'`,
    },
    {
      title: `Start ${unitNames.app}`,
      bash: `${ensureUnitActive(unitNames.app)}
"\${AS_DEVCHAT[@]}" ${node} ${hostCli} status --app-port ${settings.appPort} --wait 30 | sed 's/^/  /'`,
    },
    {
      title: `Install the daily export timer (${unitNames.exportTimer}, 14 files kept)`,
      bash: ensureUnitActive(unitNames.exportTimer),
    },
  ]
  if (expose) {
    steps.push({
      title: `Only now, expose both on the tailnet at https://${settings.host}:${settings.httpsPort}/`,
      bash: `# tailscale serve replaces a route with the same one, so a rerun leaves it as it was.
run tailscale serve --bg --https=${settings.httpsPort} --set-path=/api/board ${url}
run tailscale serve --bg --https=${settings.httpsPort} --set-path=/ http://127.0.0.1:${settings.appPort}`,
    })
  }
  return steps
}

export type UninstallOptions = { httpsPort: number; expose: boolean; purge: boolean }

/** The root script `devchat-host uninstall` runs: install in reverse. */
export function uninstallSteps({ httpsPort, expose, purge }: UninstallOptions): Step[] {
  const unitFiles = Object.values(unitNames).map((name) => `${unitDir}/${name}`)
  const steps: Step[] = []
  if (expose) {
    steps.push({
      title: `Stop exposure: tailscale serve --https=${httpsPort} off`,
      bash: `run tailscale serve --https=${httpsPort} off; applied 'tailnet routes on :${httpsPort} removed'`,
    })
  }
  steps.push(
    {
      title: 'Stop and remove the devchat units',
      bash: `for unit in ${unitNames.exportTimer} ${unitNames.app} ${unitNames.board}; do
  if [ -f ${unitDir}/$unit ]; then run systemctl disable --now "$unit"; applied "$unit stopped"; else unchanged "$unit absent"; fi
done
for file in ${unitFiles.join(' ')}; do
  if [ -f "$file" ]; then run rm -f "$file"; applied "$file removed"; fi
done
run systemctl daemon-reload`,
    },
    {
      title: `Remove ${optDir} and ${configDir}`,
      bash: `for dir in ${optDir} ${configDir}; do
  if [ -e "$dir" ]; then run rm -rf "$dir"; applied "$dir removed"; else unchanged "$dir absent"; fi
done`,
    },
    purge
      ? {
          title: `Delete the board's data in ${stateDir} and the account ${account}`,
          bash: `if getent passwd ${account} >/dev/null; then run userdel ${account}; applied 'account ${account} removed'; fi
if [ -e ${stateDir} ]; then run rm -rf ${stateDir}; applied '${stateDir} removed'; fi`,
        }
      : {
          title: `Keep the board's data in ${stateDir} and the account ${account}`,
          bash: `unchanged '${stateDir} kept: rerun with --purge to delete the board and its data'`,
        },
  )
  return steps
}

/** The numbered plan printed before the script runs. */
export const renderPlan = (steps: readonly Step[]) =>
  steps.map(({ title }, index) => `${index + 1}. ${title}`).join('\n')

export function renderScript(steps: readonly Step[]) {
  const body = steps.map(({ title, bash }, index) => `step ${index + 1} ${shq(title)}\n${bash}`).join('\n\n')
  return `${prelude}\n${body}\n\nprintf '\\nDone: %d change(s).\\n' "$APPLIED"\n`
}
