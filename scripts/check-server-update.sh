#!/usr/bin/env bash
set -Eeuo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
status_directory="$repository/.data"
status_file="$status_directory/server-update-availability.json"
temporary_file="$status_file.tmp"

# publish one atomic availability state
write_status() {
  local state="$1"
  mkdir -p "$status_directory"
  printf '{"kind":"update-availability","state":"%s"}\n' "$state" > "$temporary_file"
  chmod 600 "$temporary_file"
  mv -f "$temporary_file" "$status_file"
}

# preserve a readable failure state
fail_check() {
  write_status failed
  exit 1
}

trap fail_check ERR
cd "$repository"
git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main'

# report remote commits missing from local main
if [[ "$(git rev-list --count refs/heads/main..refs/remotes/origin/main)" -gt 0 ]]; then
  write_status available
else
  write_status current
fi
