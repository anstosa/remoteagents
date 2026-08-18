#!/usr/bin/env bash
set -Eeuo pipefail

operation_id="${1:-}"

# accept only server-generated identifiers
if [[ ! "$operation_id" =~ ^[A-Za-z0-9_-]{20,64}$ ]]; then
  exit 2
fi

repository="$(pwd -P)"
status_directory="$repository/.data"
status_file="$status_directory/server-update-$operation_id.json"
temporary_file="$status_file.tmp"
log_file="$status_directory/server-update-$operation_id.log"
lock_file="$status_directory/server-update.lock"

# capture detached host output
mkdir -p "$status_directory"
touch "$log_file"
chmod 600 "$log_file"
exec >> "$log_file" 2>&1

# publish one atomic lifecycle state
write_status() {
  local state="$1"
  mkdir -p "$status_directory"
  printf '{"id":"%s","kind":"update","state":"%s"}\n' "$operation_id" "$state" > "$temporary_file"
  chmod 600 "$temporary_file"
  mv -f "$temporary_file" "$status_file"
}

# preserve a readable failure state
fail_update() {
  local exit_code="${1:-1}"
  trap - ERR
  write_status failed
  exit "$exit_code"
}

# record one failing command location
on_error() {
  local exit_code="$?"
  printf '[%s] server update failed with exit %s at line %s\n' "$(date -Is)" "$exit_code" "${BASH_LINENO[0]:-unknown}"
  fail_update "$exit_code"
}

trap on_error ERR
write_status running
printf '[%s] server update started\n' "$(date -Is)"

# serialize host repository and Compose mutations
exec 9> "$lock_file"
if ! flock -n 9; then
  printf '[%s] another server update is already running\n' "$(date -Is)"
  fail_update 1
fi

# update only the deployed main branch
if [[ "$(git symbolic-ref --short HEAD)" != "main" ]]; then
  printf '[%s] server update requires the main branch\n' "$(date -Is)"
  fail_update 1
fi
git pull --ff-only origin main
docker compose up -d --build --wait
docker compose ps
write_status complete
printf '[%s] server update completed\n' "$(date -Is)"
