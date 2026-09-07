# How Claude Code names, lists and resumes conversations

Research for the effort "Replace bookmarks with named session selector"
(ticket: *How Claude Code names, lists and resumes conversations*). Written
2026-09-06 against Claude Code **2.1.260** (`claude --version` →
`2.1.260 (Claude Code)`) on this host, with the docs as of the same day.

Sources, in the order they were trusted:

- **Docs**: <https://code.claude.com/docs/en/sessions.md>,
  <https://code.claude.com/docs/en/commands.md>,
  <https://code.claude.com/docs/en/cli-reference.md>,
  <https://code.claude.com/docs/en/agent-view.md> (fetched 2026-09-06; the
  `.md` variants are the raw pages behind the HTML docs).
- **`claude --help`** of `/home/tgrosinger/.local/bin/claude` →
  `/home/tgrosinger/.local/share/claude/versions/2.1.260`.
- **Strings in that binary** (`command grep -a -o -E ... versions/2.1.260`),
  quoted where the docs are silent. Minified identifiers are version-specific.
- **Real transcripts** under `~/.claude/projects/` (138 top-level transcripts in
  15 project directories, read-only), plus **one throwaway `-p` session** run
  with a fresh `CLAUDE_CONFIG_DIR=$TMPDIR/claude-cfg` so nothing real was
  touched. That run failed at auth ("Not logged in · Please run /login") but
  still wrote its transcript, which is the `--name` evidence below.
- The console's current reader,
  `apps/server/src/adapters/claude-conversations.ts`.

Docs caveat that applies to everything below: "Each line is a JSON object for a
message, tool use, or metadata entry. The entry format is internal to Claude
Code and changes between versions, so scripts that parse these files directly
can break on any release." (sessions.md, *Where transcripts are stored*).

## 1. Where a session's display name lands

### Transcript records: `custom-title` (the name) and `agent-name`

A user-set name is a **`custom-title` record** in the session's transcript,
immediately followed by an **`agent-name` record** carrying the same string:

```
{"type":"custom-title","customTitle":"diagnose-shell","sessionId":"3c7df66e-2f0f-4060-b6e2-edd6f0f981c5"}
{"type":"agent-name","agentName":"diagnose-shell","sessionId":"3c7df66e-2f0f-4060-b6e2-edd6f0f981c5"}
```

- Source (`/rename`): `~/.claude/projects/-tachi-code-remoteagents/3c7df66e-2f0f-4060-b6e2-edd6f0f981c5.jsonl`
  line 90 is the `/rename` user record (a meta user message
  `The user named this session "diagnose-shell"`, timestamp
  `2026-09-04T05:10:26.128Z`); lines 88–89 are the `custom-title` and
  `agent-name` records above (`command grep -n -E '"type":"(agent-name|custom-title|ai-title)"'`).
- Source (`--name`): the throwaway run
  `claude -p --name "rac probe name" "reply with ok"` wrote, as its **first two
  records** (before any message):
  `{"type":"custom-title","customTitle":"rac probe name","sessionId":"7411e7e0-..."}`
  then `{"type":"agent-name","agentName":"rac probe name","sessionId":"7411e7e0-..."}`
  (`$TMPDIR/claude-cfg/projects/-tmp-claude-1000-claude-name-probe-xxx…/7411e7e0-f399-4df6-a8b0-3ffc21db8b76.jsonl`, lines 1–2).
- So **`--name` and `/rename` write the same field** (`custom-title.customTitle`).
  Docs agree they are one concept: "At startup | `claude -n auth-refactor`",
  "During a session | `/rename auth-refactor`" (sessions.md, *Name your sessions*),
  and the `--name` row: "`/rename` changes the name mid-session and also shows
  it on the prompt bar" (cli-reference.md).
