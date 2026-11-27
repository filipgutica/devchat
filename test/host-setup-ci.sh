#!/usr/bin/env bash
# The host-setup CI job: install --no-expose, verify from the runner's own account, then a rerun,
# a board restart, an export, and uninstall. It changes system services: CI runners only.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo 'host-setup-ci.sh installs system services: run it only in GitHub Actions' >&2; exit 1; }

bin=$1
modules=$(cd "$(dirname "$(readlink -f "$bin")")/../../../.." && pwd)
settings=(--login User@Example.com --host board.example.test)
host_cli=/opt/devchat/app/node_modules/@filipgutica/devchat/dist/host/cli.js
# From /: the service account cannot enter the runner's working directory.
as_devchat() { (cd / && sudo -u devchat env -i HOME=/var/lib/devchat XDG_CONFIG_HOME=/var/lib/devchat/config PATH=/usr/bin:/bin BOARD_URL=http://127.0.0.1:4100/api/board "$@"); }
vb() { as_devchat /opt/devchat/bin/node /opt/devchat/app/node_modules/@vercel/board/dist/cli.mjs "$@"; }
main_pid() { systemctl show -p MainPID --value "$1"; }
token_hash() { sudo sh -c 'cat /var/lib/devchat/config/board/local/*.json' | sha256sum | cut -d' ' -f1; }
# Everything a rerun must leave as it was: processes, credential, grants, units, settings, and files.
snapshot() {
  main_pid devchat-board.service; main_pid devchat-app.service
  token_hash
  vb --json grants list
  sudo sha256sum /etc/systemd/system/devchat-* /etc/devchat/app.json
  sudo find /opt/devchat -path /opt/devchat/.staging -prune -o -exec stat -c '%n %U:%G %a' {} + | sort | sha256sum
  sudo find /opt/devchat -path /opt/devchat/.staging -prune -o -type f -exec sha256sum {} + | sort | sha256sum
}
die() { echo "$1" >&2; exit 1; }
section() { echo "::endgroup::"; echo "::group::$1"; }

echo '::group::install refuses a symlinked destination before it writes anything'
sudo ln -s "$RUNNER_TEMP" /etc/devchat
if out=$("$bin" install --no-expose "${settings[@]}" 2>&1); then die 'install accepted a symlinked /etc/devchat'; fi
printf '%s\n' "$out" | tail -3
grep -q '/etc/devchat is a symlink' <<<"$out"
[ ! -e /opt/devchat ] || die 'install wrote /opt/devchat before refusing'
sudo rm /etc/devchat

section 'install refuses a package that holds a link'
ln -s /etc/hostname "$modules/@filipgutica/devchat/linked"
if out=$("$bin" install --no-expose "${settings[@]}" 2>&1); then die 'install accepted a package with a link'; fi
printf '%s\n' "$out" | tail -3
grep -q 'refusing the package: node_modules/@filipgutica/devchat/linked is not a regular file or directory' <<<"$out"
[ ! -e /opt/devchat/app ] || die 'install published a package with a link'
rm "$modules/@filipgutica/devchat/linked"

section 'install --no-expose'
"$bin" install --no-expose "${settings[@]}"

section 'a running board that is not locked is locked again on loopback before it serves the tailnet'
vb grants create --everyone --can '*=read'
relock=$("$bin" install --no-expose "${settings[@]}")
printf '%s\n' "$relock"
grep -q 'not locked: g[0-9]* gives everyone access' <<<"$relock"
grep -q 'applied: stopped devchat-board.service' <<<"$relock"
as_devchat /opt/devchat/bin/node "$host_cli" board-setup --config /etc/devchat/app.json --lock-check

section 'seed one root in each read-only channel as the service account, so verify can probe reply and label'
for channel in todos work msg sched out; do vb post "$channel" 'ci seed'; done

section 'verify from the runner account, without sudo'
"$bin" verify --no-expose "${settings[@]}"

section 'a second install changes nothing'
before=$(snapshot)
rerun=$("$bin" install --no-expose "${settings[@]}")
printf '%s\n' "$rerun"
if grep -E '^ *applied:' <<<"$rerun"; then die 'the second install changed something'; fi
grep -q 'Done: 0 change(s).' <<<"$rerun"
after=$(snapshot)
diff <(printf '%s\n' "$before") <(printf '%s\n' "$after")

section 'a board restart mints a new owner token, and the app keeps working'
app_pid=$(main_pid devchat-app.service)
board_pid=$(main_pid devchat-board.service)
old_token=$(token_hash)
sudo systemctl kill --kill-whom=main --signal=SIGKILL devchat-board.service
for _ in $(seq 60); do
  pid=$(main_pid devchat-board.service)
  if [ "$pid" != 0 ] && [ "$pid" != "$board_pid" ] && [ "$(token_hash)" != "$old_token" ]; then break; fi
  sleep 0.5
done
[ "$(main_pid devchat-board.service)" != "$board_pid" ] || die 'the board did not restart'
[ "$(token_hash)" != "$old_token" ] || die 'the restart kept the old owner token'
# systemd restarts the app with the board (Requires=, PartOf=), so the app may hold a new PID.
# test/app.test.ts proves the app also survives a new token without a restart.
if [ "$(main_pid devchat-app.service)" = "$app_pid" ]; then echo 'the app kept running'; else echo 'systemd restarted the app with the board'; fi
systemctl is-active devchat-app.service
"$bin" status --wait 30
"$bin" verify --no-expose "${settings[@]}"

section 'the export timer writes a private export that holds the board'
systemctl is-enabled devchat-export.timer
sudo systemctl start devchat-export.service
export_file=$(sudo find /var/lib/devchat/exports -name 'devchat-*.json' | sort | tail -1)
[ -n "$export_file" ] || die 'no export'
[ "$(sudo stat -c '%U:%G %a' "$export_file")" = 'devchat:devchat 600' ] || die "export is $(sudo stat -c '%U:%G %a' "$export_file")"
sudo cat "$export_file" | node --input-type=module -e '
  let text = ""
  for await (const chunk of process.stdin) text += chunk
  const { records, duplicates } = JSON.parse(text)
  const posts = Object.values(records)
  const channels = new Set(posts.map((post) => post.channel))
  for (const channel of ["todos", "work", "msg", "sched", "out", "sys", "inbox"]) if (!channels.has(channel)) throw new Error(`no ${channel} post in the export`)
  if (!posts.some((post) => post.channel === "sys" && post.labels.epoch === "1")) throw new Error("no board marker in the export")
  if (duplicates.length !== 0) throw new Error("unexpected repeated rids")
  console.log(`export holds ${posts.length} posts in ${channels.size} channels`)
'

section 'uninstall --purge removes everything'
"$bin" uninstall --no-expose --purge
for path in /opt/devchat /etc/devchat /var/lib/devchat /etc/systemd/system/devchat-board.service; do
  [ ! -e "$path" ] || die "uninstall left $path"
done
if getent passwd devchat; then die 'uninstall left the devchat account'; fi
echo '::endgroup::'
