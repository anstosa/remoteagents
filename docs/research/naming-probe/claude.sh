#!/usr/bin/env bash
# PROBE — naming a live Claude Code Conversation the way the console would.
# Launches a REAL interactive Claude in ~/scratch (it appears in /resume; two tiny
# API turns plus one 30 s `sleep` tool call), with the console's own hooks file so
# @rac_attention / @rac_session behave exactly as under the console. Then:
#   1. first prompt → wait for the automatic ai-title
#   2. IDLE  : paste "/rename <n1>" + Enter  → time until custom-title lands; sidecar; pane
#   3. BUSY  : start a 30 s turn, paste "/rename <n2>" + Enter while working → queued? applied mid-turn?
#   4. re-open with --resume → is ai-title re-emitted after custom-title? does the name show?
# Output: $OUT/*.txt captures, attention.log, and the SUMMARY at the end of the log.
source "$(dirname "$0")/lib.sh"
OUT=${1:-"$ROOT/out-claude-$(date +%Y%m%d-%H%M%S)"}; mkdir -p "$OUT"
CLAUDE=${RAC_CLAUDE_BIN:-$HOME/.local/bin/claude}
N1="rac-probe-idle-$STAMP"; N2="rac-probe-busy-$STAMP"
PROJ="$HOME/.claude/projects/$(printf '%s' "$CWD" | sed 's/[^A-Za-z0-9]/-/g')"
{ "$CLAUDE" --version; "$TMUX" -V; } 2>&1 | tr '\n' ' '; echo

# the console's own hooks file (same rac-attention script, same tmux binary); the hook
# reaches THIS tmux server through the $TMUX env var the pane inherits
HOOKS="$OUT/hooks.json"
cp /tachi/code/remoteagents/.data/adapters/claude/hooks.json "$HOOKS" || { echo "hooks source missing"; exit 1; }
grep -q 'rac-attention finished' "$HOOKS" || { echo "hooks file looks wrong"; exit 1; }

start_server
watch attention "$TMUX -S $SOCK show-options -p -q -v -t $PANE @rac_attention"
T=""
titles() { [ -n "$T" ] && grep -n -E '"type":"(custom-title|ai-title|agent-name|queue-operation)"' "$T" | cut -c1-200 | sed 's/^/    /'; }
has_custom() { [ -n "$T" ] && grep -qF "\"customTitle\":\"$1\"" "$T"; }
attn() { opt @rac_attention; }

hr "launch"
type_text "$CLAUDE --settings '$HOOKS' --allowedTools 'Bash(sleep:*)'"; key Enter
for _ in $(seq 1 30); do
  screen | grep -qiF 'trust the files' && { log "accepting the trust dialog"; key Enter; }
  [ -n "$(opt @rac_session)" ] && break; sleep 1
done
SID=$(opt @rac_session); T="$PROJ/$SID.jsonl"
if [ -z "$SID" ]; then log "no @rac_session after 30 s"; snap launch-stuck; finish; exit 1; fi
log "session $SID  attention=$(attn)  transcript=$T"
sleep 2; snap 0-ready

hr "1. first prompt (to get an automatic ai-title)"
paste "Reply with only the word ok."; key Enter
log "working after: $(wait_until '[ "$(attn)" = working ]' 15) ms"
log "finished after: $(wait_until '[ "$(attn)" = finished ]' 90) ms"
log "ai-title appeared after: $(wait_until 'grep -qF "\"type\":\"ai-title\"" "$T"' 25) ms (TIMEOUT = never generated)"
titles

hr "2. IDLE rename: paste '/rename $N1' + Enter  (attention=$(attn))"
snap 1-before-idle-rename
t0=$(now_ms); paste "/rename $N1"; sleep 0.3; snap 2a-pasted-before-enter; key Enter
log "custom-title '$N1' in transcript after: $(wait_until "has_custom $N1" 10) ms"
sleep 1.5; snap 2b-after-idle-rename
log "attention now: $(attn)"
log "sidecar: $(ls -la "$PROJ/$SID/custom-title.json" 2>&1) :: $(cat "$PROJ/$SID/custom-title.json" 2>/dev/null)"
log "meta user record for the rename: $(grep -c 'named this session' "$T") line(s); text: $(grep -o 'The user named this session[^"]*' "$T" | tail -1)"
log "records mentioning '/rename' verbatim: $(grep -cF '/rename' "$T")"
titles

hr "3. BUSY rename: 30 s tool turn, then paste '/rename $N2' + Enter while working"
paste "Run the bash command \`sleep 30\` and then reply with only the word done."; key Enter
log "working after: $(wait_until '[ "$(attn)" = working ]' 15) ms"
sleep 4
if [ "$(attn)" = question ]; then log "permission prompt appeared — approving"; snap 3x-permission; key Enter; sleep 2; fi
log "attention=$(attn) → sending the rename"
paste "/rename $N2"; sleep 0.4; snap 3a-busy-pasted; key Enter; sleep 0.8; snap 3b-busy-after-enter
r=$(wait_until "has_custom $N2" 12); log "custom-title '$N2' while still working: $r ms (TIMEOUT = not applied mid-turn)  attention=$(attn)"
log "turn finished after: $(wait_until '[ "$(attn)" = finished ]' 90) ms"
log "custom-title '$N2' after the turn: $(wait_until "has_custom $N2" 10) ms"
sleep 1.5; snap 3c-busy-settled
log "queue-operation records: $(grep -c '"type":"queue-operation"' "$T")"
grep -o '"type":"queue-operation","operation":"[a-z]*"[^}]*' "$T" | cut -c1-160 | sed 's/^/    /'
titles

hr "4. exit, then --resume $SID: re-emission order and prompt bar"
paste "/exit"; key Enter
log "shell back after: $(wait_until '[ "$(cur_cmd)" = bash ]' 20) ms"
LINES_BEFORE=$(wc -l < "$T")
t set-option -p -t "$PANE" @rac_session ""
type_text "$CLAUDE --resume $SID --settings '$HOOKS'"; key Enter
log "resumed (session reported) after: $(wait_until '[ "$(opt @rac_session)" = "$SID" ]' 30) ms"
sleep 4; snap 4-resumed
log "records appended by the resume (after line $LINES_BEFORE):"
tail -n +"$((LINES_BEFORE + 1))" "$T" | grep -o '^{"type":"[a-zA-Z_-]*"[^}]\{0,120\}' | sed 's/^/    /'
paste "/exit"; key Enter; sleep 2

hr "SUMMARY (claude $("$CLAUDE" --version 2>/dev/null | cut -d' ' -f1))"
echo "session: $SID"; echo "transcript: $T"
echo "title records in order:"; titles
echo "sidecar: $(cat "$PROJ/$SID/custom-title.json" 2>/dev/null || echo none)"
echo "attention transitions:"; sed 's/^/    /' "$OUT/attention.log"
finish
