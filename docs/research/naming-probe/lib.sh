# Shared helpers for the naming probes. Sourced by claude.sh and codex.sh.
# Everything drives an ISOLATED tmux server (its own socket file), invisible to the
# console's socket-dir discovery, using the console's own primitives:
#   paste  = load-buffer -b rac-… -  ;  paste-buffer -p -d -b rac-… -t PANE   (tmux/adapter.ts pastePrompt)
#   keys   = send-keys -t PANE <one key per call>                            (tmux/adapter.ts sendKeys)
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TMUX=${RAC_TMUX_BIN:-/home/tgrosinger/.local/share/mise/installs/tmux/3.7b/tmux}
[ -x "$TMUX" ] || TMUX=$(command -v tmux)
SOCK="$ROOT/tmux.sock"
COLS=${PROBE_COLS:-140}
ROWS=${PROBE_ROWS:-45}
CWD=${PROBE_CWD:-$HOME/scratch}   # trusted by both Claude and Codex; transcripts land in their scratch project dirs
STAMP=$(date +%H%M%S)

now_ms() { date +%s%3N; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S.%3N)" "$*"; }
hr() { printf '\n──── %s ────\n' "$*"; }

t() { "$TMUX" -S "$SOCK" "$@"; }
screen() { t capture-pane -p -t "$PANE" -S -200; }
snap() { # name — plain + raw captures to $OUT, and echo the last 14 non-empty rows to the log
  screen > "$OUT/$1.txt"; t capture-pane -e -p -t "$PANE" -S -200 > "$OUT/$1.ansi.txt"
  log "capture $1 (tail):"; grep -v '^[[:space:]]*$' "$OUT/$1.txt" | tail -14 | sed 's/^/    │ /'
}
paste() { # text — exactly what the console does (bracketed paste, buffer deleted after)
  printf '%s' "$1" | t load-buffer -b "rac-probe" - && t paste-buffer -p -d -b "rac-probe" -t "$PANE"
}
key() { for k in "$@"; do t send-keys -t "$PANE" "$k"; done; }   # named keys, one call each
type_text() { t send-keys -t "$PANE" -l "$1"; }                    # literal text into the shell (launch only)
opt() { t show-options -p -q -v -t "$PANE" "$1" 2>/dev/null; }
title() { t display-message -p -t "$PANE" '#{pane_title}'; }
cur_cmd() { t display-message -p -t "$PANE" '#{pane_current_command}'; }

# wait_until '<bash test>' [timeout-s] — polls every 200 ms; prints elapsed ms or TIMEOUT
wait_until() {
  local test=$1 limit=$(( ${2:-10} * 1000 )) start elapsed; start=$(now_ms)
  while :; do
    if eval "$test"; then echo $(( $(now_ms) - start )); return 0; fi
    elapsed=$(( $(now_ms) - start )); [ "$elapsed" -ge "$limit" ] && { echo TIMEOUT; return 1; }
    sleep 0.2
  done
}

start_server() { # shell-command — one bare shell pane; the agent is launched INTO it like the console does
  t kill-server 2>/dev/null || true
  t new-session -d -s probe -x "$COLS" -y "$ROWS" -c "$CWD" 'bash --noprofile --norc' || { log "FATAL: tmux new-session failed (socket blocked? run from a plain terminal)"; exit 1; }
  PANE=$(t display-message -p -t probe '#{pane_id}')
  log "isolated tmux server $SOCK, pane $PANE (${COLS}x${ROWS}) cwd $CWD"
}

# a background watcher logging every change of a pane attribute with a timestamp
watch() { # label 'command' -> $OUT/<label>.log
  local label=$1 cmd=$2 last='<init>' v
  ( while :; do v=$(eval "$cmd" 2>/dev/null); if [ "$v" != "$last" ]; then printf '[%s] %s: %q -> %q\n' "$(date +%H:%M:%S.%3N)" "$label" "$last" "$v" >> "$OUT/$label.log"; last=$v; fi; sleep 0.2; done ) &
  WATCHERS="${WATCHERS:-} $!"
}
stop_watchers() { for p in ${WATCHERS:-}; do kill "$p" 2>/dev/null; done; }
finish() { stop_watchers; t kill-server 2>/dev/null || true; touch "$OUT/DONE"; log "DONE → $OUT"; }
