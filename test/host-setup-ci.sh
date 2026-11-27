#!/usr/bin/env bash
# The host-setup CI job: install --no-expose, verify from the runner's own account, then a rerun,
# a board restart, an export, and uninstall. It changes system services: CI runners only.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { echo 'host-setup-ci.sh installs system services: run it only in GitHub Actions' >&2; exit 1; }

bin=$1
settings=(--login user@example.com --host board.example.test)
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
  sudo find /opt/devchat -exec stat -c '%n %U:%G %a' {} + | sort | sha256sum
  sudo find /opt/devchat -type f -exec sha256sum {} + | sort | sha256sum
}
section() { echo "::endgroup::"; echo "::group::$1"; }

echo '::group::install --no-expose'
"$bin" install --no-expose "${settings[@]}"

section 'seed one root in todos, work, and msg as the service account, so verify can probe reply and label'
for channel in todos work msg; do vb post "$channel" 'ci seed'; done

section 'verify from the runner account, without sudo'
"$bin" verify --no-expose "${settings[@]}"

section 'a second install changes nothing'
before=$(snapshot)
rerun=$("$bin" install --no-expose "${settings[@]}")
printf '%s\n' "$rerun"
if grep -E '^ *applied:' <<<"$rerun"; then echo 'the second install changed something' >&2; exit 1; fi
grep -q 'Done: 0 change(s).' <<<"$rerun"
after=$(snapshot)
diff <(printf '%s\n' "$before") <(printf '%s\n' "$after")

section 'a board restart mints a new owner token, and the app keeps working without a restart'
app_pid=$(main_pid devchat-app.service)
board_pid=$(main_pid devchat-board.service)
old_token=$(token_hash)
sudo systemctl kill --kill-whom=main --signal=SIGKILL devchat-board.service
for _ in $(seq 60); do
  pid=$(main_pid devchat-board.service)
  if [ "$pid" != 0 ] && [ "$pid" != "$board_pid" ] && [ "$(token_hash)" != "$old_token" ]; then break; fi
  sleep 0.5
done
[ "$(main_pid devchat-board.service)" != "$board_pid" ] || { echo 'the board did not restart' >&2; exit 1; }
[ "$(token_hash)" != "$old_token" ] || { echo 'the restart kept the old owner token' >&2; exit 1; }
[ "$(main_pid devchat-app.service)" = "$app_pid" ] || { echo 'the app restarted with the board, so this proves nothing' >&2; exit 1; }
"$bin" status --wait 30
"$bin" verify --no-expose "${settings[@]}"

section 'the export timer writes an export'
systemctl is-enabled devchat-export.timer
sudo systemctl start devchat-export.service
sudo find /var/lib/devchat/exports -name 'devchat-*.json' | grep -q .

section 'uninstall --purge removes everything'
"$bin" uninstall --no-expose --purge
for path in /opt/devchat /etc/devchat /var/lib/devchat /etc/systemd/system/devchat-board.service; do
  [ ! -e "$path" ] || { echo "uninstall left $path" >&2; exit 1; }
done
if getent passwd devchat; then echo 'uninstall left the devchat account' >&2; exit 1; fi
echo '::endgroup::'
