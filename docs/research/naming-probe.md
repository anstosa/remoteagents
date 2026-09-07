# Naming a live Conversation from the console — probe results

Probe run by Tony on 2026-09-06 16:46–16:50 (host `voyager`), Claude Code 2.1.263,
Codex CLI 0.150.0 (OMX shares the Codex TUI, so it was not run separately), tmux 3.7b.
Scripts, the full log and the pane captures are in [`naming-probe/`](./naming-probe/)
(`claude.sh`, `codex.sh`, `lib.sh`, `run.sh`, `probe.log`, `captures/`). Each rename
was sent exactly the way `PromptService.send` sends a prompt: `load-buffer` +
`paste-buffer -p` (bracketed paste) on the pane, then one `send-keys` per key. Both
agents ran in `~/scratch`; Claude with the console's own `hooks.json`, so
`@rac_attention` / `@rac_session` behaved as under the console.

## Short answers

| | Claude Code 2.1.263 | Codex 0.150 / OMX |
|---|---|---|
| Command text | `/rename <name>` | `/rename <name> ` (trailing space, as `queueReadyPrompt` adds) |
| Key | `Enter` | `Enter` — in **every** state (not the Adapter's `Tab` when working) |
| Idle (`finished`) | applied in ≈200 ms | applied at once (first 200 ms poll) |
| Working | applied at once, mid-turn, **not queued**; the turn is untouched | `Enter`: applied at once, mid-turn, turn untouched. `Tab`: shown under "Queued follow-up inputs" and applied only when the turn ends |
| Question / dialog open | not probed; two dialogs seen in this run swallowed pasted text, so do not send | not probed; treat the same |
| Echo on the pane | `❯ /rename <name>` then `⎿ Session renamed to: <name>`; the name appears right-aligned on the composer's rule | the `› /rename …` line is not kept; a `• Session renamed to <name>. To resume this session run codex resume, then select <name> (<id>)` line appears |
| Sent to the model? | no (`system` / `local_command` record) | no (rollout never mentions the name or the command) |
| Where the name lands | `custom-title` + `agent-name` records appended to `projects/<enc>/<id>.jsonl` **and** `projects/<enc>/<id>/custom-title.json`, both within ≈200 ms | `session_index.jsonl` gets one appended line at once; `state_5.sqlite` `threads.name` at once (see WAL note) |
| Read-back signal | newest `custom-title` record equals the typed name | newest `session_index.jsonl` line for the id has `thread_name` = typed name |
| Attention side effects | none: no hook fired, `@rac_attention` stayed `finished` / `working` | none: pane title stayed the cwd basename, spinner unaffected |
| Last-active bumped? | new records appended (so a "last timestamped record" rule would move) | **no**: `threads.updated_at_ms` unchanged by the rename; only turns and exit bump it |

## Claude details

- **Fresh session, no prompt yet**: the transcript file did not exist until the
  rename created it — `custom-title` and `agent-name` are lines 1–2. Naming an
  unused Conversation works and produces the read-back record immediately.
- **Records written per rename** (probe transcript
  `~/.claude/projects/-home-tgrosinger-scratch/3e9e95f3-ac34-484c-951d-967f40034173.jsonl`):
  - `{"type":"custom-title","customTitle":"<name>","sessionId":…}` and
    `{"type":"agent-name","agentName":"<name>",…}` (a pair);
  - `{"type":"system","subtype":"local_command","content":"<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args><name></command-args>",…,"isMeta":false}`;
  - a **user-role record with `isMeta: true`** whose content is
    `<system-reminder>\nThe user named this session "<name>". This may indicate the session's focus or intent.\n</system-reminder>`.
    A console reader that treats user records as typed prompts must skip `isMeta`.
  - The `custom-title`/`agent-name` pair is **re-emitted after every later prompt
    boundary** (lines 1, 23, 35 in a 61-line file), not only on session open. The
    newest `custom-title` is the current name (the busy rename at line 40 supersedes
    the idle one at 35).
- **No `ai-title` was ever generated**: the session was named before its first
  prompt, matching the docs ("Naming the session replaces the generated title").
  For a session that got an automatic title first, the host transcript
  `-tachi-code-remoteagents/3c7df66e-….jsonl` shows the last `ai-title` (line 161)
  *after* the last `custom-title` (line 160), so a reader must prefer `custom-title`
  regardless of order; "last title record wins" would show the generated title.
- **Working state**: with a turn running (`@rac_attention` = `working`, the model
  thinking after a blocked tool call), `/rename` + Enter applied within the 0.8 s
  snapshot and wrote no `queue-operation` record. The docs' statement that commands
  sent mid-turn are queued does not hold for `/rename` in 2.1.263; it is a
  `local_command`.
- **No hook fires for `/rename`**: `UserPromptSubmit` and `Stop` did not run;
  `attention.log` shows only the real turn's `finished → working → finished`.
- **Exit hint** names the session: `claude --resume "<name>"`.
- **Dialogs swallow pasted text** (incidental, outside this effort):
  1. a fresh 2.1.263 launch showed a one-time "Use Fable 5.1 at high effort by
     default? ❯ Keep xhigh / Switch…" dialog; the pasted first prompt was dropped
     and Enter confirmed the default;
  2. `/exit` with a background shell running opened "Background work is running …
     1. Exit and stop tasks / 2. Move to background and exit / 3. Stay", which ate
     the probe's resume step (so re-emission on `--resume` was not re-observed here;
     the research doc's host evidence stands).

## Codex details

- **Automatic names**: `session_index.jsonl` got the provisional name (the first
  message, "Reply with only the word ok.") 30 ms after submit and the generated
  title ("Reply with ok") 2.6 s later; both as separate appended lines.
- **Idle rename**: index line `{"id":"<id>","thread_name":"<name>","updated_at":"<UTC>"}`
  appended immediately; sqlite `threads.name` updated immediately.
- **Working + Tab** (the Adapter's current working-state key): the pane showed
  `• Queued follow-up inputs ↳ /rename <name>  shift + ← edit last queued message`;
  nothing landed in any store until the spinner stopped, then the rename ran
  (index entry at 23:49:45.08Z, spinner off at 16:49:45.28 local). It was executed
  as a slash command, not sent as a message (rollout has no user record containing
  it). Correct but delayed, and the console's queued-prompt observation would see
  it as a queued prompt.
- **Working + Enter**: `• Session renamed to <name>…` appeared at once while the
  "Working (18s • esc to interrupt)" line kept counting; the turn continued and
  finished normally.
- **Store visibility**: `sqlite3 "file:state_5.sqlite?mode=ro"` saw every name
  within 3 ms. `?immutable=1` saw **nothing** for the whole session — not even the
  thread row — because Codex keeps its writes in the 4 MB write-ahead log until it
  checkpoints; the row appeared in the `immutable=1` read only after `/quit`. The
  research doc's `immutable=1` recipe is therefore wrong for a running Codex;
  open read-only *without* `immutable` (Node's `node:sqlite` `readOnly: true`
  behaves like `mode=ro`), or read `session_index.jsonl`.
- **`updated_at_ms` is not bumped by a rename** (16:48:52 before and after the
  16:49:05 rename; 16:49:45 after the next turn; 16:50:09 at quit). Renaming does
  not reorder the picker or a console list sorted by it.
- **Rollout** (44 lines) contains neither the name nor `/rename`; the pane title
  stayed `scratch`.
- **`/quit ` + Enter** exits immediately even mid-turn and prints
  `To continue this session, run codex resume, then select <name> (<id>)`.

## Consequences for the console (for the contract ticket)

1. **Send `Enter` for a rename in every state**, for both kinds; do not use the
   Adapter's `submission.prepare` keys (Codex would get `Tab` while working).
2. **Do not route the rename through `PromptService.submit`/`send`**: `send`
   records every submitted prompt into prompt history
   (`this.history?.record(scope, attachmentPrompt)`) and starts an
   `awaiting-start` phase for queued-prompt tracking. Paste + `Enter` directly on
   the pane (`tmux.pastePrompt` + `tmux.sendKeys`).
3. **Attention gate**: allow `finished` and `working`; refuse `question` (a dialog
   owns the keyboard and drops pasted text).
4. **Confirm the name took** by reading back within ~1 s: Claude → newest
   `custom-title` record (or the sidecar json) equals the typed name; Codex →
   newest `session_index.jsonl` line for the id equals the typed name. Write the
   console-named record only after that read-back succeeds.
5. **Claude reader**: prefer the newest `custom-title` over any `ai-title`; skip
   `isMeta` user records when counting prompts. **Codex reader**: open the state
   DB read-only without `immutable=1`; keep `session_index.jsonl` as the fallback.
6. Naming a fresh, unused Claude session creates its transcript; a console list
   built from transcripts will show it at once.

## Probe artefacts and caveats

- `working()` in `codex.sh` used `grep -P '^\xe2[\xa0-\xa3]'`, which under the
  UTF-8 locale matches U+00E2 rather than the byte, so the log's
  `working after: TIMEOUT` / `still working: NO` lines for Codex are false. The
  captures (`Working (17s • esc to interrupt)`) and `captures/codex/title.log`
  (Braille spinner 16:49:10–16:49:45 and 16:49:47–16:50:09) show the turn was
  running when each busy rename was sent. Use `LC_ALL=C` for that grep.
- Claude's `Bash(sleep 30)` was blocked by the harness hook, so the "busy" window
  was model thinking plus a background shell rather than a 30 s tool call; the
  attention state was `working` throughout.
- Side effects left behind: Claude session `3e9e95f3-…` in `~/scratch` history
  (named `rac-probe-busy-164653`) and Codex thread `01a0791f-e50b-7431-b91e-e30384bb5a65`
  (named `rac-probe-busy-enter-164847`).
