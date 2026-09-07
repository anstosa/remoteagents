#!/usr/bin/env bash
# PROBE — naming a live Codex thread the way the console would (OMX shares this TUI).
# Launches a REAL interactive Codex (0.150) in ~/scratch with `-s read-only -a never`,
# using the real ~/.codex (the thread appears in `codex resume`; three tiny turns, two
# of them a 30 s `sleep`). Then:
#   1. first prompt → provisional + generated names in session_index.jsonl
#   2. IDLE : paste "/rename <n1> " + Enter → latency to session_index.jsonl; sqlite immutable vs ro
#   3. BUSY : 30 s turn, paste "/rename <n2> " + Tab   (the console's working-state key)
#   4. BUSY : 30 s turn, paste "/rename <n3> " + Enter (the alternative)
#   5. /quit → exit hint; final state of every store
source "$(dirname "$0")/lib.sh"
OUT=${1:-"$ROOT/out-codex-$(date +%Y%m%d-%H%M%S)"}; mkdir -p "$OUT"
CODEX=${RAC_CODEX_BIN:-/home/linuxbrew/.linuxbrew/bin/codex}
CH=${CODEX_HOME:-$HOME/.codex}; INDEX="$CH/session_index.jsonl"; DB="$CH/state_5.sqlite"
N1="rac-probe-idle-$STAMP"; N2="rac-probe-busy-tab-$STAMP"; N3="rac-probe-busy-enter-$STAMP"
{ "$CODEX" --version; "$TMUX" -V; sqlite3 --version | cut -d' ' -f1; } 2>&1 | tr '\n' ' '; echo

N0=$(wc -l < "$INDEX"); log "session_index.jsonl has $N0 lines before"
START=$(date +%s)
working() { title | grep -qP '^\xe2[\xa0-\xa3]'; }        # Braille spinner = working (codexInferState)
composer() { screen | grep -qE '^›'; }
idx_new() { tail -n +"$((N0 + 1))" "$INDEX"; }
idx_has() { idx_new | grep -qF "\"thread_name\":\"$1\""; }
sql_imm() { sqlite3 -readonly "file:$DB?immutable=1" "select name from threads where id='$SID'" 2>&1; }
sql_ro()  { sqlite3 "file:$DB?mode=ro" "select name, datetime(updated_at_ms/1000,'unixepoch','localtime') from threads where id='$SID'" 2>&1; }
ROLL=""; SID=""
find_thread() { ROLL=$(find "$CH/sessions" -name 'rollout-*.jsonl' -newermt "@$START" 2>/dev/null | sort | tail -1); SID=$(printf '%s' "$ROLL" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -1); }
roll_rename_msgs() { [ -n "$ROLL" ] && grep -c '/rename' "$ROLL"; }
stores() { log "index new lines:"; idx_new | sed 's/^/    /'; log "sqlite immutable=1 name: $(sql_imm)"; log "sqlite mode=ro   name|updated: $(sql_ro)"; log "rollout lines containing '/rename': $(roll_rename_msgs)"; }

start_server
watch title "$TMUX -S $SOCK display-message -p -t $PANE '#{pane_title}'"

hr "launch (into the shell, like the console)"
type_text "$CODEX -s read-only -a never"; key Enter
for _ in $(seq 1 30); do
  screen | grep -qiE 'trust|Yes, continue' && { log "trust/continue prompt — Enter"; snap trust; key Enter; }
  composer && break; sleep 1
done
composer || { log "no composer after 30 s"; snap launch-stuck; finish; exit 1; }
sleep 2; snap 0-ready; log "title='$(title)'"

hr "1. first prompt"
paste "Reply with only the word ok. "; key Enter
log "working after: $(wait_until working 15) ms"
log "finished after: $(wait_until '! working' 90) ms"
find_thread; log "thread $SID  rollout $ROLL"
log "provisional name in index after: $(wait_until '[ "$(idx_new | wc -l)" -ge 1 ]' 10) ms"
log "generated title (2nd index line) after: $(wait_until '[ "$(idx_new | wc -l)" -ge 2 ]' 25) ms"
stores

hr "2. IDLE rename: paste '/rename $N1 ' + Enter"
paste "/rename $N1 "; sleep 0.4; snap 2a-pasted-before-enter; key Enter
log "'$N1' in session_index.jsonl after: $(wait_until "idx_has $N1" 10) ms"
log "sqlite mode=ro sees it after: $(wait_until "sql_ro | grep -qF $N1" 10) ms; immutable=1 sees it after: $(wait_until "sql_imm | grep -qF $N1" 3) ms"
sleep 1.5; snap 2b-after-idle-rename; log "title='$(title)'"
stores

hr "3. BUSY rename via Tab (console's working-state key): paste '/rename $N2 ' + Tab"
paste "Run the shell command sleep 30 and then reply with only the word done. "; key Enter
log "working after: $(wait_until working 15) ms"; sleep 4
log "still working: $(working && echo yes || echo NO) → sending"
paste "/rename $N2 "; sleep 0.4; snap 3a-busy-pasted; key Tab; sleep 0.8; snap 3b-busy-after-tab
log "'$N2' in index while working: $(wait_until "idx_has $N2" 12) ms (TIMEOUT = not applied mid-turn)  working=$(working && echo yes || echo no)"
log "turn finished after: $(wait_until '! working' 90) ms"
log "'$N2' in index after the turn: $(wait_until "idx_has $N2" 10) ms"
sleep 2; snap 3c-busy-settled
stores

hr "4. BUSY rename via Enter: paste '/rename $N3 ' + Enter"
paste "Run the shell command sleep 30 and then reply with only the word done. "; key Enter
log "working after: $(wait_until working 15) ms"; sleep 4
log "still working: $(working && echo yes || echo NO) → sending"
paste "/rename $N3 "; sleep 0.4; snap 4a-busy-pasted; key Enter; sleep 0.8; snap 4b-busy-after-enter
log "'$N3' in index while working: $(wait_until "idx_has $N3" 12) ms (TIMEOUT = not applied mid-turn)  working=$(working && echo yes || echo no)"
log "turn finished after: $(wait_until '! working' 90) ms"
log "'$N3' in index after the turn: $(wait_until "idx_has $N3" 10) ms"
sleep 2; snap 4c-busy-settled
stores

hr "5. /quit"
paste "/quit "; key Enter
log "shell back after: $(wait_until '[ "$(cur_cmd)" = bash ]' 20) ms"; sleep 1; snap 5-exited

hr "SUMMARY (codex $("$CODEX" --version 2>/dev/null))"
echo "thread: $SID"; echo "rollout: $ROLL"
stores
echo "user-role records in the rollout mentioning rename:"; grep -n '"role":"user"' "$ROLL" 2>/dev/null | grep -i rename | cut -c1-240 | sed 's/^/    /'
echo "title transitions:"; sed 's/^/    /' "$OUT/title.log"
finish
