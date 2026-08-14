#!/usr/bin/env bash
set -uo pipefail

operation_id="${1:-}"

# accept only server-generated identifiers
if [[ ! "$operation_id" =~ ^[A-Za-z0-9_-]{20,64}$ ]]; then
  exit 2
fi

repository="$(pwd -P)"
status_directory="$repository/.data"
status_file="$status_directory/server-update-$operation_id.json"
temporary_file="$status_file.tmp"

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
  write_status failed
  exit 1
}

trap fail_update ERR
write_status running
git pull --ff-only
docker compose up -d --build --wait
docker compose ps
write_status complete
