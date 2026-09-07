#!/usr/bin/env bash
# Runs both naming probes detached (Claude first, then Codex; ~4 minutes total) so a
# `!`-prefixed invocation returns at once. Progress: tail -f <dir>/probe.log ; end: <dir>/DONE
# Usage: bash run.sh [claude|codex|both]     (default both)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
WHICH=${1:-both}
OUT="$HERE/out-$WHICH-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$OUT"
{
  case $WHICH in
    claude) echo "bash $HERE/claude.sh $OUT/claude" ;;
    codex)  echo "bash $HERE/codex.sh $OUT/codex" ;;
    *)      echo "bash $HERE/claude.sh $OUT/claude; bash $HERE/codex.sh $OUT/codex" ;;
  esac
} > "$OUT/cmd"
nohup bash -c "$(cat "$OUT/cmd"); touch '$OUT/DONE'" > "$OUT/probe.log" 2>&1 &
echo "started (pid $!) → $OUT"; echo "follow: tail -f $OUT/probe.log"
