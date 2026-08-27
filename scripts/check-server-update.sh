#!/usr/bin/env bash
set -Eeuo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
status_directory="$repository/.data"
status_file="$status_directory/server-update-availability.json"
temporary_file="$status_file.tmp"
commits_file="$status_directory/server-update-commits.bin"
commits_temporary_file="$commits_file.tmp"
files_file="$status_directory/server-update-files.bin"
files_temporary_file="$files_file.tmp"
files_source_file="$status_directory/server-update-files-source.bin.tmp"
max_commits=50
max_files=200

# publish one atomic availability state
write_status() {
  local state="$1"
  local base_sha="${2:-}"
  local target_sha="${3:-}"
  local fast_forwardable="${4:-false}"
  local commit_count="${5:-0}"
  local commits_truncated="${6:-false}"
  local files_truncated="${7:-false}"
  mkdir -p "$status_directory"
  printf '{"kind":"update-availability","state":"%s","baseSha":"%s","targetSha":"%s","fastForwardable":%s,"commitCount":%s,"commitsTruncated":%s,"filesTruncated":%s}\n' "$state" "$base_sha" "$target_sha" "$fast_forwardable" "$commit_count" "$commits_truncated" "$files_truncated" > "$temporary_file"
  chmod 600 "$temporary_file"
  mv -f "$temporary_file" "$status_file"
}

# preserve a readable failure state
fail_check() {
  trap - ERR
  rm -f "$temporary_file" "$commits_temporary_file" "$files_temporary_file" "$files_source_file"
  write_status failed
  exit 1
}

trap fail_check ERR
cd "$repository"
git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main'
base_sha="$(git rev-parse refs/heads/main)"
target_sha="$(git rev-parse refs/remotes/origin/main)"
commit_count="$(git rev-list --count refs/heads/main..refs/remotes/origin/main)"
fast_forwardable=false
commits_truncated=false
files_truncated=false

# classify the exact fetched range
if git merge-base --is-ancestor refs/heads/main refs/remotes/origin/main; then
  fast_forwardable=true
fi
if [[ "$commit_count" -gt "$max_commits" ]]; then
  commits_truncated=true
fi

# publish bounded nul-delimited commit metadata
: > "$commits_temporary_file"
git log -z --max-count="$max_commits" --format='%H%x00%an%x00%aI%x00%s' refs/heads/main..refs/remotes/origin/main >> "$commits_temporary_file"
chmod 600 "$commits_temporary_file"
mv -f "$commits_temporary_file" "$commits_file"

# publish bounded nul-delimited changed paths
: > "$files_temporary_file"
git diff --name-only -z refs/heads/main..refs/remotes/origin/main > "$files_source_file"
file_count=0
while IFS= read -r -d '' path; do
  file_count=$((file_count + 1))
  if [[ "$file_count" -le "$max_files" ]]; then
    printf '%s\0' "$path" >> "$files_temporary_file"
  else
    files_truncated=true
  fi
done < "$files_source_file"
rm -f "$files_source_file"
chmod 600 "$files_temporary_file"
mv -f "$files_temporary_file" "$files_file"

# report remote commits missing from local main
if [[ "$commit_count" -gt 0 ]]; then
  write_status available "$base_sha" "$target_sha" "$fast_forwardable" "$commit_count" "$commits_truncated" "$files_truncated"
else
  write_status current "$base_sha" "$target_sha" "$fast_forwardable" "$commit_count" "$commits_truncated" "$files_truncated"
fi