- On this host `agent-name` appears in exactly the 19 transcripts that have a
  `custom-title`, and its value always equals the `customTitle`
  (`command grep -l -m1 -F '"type":"agent-name"' ~/.claude/projects/*/*.jsonl | wc -l` → 19;
  per-file comparison found no mismatch). The **derived default display name**
  (`<dir>-xx`, see §3) is *not* written to the transcript.
- The records are **re-emitted on every open**: file
  `3c7df66e…` holds the `custom-title` at lines 88, 108, 131, 146, 160 with the
  `ai-title` and `agent-name` re-emitted beside each; file
  `-tachi-code-remoteagents-worktrees-catppuccin/0569d5bb-….jsonl` has nine
  identical `custom-title` records (lines 1, 17, 41, …). Sixteen transcripts
  *start* with a `custom-title` record (first-record survey), which is the
  `/clear` carry-over: "With no argument, the new conversation keeps a name you
  set with `--name` or `/rename`, but not an AI-generated session title. To name
  the conversation you're leaving instead, pass the name, as in
  `/clear release-prep`" (sessions.md, *Manage context within a session*);
  the nine `latte-theme` and nine `bug-fixing` sessions here are such chains,
  and `/clear` markers exist in e.g. `0569d5bb…` and `3a49bc44…`
  (`command grep -l -m1 -E '<command-name>/(clear|branch|reset|new)</command-name>'`).

### Sidecar file: `projects/<encoded cwd>/<session-id>/custom-title.json`

Interactive named sessions also have a per-session directory beside the
transcript holding `custom-title.json`:

```
~/.claude/projects/-tachi-code-remoteagents/3c7df66e-2f0f-4060-b6e2-edd6f0f981c5/custom-title.json
{"customTitle":"diagnose-shell"}        # mtime 2026-09-03 22:10:26 -0700 == the /rename timestamp above
```

- Source: `command find ~/.claude/projects -name custom-title.json` → 19 files,
  exactly the 19 sessions that have `custom-title` records (`comm` of the two
  sets: both=19, neither side has extras). Each contains only
  `{"customTitle":"…"}`.
- The binary reads it from `join(dirname(transcriptPath), sessionId, "custom-title.json")`
  and validates `{customTitle: string}`:
  `function vyt(e,t){return R(D(e),t,"custom-title.json")}` with
  `var N=m(()=>c({customTitle:s()}))`, and lists it among per-session files
  `["ccr-tip.json","custom-title.json","precompact.json","sent-prefix.json",…]`
  (strings in `versions/2.1.260`).
- The `-p --name` probe did **not** create the sidecar (no
  `7411e7e0-…/` directory was written). Whether an *interactive* `--name`
  launch writes it before any `/rename` is **unverified** (the probe died at
  auth, and RAC never launches with `--name` today). Reading the transcript
  record is therefore the safe primary source; the sidecar is a cheap
  confirmation when present.

### Distinguishable from the automatic `ai-title`

Yes, by record type. The generated title is a separate record and **stays in
the file after naming**, re-emitted alongside the name:

```
{"type":"ai-title","aiTitle":"tmux fish shell git issue","sessionId":"3c7df66e-…"}   # lines 16,27,…,109,132,147,161
{"type":"custom-title","customTitle":"diagnose-shell","sessionId":"3c7df66e-…"}      # lines 88,108,131,146,160
```

Docs: "Generated title: if you don't name a session, Claude Code generates a
session title for it. The title is a short summary of your first prompt, written
by a background request to the small/fast model … Accepting a plan replaces it
with a title based on the plan. Naming the session replaces the generated
title." (sessions.md, *Name your sessions*). Consequence for the console: a
reader that takes "the last `ai-title` in the window" (the current
`claude-conversations.ts` line 89) will show the generated title for a named
session; **`custom-title` must win over `ai-title` regardless of order**.

Other title-ish records seen in heads (`command grep -o '^{"type":"[a-zA-Z_-]*"'`
over the first 200 KB of every transcript): `last-prompt`
(`{"type":"last-prompt","lastPrompt":"…","leafUuid":"…","sessionId":"…"}`,
present in all 138 files) is the cheapest "first/last prompt" fallback. No
`summary`, `sessionName`, `displayName`, `forkedFrom`, `parentSessionId` or
`pr-link` records exist on this host.

## 2. Listing recipe for one directory

### Layout of `~/.claude/projects/<encoded cwd>/`

Docs: "Claude Code stores transcripts as JSONL at
`~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is your
working directory path with non-alphanumeric characters replaced by `-`. For a
working directory whose converted name exceeds 200 characters, Claude Code
truncates the name to 200 characters and appends a hash of the full path"
(sessions.md, *Where transcripts are stored*). `CLAUDE_CONFIG_DIR` moves the
root; `CLAUDE_CODE_PROJECT_DIR_NAME` (only honoured together with
`CLAUDE_CONFIG_DIR`) pins the `<project>` name (same section).

The binary's encoder (strings in `versions/2.1.260`):

```js
var gK=200;
function wK(t){let e=0;for(let r=0;r<t.length;r++)e=(e<<5)-e+t.charCodeAt(r)|0;return e}   // 31-multiplier int32 string hash
function Te(e){return Math.abs(wK(e)).toString(36)}
function k(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}
function gA(e){let n=k(e);if(n.length<=gK)return n;return`${n.slice(0,gK)}-${Te(e)}`}
```

So `encodeProject(cwd) = dashed(cwd)` when `dashed.length <= 200`, else
`dashed.slice(0,200) + "-" + base36(abs(hash31(cwd)))` where the hash is over
the **original** path. The console's `encodeProject` (line 60) matches the
short case; adding the long case is a five-line port. (The probe cwd came out at
166 chars, so no truncated directory was observed; the code above is the only
evidence for the long case.)

Observed contents of one project directory (`command ls -la`, `command find … -mindepth 3 -maxdepth 3 | sed 's#.*/##' | sort | uniq -c`):

| Entry | What it is | Listing action |
| --- | --- | --- |
| `<uuid>.jsonl` | a session transcript | include |
| `<uuid>/` | per-session directory: `subagents/`, `tool-results/`, `custom-title.json` (59 / 42 / 19 on this host) | not a session; read `custom-title.json` if you want the sidecar |
| `<uuid>/subagents/agent-<id>.jsonl` + `agent-<id>.meta.json` | subagent (sidechain) transcripts; first record has `"isSidechain":true,"agentId":"…"`; meta is `{"agentType":"Explore","description":"…","toolUseId":"…","spawnDepth":1}` | exclude (never at top level) |
| `memory/` | auto-memory notes | exclude |
| `bridge-pointer.json` | Remote Control pointer (one project here) | exclude |

Every top-level `*.jsonl` name is a session UUID (survey of all 15 directories
against `^[0-9a-f]{8}-…{12}$`: the only non-UUID names were `memory` and
`bridge-pointer.json`). No top-level transcript contains `"isSidechain":true`
(0 of 138); all contain `"isSidechain":false` and `"userType":"external"`.

### What to exclude

- **Subagent / sidechain transcripts**: live under `<uuid>/subagents/`, so a
  top-level `*.jsonl` glob already excludes them (above).
- **`--print` / SDK runs**: persisted, but hidden from the picker and
  `--continue`. Docs: "Claude Code leaves sessions created with `claude -p` or
  the Agent SDK out of the session picker and out of `claude --continue`. You
  can still resume one by passing its session ID to `claude --resume
  <session-id>`" (sessions.md, *Resume a session*). On-disk marker: message
  records carry `"entrypoint":"sdk-cli"` and `"promptSource":"sdk"` (probe
  transcript user record; interactive records carry `"entrypoint":"cli"` and
  `promptSource` ∈ `typed | system | queued`, tally over all 138 host files).
  The binary's filter reads `entrypoint` from the transcript head or tail:
  `get=new Set(["sdk-cli","sdk-ts","sdk-py"]);function vhr(e,n){let r=sQ(e,"entrypoint")??X0(n,"entrypoint");if(r&&get.has(r))return!0;…`.
  RAC-launched sessions are interactive (`cli`), so this only matters for
  operator-run `claude -p`.
- **`--no-session-persistence`**: nothing to exclude; "Disable session
  persistence so sessions are not saved to disk and cannot be resumed. Print
  mode only. The `CLAUDE_CODE_SKIP_PROMPT_HISTORY` environment variable does the
  same in any mode" (cli-reference.md).
- **Forks / branches**: "Sessions created with `/branch` or `--fork-session` get
  their own session IDs and appear as separate rows. When the picker finds more
  than one entry for the same session, it groups them under a single row"
  (sessions.md, *Use the session picker*). They are ordinary top-level
  transcripts. No fork exists on this host (no transcript has more than one
  `sessionId` value in its first 3 MB), so the on-disk shape of a fork (whether
  copied records keep the parent's `sessionId`) is **unverified**.
- **`/loop`-first sessions**: "Sessions whose first prompt was a `/loop` command
  don't appear in the picker, and `claude --continue` skips them too"
  (sessions.md, *Where the session picker looks*). Marker unverified (none here).
- **Empty files**: `-tachi-code-remoteagents/80d20a1a-4550-552c-9348-390c6b2bc676.jsonl`
  is 0 bytes with no `sessionId`. Docs say the cross-project lookup wants "a
  transcript with messages", so skip files with no message record.
- **Moved sessions**: "From v2.1.169, moving a session with `/cd` relocates it to
  the new directory's project storage, so it appears in that directory's picker
  afterward" (same section), so a directory's listing is self-contained. The
  `cwd` field inside records does drift within a repo (20 transcripts here carry
  two or three `cwd` values, all subdirectories of the same worktree), but no
  transcript here carries a `cwd` from a different project directory.
- **Background sessions** (`claude --bg`) are *included* in the picker, marked
  `bg` (sessions.md); nothing to exclude.

### Is there a sessions index?

No index of past sessions. What exists:

- `~/.claude/sessions/<pid>.json` — a **live-process registry**, one file per
  running Claude (three here, matching the three tmux panes), e.g.
  `{"pid":3171920,"sessionId":"e52cc3b9-…","cwd":"/tachi/code/remoteagents.worktrees/named-sessions","startedAt":…,"version":"2.1.260","kind":"interactive","entrypoint":"cli","tmux":"named-sessions:@1.%1","messagingSocketPath":"/tmp/cc-socks/3171920.sock","name":"named-sessions-0f","nameSource":"derived","nameSince":…,"status":"busy","updatedAt":…}`
  (plus a `.key` per pid). This is what `claude agents --json` reports: "prints
  active sessions as a JSON array … `sessionId` is the full session UUID … An
  interactive session's `name` is its default display name until you name the
  session or accept a plan in it" (agent-view.md). The binary sets
  `nameSource:R?.source==="derived"?"derived":void 0`, so a user-set name has no
  `nameSource`. Useful for *running* sessions only; the console already knows
  its own panes.
- `~/.claude/history.jsonl` — one line per typed prompt:
  `{"display":"…","pastedContents":{},"timestamp":1787801374609,"project":"/tachi/code/dotfiles","sessionId":"95b48265-…"}`.
  139 distinct `sessionId`s vs 139 transcripts, but 6 each way do not match, so
  it is a hint, not an index.
- `~/.claude.json` → `projects["<cwd>"].lastSessionId` (key survey of the
  `projects` map) — only the last session per cwd.

### Is the file mtime a faithful last-active time?

Not for "last message". Bookkeeping records without timestamps (`cost-state`,
`custom-title`, `ai-title`, `mode`, `last-prompt`…) are appended at open/close,
so mtime moves without conversation activity:

```
-tachi-code-remoteagents/a4c5c82e…  mtime=2026-09-06 09:05:44  last timestamped record=2026-09-05T17:51:15.943Z  last record={"type":"cost-state"}
-tachi-code-remoteagents/0c5a914a…  mtime=2026-09-06 11:50:46  last timestamped record=2026-09-06T18:43:58.018Z
```

(`command ls -t … | head -12` with `stat -c %y` vs the last `"timestamp"` in
the final 8 KB.) Claude's own picker shows "time since last activity, git
branch, and file size" (sessions.md, *Use the session picker*); the binary's
listing stat helper returns `{mtime:Math.trunc(n.mtimeMs),size:n.totalBytes,head:n.head,tail:n.tail}`,
so Claude most likely displays mtime itself (inference from that helper, not a
verified display path). For a faithful "last active", read the last
`"timestamp"` in the tail; `user`, `assistant`, `system` and `queue-operation`
records carry one.

## 3. Resuming across worktrees, and `--resume <name>`

- **By ID from another cwd: yes.** "You can run `claude --resume <session-id>`
  from any directory: Claude Code looks for the ID in the current project
  directory and its git worktrees first, then in every other project on this
  machine, so it finds a session that started elsewhere or moved with `/cd`.
  The cross-project search resolves the ID only when exactly one other project
  holds a transcript with messages for it … Before v2.1.223, the lookup stopped
  at the current project directory and its git worktrees" (sessions.md, *Resume
  a session*). `claude --help`: `-r, --resume [value]  Resume a conversation by
  session ID, or open interactive picker with optional search term`. Where the
  transcript is written *after* such a resume (original directory vs the new
  cwd's directory) is **unverified**; no cross-directory transcript exists here.
- **From the picker**: "When you select a session from another worktree of the
  same repository, Claude Code resumes it in place; when the session's own
  worktree no longer exists, Claude Code resumes it in your current directory.
  When you select a session from an unrelated project, Claude Code copies a `cd`
  and resume command to your clipboard instead" (sessions.md, *Where the session
  picker looks*). Default picker scope: "Sessions from the current worktree,
  including background sessions … Sessions started elsewhere that added the
  current directory with `/add-dir`"; `Ctrl+W` widens to all worktrees, `Ctrl+A`
  to all projects.
- **`--resume <name>`**: "Resuming by name resolves across the current repository
  and its worktrees. Both forms look for an exact match and resume it directly
  even if it lives in a different worktree: `claude --resume <name>` — Exact
  match: Resumes directly; Ambiguous name: Opens the session picker with the
  name pre-filled as a search term. `/resume <name>` — Exact match: Resumes
  directly; Ambiguous name: Reports an error" (same section). A generated
  `ai-title` or plan title is also a resume handle ("You can pass either title
  to `claude --resume` or `/resume`, and Claude Code resolves it the same way as
  a name you set"); the derived default display name is not ("If you pass it to
  `claude --resume` or `/resume`, Claude Code doesn't find the session")
  (sessions.md, *Name your sessions*). Consequence: the console should resume by
  **UUID**, never by name, since names are not unique (nine `latte-theme`
  sessions exist in one directory).
- **`--continue`**: "Load the most recent conversation in the current directory,
  skipping background sessions, sessions created with `claude -p` or the Agent
  SDK, and sessions whose first prompt was `/loop`" (cli-reference.md).
- **`--fork-session`**: "When resuming, create a new session ID instead of
  reusing the original (use with `--resume` or `--continue`)";
  **`--session-id <uuid>`**: "Use a specific session ID for the conversation
  (must be a valid UUID)" (cli-reference.md; identical in `claude --help`).

## 4. `/rename` facts

- **Cannot clear a name.** commands.md row: "`/rename [name]` — Rename the
  current session and show the name on the prompt bar. Without a name,
  auto-generates one from conversation history. Also available in
  non-interactive mode (`-p`); requires Claude Code v2.1.205 or later. From every
  rename surface, including claude.ai and the desktop app, Claude Code replaces
  control and invisible characters in the new name with spaces and caps the name
  at 200 characters. If the name is empty once invisible characters are removed,
  Claude Code rejects it and shows `That name is empty once invisible characters
  are removed. Usage: /rename <name>`." Binary strings agree: `Could not
  generate a name: no conversation context yet. Usage: /rename <name>` and
  `User-set session title via /rename.` No "clear name" string or docs sentence
  exists (searched both). The only way to drop a name is to start a new
  conversation: `/clear <name>` names the *previous* conversation and "the new
  conversation then starts unnamed" (sessions.md).
- **Same field as `--name`**: §1 (both write `custom-title` + `agent-name`).
- **Live-name collisions**: "When you start or resume an interactive session
  with a name that another live session on this machine already uses, or rename
  a session into such a name, Claude Code leaves the name with the session that
  already has it, renames yours to a variant with a two-word suffix, such as
  `auth-refactor-graceful-unicorn`, and tells you … It doesn't check the
  `--name` of a background or `-p` session at startup" (sessions.md, *Name your
  sessions*). A console that launches `claude --name <x>` for two panes at once
  will see the second one renamed.
- **Slash command while a turn is running**: "If you send a command while Claude
  is responding, Claude Code queues it and runs it after the current turn
  finishes. Claude Code runs some commands immediately without interrupting the
  response, such as `/status`, `/tasks`, and `/usage`. In fullscreen rendering,
  Claude Code also opens dialog commands such as `/theme` and `/help`
  immediately. Before v2.1.234, Claude Code queued those dialogs until the turn
  finished" (commands.md). `/rename` is not in the immediate list, so it is
  queued; the queue is persisted as
  `{"type":"queue-operation","operation":"enqueue"|"dequeue","timestamp":"…","content":"…"}`
  records (67 host transcripts, and the probe).
- `--name` help text: `-n, --name <name>  Set a display name for this session
  (shown in the prompt box, /resume picker, and terminal title)`
  (`claude --help`); the docs add "You can resume a named session with
  `claude --resume <name>`" (cli-reference.md).

## 5. What this means for `apps/server/src/adapters/claude-conversations.ts`

The current reader (lines 77–94) scans a 4 MB head, keeps the last `ai-title`,
and falls back to the first typed human prompt. To extend it without
contradiction:

1. Track `custom-title` separately and prefer it: `custom-title` > `ai-title` >
   `last-prompt`/first typed prompt. Do not let a later `ai-title` overwrite a
   `custom-title` (both are re-emitted, interleaved).
2. Optionally read `projects/<enc>/<id>/custom-title.json` (`{customTitle}`) as
   a cheap sidecar; treat absence as "unnamed", not as an error, since the `-p`
   probe shows the record can exist without the file.
3. Port the >200-char encoder from §2 so the "degrades to not found" comment on
   line 58 goes away.
4. For listing: top-level `<uuid>.jsonl` in `projects/<enc(cwd)>/`, skip 0-byte
   files, skip files whose head/tail `entrypoint` is `sdk-cli|sdk-ts|sdk-py`,
   and compute last-active from the last `timestamp` in the tail rather than
   mtime. Subagent transcripts are never top-level, so no sidechain check is
   needed at this layer.
5. Resume by UUID (`claude --resume <uuid>`), from the worktree's own cwd; the
   docs guarantee the ID is found from any directory on 2.1.223+.

## Unverified

- Whether an interactive `claude --name` launch writes `<id>/custom-title.json`
  (only the transcript record was observed, from a `-p` run that died at auth).
- Which directory a transcript continues in after `claude --resume <id>` from a
  different worktree's cwd.
- The on-disk shape of a `--fork-session` / `/branch` transcript (no fork on
  this host).
- The marker for a `/loop`-first session.
- That the picker's "time since last activity" is literally the file mtime
  (inferred from the binary's stat helper).
- The long-path directory name in practice (the probe's cwd was 166 chars; only
  the binary's code was read).
