# How Codex and OMX name, list and resume conversations

Research for the effort "Replace bookmarks with named session selector"
(ticket: *How Codex and OMX name, list and resume conversations*). Written
2026-09-06 against Codex CLI **0.150.0** (`codex --version` → `codex-cli 0.150.0`,
binary `/home/linuxbrew/.linuxbrew/bin/codex`) and oh-my-codex **0.21.0**
(`omx --version` → `oh-my-codex v0.21.0`, package at
`/home/tgrosinger/.local/share/mise/installs/npm-oh-my-codex/v0.21.0/node_modules/oh-my-codex`).

Sources, in the order they were trusted:

- **openai/codex source at tag `rust-v0.150.0`** (tag object
  `9bdd7a39c5034657dfbbb89381cd9364f61eee11`, from
  `gh api repos/openai/codex/git/refs/tags/rust-v0.150.0`). Files were fetched
  raw with `gh api -H 'Accept: application/vnd.github.raw+json'
  repos/openai/codex/contents/<path>?ref=rust-v0.150.0`; every `path:line`
  below is that tag, i.e. `https://github.com/openai/codex/blob/rust-v0.150.0/<path>#L<line>`.
- **`codex --help`** and the `resume`, `archive`, `unarchive`, `delete`,
  `migrate-rollouts`, `fork` help pages of the installed binary.
- **Official docs**: `docs/slash_commands.md` and `docs/config.md` in the repo
  are one-line pointers to <https://developers.openai.com/codex/cli/slash-commands>
  and <https://developers.openai.com/codex/config-reference>, which 308-redirect
  to <https://learn.chatgpt.com/docs/developer-commands?surface=cli> and
  <https://learn.chatgpt.com/docs/config-file/config-reference> (fetched 2026-09-06).
- **`~/.codex` on this host**, read-only (SQLite opened with `?immutable=1`).
- **OMX**: `omx --help`, `omx resume --help`, `omx session --help`, and the
  compiled package source under `dist/` (paths below are relative to the package
  root above).
- The console's current reader,
  `apps/server/src/adapters/codex-conversations.ts` (this worktree).

Terminology: Codex calls one conversation a **thread**; its on-disk transcript
is a **rollout** (`rollout-<ts>-<uuid>.jsonl`). The CLI help says "session" for
the same thing. "Session" is reserved for tmux in this repo's CONTEXT.md, so
this note says *thread* and *rollout*.

## 0. Short answers

- **Where the name lives**: `threads.name` in `~/.codex/state_5.sqlite` for
  every thread the current TUI creates (they are all `history_mode =
  'paginated'`), plus an append-only sidecar `~/.codex/session_index.jsonl`
  (`{"id","thread_name","updated_at"}`) that is written on every name change
  and is the *only* name store for old `legacy` threads. The name is **not**
  in the rollout: `SessionMeta` has no name field (§2.2). The store does not
  record whether a name was typed by the user or generated.
- **Every thread gets a name automatically**: the TUI sets a provisional name
  (first user message, whitespace-collapsed, first 36 chars) and then replaces
  it with a model-generated title unless the user renamed meanwhile (§3.1).
  `/rename` goes through the same `thread/setName` RPC (§3.2). An empty name is
  rejected, so a name cannot be cleared through any user-facing path (§3.3).
- **The walker still sees every thread**: rollouts are still written to
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` with `session_meta`
  at ordinal 0 for paginated threads, and `codex migrate-rollouts --apply`
  rewrites a legacy rollout *in place* (staged file renamed over the same
  path). The "paginated thread history" store (`thread_history_1.sqlite`) is a
  projection, not a replacement (§4).
- **Listing recipe**: the picker calls `thread/list` with page size 25, sort
  `UpdatedAt` (toggle `CreatedAt`), `archived=false`, source kinds `cli`+
  `vscode`, the configured model provider, and `cwd = config.cwd` unless
  `--all`; rows show `name ?? preview`, updated time, and (with `--all`) cwd.
  Server side this is a SQLite query when the DB is usable, else a bounded
  filesystem scan (10 000 files, 10 head records per file, mtime as
  updated-at) (§5).
- **`codex resume <name>`**: UUID wins if it parses; otherwise exact,
  case-sensitive match on `thread.name` among *active* threads, newest first,
  verified against the rollout's `session_meta.id` (§6). Resume never filters
  by cwd; where the resumed thread *runs* is `tui.resume_cwd`
  (`current`/`session`/unset → interactive prompt when the two differ) (§6.3).
- **archive/unarchive/delete**: archive renames the rollout into the flat
  `~/.codex/archived_sessions/<file>` and sets `archived=1`; unarchive moves it
  back under `sessions/<date from filename>/`; delete removes the file(s), the
  history projection rows, the `session_index.jsonl` entries and (via the
  app-server) the SQLite row; `delete --force` requires a UUID (§7).
- **OMX**: `omx --direct resume <name>` ends as `codex resume <name> -c
  model_instructions_file="<.omx overlay path>"` spawned from `PATH` with
  inherited stdio; OMX strips only its own flags (`--direct`, `--project`,
  `--codex-home`, `--madmax`, ...). OMX keeps **no** thread name or index of
  its own; `.omx/state/session.json` is a liveness pointer for the OMX launch
  (`session_id: omx-<ts>-<rand>`, `native_session_id` = Codex thread id, pid
  identity), and `omx session search/friction` re-scan
  `<codexHome>/sessions/rollout-*.jsonl` (§8).

## 1. What is in `~/.codex` on this host

`ls -la ~/.codex` (2026-09-06):

| Entry | What it is | Source |
| --- | --- | --- |
| `sessions/2026/MM/DD/rollout-*.jsonl` | 17 active rollouts (`find ~/.codex/sessions -name 'rollout-*.jsonl' \| wc -l` → 17) | `codex-rs/rollout/src/lib.rs:67` (`SESSIONS_SUBDIR = "sessions"`) |
| `archived_sessions/` | absent on this host (nothing archived yet) | `codex-rs/rollout/src/lib.rs:68` (`ARCHIVED_SESSIONS_SUBDIR`) |
| `state_5.sqlite` | the state DB: `threads` table with `name`, `title`, `cwd`, `archived`, `history_mode`, `rollout_path`, … | `codex-rs/state/src/sqlite.rs:33` (`STATE_DB_FILENAME = "state_5.sqlite"`) |
| `thread_history_1.sqlite` | the "paginated thread history" projection (`thread_items`, `thread_turns`, `thread_history_projection_state`) | `codex-rs/state/src/sqlite.rs:34` |
| `session_index.jsonl` | append-only name sidecar, 33 lines | `codex-rs/rollout/src/session_index.rs:21` |
| `history.jsonl` | the global composer message history (`{"session_id","ts","text"}` per user message), not a thread index | `codex-rs/message-history/src/lib.rs:1-9,52` |
| `logs_2.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`, `queue_1.sqlite` | other runtime DBs | `codex-rs/state/src/sqlite.rs:29,139-155` |
| `thread-writer-locks/<uuid>.lock` | cross-process writer locks | `codex-rs/thread-store/src/local/writer_lock.rs` (exists in tree; not read) |
| `config.toml` | only `[projects."…"] trust_level` entries on this host | `cat ~/.codex/config.toml` |

No `*.zst` file exists anywhere under `~/.codex` (`find ~/.codex -maxdepth 4 -name '*.zst'` → nothing).

## 2. Storage model

### 2.1 Rollout file

Head of the newest rollout
(`~/.codex/sessions/2026/09/02/rollout-2026-09-02T13-53-17-01a063e5-c480-7ee3-b7f0-ada5183fade0.jsonl`, `head -c 4000`):

```
{"timestamp":"2026-09-02T20:53:25.675Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a063e5-…","id":"01a063e5-c480-7ee3-b7f0-ada5183fade0","timestamp":"2026-09-02T20:53:17.573Z","cwd":"/tachi/code/remoteagents","originator":"codex-tui","cli_version":"0.150.0","source":"cli","thread_source":"user","model_provider":"openai","base_instructions":{…},…,"history_mode":"paginated"}}
{"timestamp":"…","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"…",…}}
{"timestamp":"…","ordinal":2,"type":"response_item","payload":{"type":"message","id":"msg_…","role":…
```

The `session_meta` payload is `SessionMeta`
(`codex-rs/protocol/src/protocol.rs:2885-2935`): `session_id`, `id`,
`forked_from_id`, `parent_thread_id`, `timestamp`, `cwd`, `originator`,
`cli_version`, `source`, `thread_source`, `agent_nickname`, `agent_role`,
`agent_path`, `model_provider`, `base_instructions`, `dynamic_tools`,
`selected_capability_roots`, `memory_mode`, `history_mode` (`#[serde(default)]`
→ `legacy`), `history_base`, … **There is no name/title field.** The only
`thread_name` in that file is on a different struct (`protocol.rs:3699`, a
wire type unrelated to `SessionMeta`).

`ThreadHistoryMode` is `Legacy | Paginated`, default `Legacy`
(`protocol.rs:717-730`).

### 2.2 `state_5.sqlite` → `threads`

Schema dumped from the host DB (`sqlite_master`, opened `immutable=1`):

```
CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, source TEXT NOT NULL, model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER, git_sha TEXT, git_branch TEXT, git_origin_url TEXT,
    cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '',
    agent_nickname TEXT, agent_role TEXT, memory_mode TEXT NOT NULL DEFAULT 'enabled',
    model TEXT, reasoning_effort TEXT, agent_path TEXT, created_at_ms INTEGER,
    updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '',
    recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0,
    history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0,
    thread_section_id TEXT REFERENCES thread_sections(id) ON DELETE SET NULL,
    section_position INTEGER, section_entered_at_ms INTEGER,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL)
```

Indexes include `idx_threads_archived_cwd_updated_at_ms ON threads(archived, cwd,
updated_at_ms DESC, id DESC)` and `idx_threads_archived_cwd_recency_at_ms`, i.e.
the (archived, cwd, recency) listing is the designed access path. The `name`
column was added by migration `0041_threads_name.sql`; `history_mode` by
`0040_threads_history_mode.sql` (`ALTER TABLE threads ADD COLUMN history_mode
TEXT NOT NULL DEFAULT 'legacy';`) — both present in the tag's
`codex-rs/state/migrations/`. The Rust row type is `ThreadMetadata`
(`codex-rs/state/src/model/thread_metadata.rs:124-187`): `name` is documented
as "Explicit user-facing thread name, if one was set." (line 159-160).

Host rows (2026-09-06, `SELECT history_mode, archived, source, count(*) … GROUP BY`):
`('paginated', 0, 'cli', 17)` — **all 17 threads are paginated and active**;
`backfill_state` is `status='complete'`; `rollout_migration_state` is empty
(nothing was ever migrated: these threads were *born* paginated). Every row has
a non-null `name` (e.g. `('01a063e5-…', name='Respond to greeting',
title='Hello', first_user_message='Hello', preview='Hello',
cwd='/tachi/code/remoteagents', 'paginated', 0, recency_at_ms=1788382405681,
rollout_path='/home/tgrosinger/.codex/sessions/2026/09/02/rollout-…jsonl')`).

`thread_history_1.sqlite` on the host has 17 `thread_history_projection_state`
rows and 172 `thread_items` across 17 threads: the projection covers every
thread, and `thread_history_projection_state(thread_id,
next_rollout_byte_offset, next_rollout_ordinal)` records how far into the
*rollout file* each projection has read — the rollout stays the source.

### 2.3 `session_index.jsonl`

Format and semantics (`codex-rs/rollout/src/session_index.rs`):

- `SessionIndexEntry { id: ThreadId, thread_name: String, updated_at: String }` (lines 24-29).
- `append_thread_name` appends one line per name change; "Name updates are
  append-only; the most recent entry wins when resolving names or ids"
  (lines 31-50). File is `<codex_home>/session_index.jsonl` (line 21, 240-242).
- `remove_thread_name_entries` rewrites the file without a thread's lines
  (lines 73-105); it is called from delete (§7.3).
- `find_thread_name_by_id` scans from the end for the newest entry
  (lines 107-121); `find_thread_names_by_ids` reads forward, last write wins
  (lines 123-152).
- `find_thread_meta_candidates_by_name_str` streams ids newest-first whose
  *latest* recorded name equals `name`, resolves each id to a rollout with
  `find_thread_path_by_id_str` + `read_session_meta_line`, filters by allowed
  sources/providers, and sorts by rollout mtime (lines 173-241, 258-274).

Host file (33 lines) shows the two-step auto naming of §3.1, e.g.

```
{"id":"01a063e5-c480-7ee3-b7f0-ada5183fade0","thread_name":"Hello","updated_at":"2026-09-02T20:53:25.975357809Z"}
{"id":"01a063e5-c480-7ee3-b7f0-ada5183fade0","thread_name":"Respond to greeting","updated_at":"2026-09-02T20:53:28.175976145Z"}
```

and a 36-character provisional name for a longer first message:
`"thread_name":"Let's make the install script instal"` followed 4 s later by
`"Install bubblewrap for Debian"`.

### 2.4 Which store is authoritative for the name

`codex-rs/thread-store/src/local/helpers.rs:237-272` (`resolve_thread_names`):
for a **paginated** thread the name is `threads.name` (`sqlite_thread_name`,
non-empty); for a **legacy** thread it is `threads.title` when the title
differs from `first_user_message` (`distinct_thread_metadata_title`, lines
274-281), else the newest `session_index.jsonl` entry ("Legacy titles remain
authoritative when present; the index only fills names for threads whose
SQLite title is still derived from the preview", lines 265-269).
`set_thread_name` (lines 283-287) then only exposes a legacy name when it
differs from the preview.

`codex-rs/state/src/runtime/threads.rs:64-89` (`mark_thread_paginated`)
documents the split: "Legacy threads display `title`, then fall back to the
name index. Paginated threads display `name`; `title` remains derived metadata
used for search."

## 3. How a thread gets a name

### 3.1 Automatic: provisional then generated

`codex-rs/tui/src/app/thread_routing.rs:1823-1852`: on the first user message
the TUI computes `expected_title = user_message.split_whitespace().join(" ")`
truncated with `.chars().take(THREAD_TITLE_MAX_CHARS)`, calls
`app_server.thread_set_name(thread_id, expected_title)`, marks it as an
expected automatic name, and starts `generate_thread_title(…,
ThreadTitleDestination::Automatic { expected_title }, thread_title_prompt(&user_message))`.
`THREAD_TITLE_MAX_CHARS = 36`, `THREAD_TITLE_MODEL = "gpt-5.6-luna"`
(`codex-rs/tui/src/app/thread_title.rs:22-23`); the generation runs in a hidden
temporary thread with a structured-output schema (`thread_title.rs:34-83,
85-141, 200-214`), using that model only for the `openai` provider with a
ChatGPT account, else the current model (`thread_title.rs:43-54`).

`codex-rs/tui/src/app/event_dispatch.rs:2507-2521`: when the generated title
arrives, it is applied with another `thread_set_name` **only if** the thread's
current name still equals `expected_title` — "Replace the provisional name only
if the user has not renamed the thread" (`codex-rs/tui/src/app_event.rs:198-205`).
The generated title is normalised by `parse_thread_title` (trim, strip quotes,
strip trailing `.?!`; `thread_title.rs:349-374`).

Consequence: **every interactive thread has a name**, and nothing in SQLite or
the index distinguishes a user-typed name from a generated one (both arrive via
the same `thread/setName` RPC, §3.2). The TUI's `pending_automatic_thread_names`
set (`codex-rs/tui/src/chatwidget/session_flow.rs:250-282`) is in-memory only.

### 3.2 Manual: `/rename` → `thread/setName`

- Slash command list (`codex-rs/tui/src/slash_command.rs:15-82`) includes
  `Rename` ("rename the current thread", line 94), `Resume` ("resume a saved
  chat"), `Archive` ("archive this session and exit"), `Delete` ("permanently
  delete this session and exit"), `New`, `Fork`, `Clear`, `Rollout` ("print
  the rollout file path", line 149). Docs page: "`/rename` — Rename the current
  chat", "`/archive` — Archive the current session"
  (<https://learn.chatgpt.com/docs/developer-commands?surface=cli>).
- `/rename` alone opens a prompt (`codex-rs/tui/src/chatwidget/slash_dispatch.rs:282-285`,
  `show_rename_prompt`, with an editable model suggestion via
  `ThreadTitleDestination::RenameSuggestion`); `/rename <text>` normalises the
  text and sends `set_thread_name` (`slash_dispatch.rs:756-766`).
- App-server side, `thread_set_name_response_inner`
  (`codex-rs/app-server/src/request_processors/thread_processor.rs:1751-1782`):
  `ThreadSetNameParams { thread_id: String, name: String }`
  (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:753-756`) →
  `normalize_thread_name` (trim; empty → `None`,
  `codex-rs/core/src/util.rs:101-109`) → **`invalid_request("thread name must
  not be empty")`** when empty → `update_thread_metadata(patch { name:
  Some(Some(name)) })` → `ThreadNameUpdatedNotification`.
- Store side, `codex-rs/thread-store/src/local/update_thread_metadata.rs`:
  the SQLite write is `update_thread_name(thread_id, name)` for paginated
  threads and `update_thread_title(thread_id, name)` for legacy ones
  (lines 495-510); then, for both modes, `append_thread_name(codex_home,
  thread_id, name)` appends to `session_index.jsonl` (lines 128-137 paginated;
  182-191 legacy). Legacy threads additionally get a rollout reconcile
  (`reconcile_rollout`, lines 167-176) — but nothing is written *into* the
  rollout for the name.

### 3.3 Can a name be cleared?

Not through any user-facing path in 0.150.0: `thread/setName` rejects an empty
name (§3.2), the CLI has no unname/clear flag (`codex --help`,
`codex resume --help`), and the slash list has no such command. Internally
`StateRuntime::update_thread_name(thread_id, Option<&str>)` can write `NULL`
(`codex-rs/state/src/runtime/threads.rs:730-741`) and the metadata patch type
is `Option<Option<String>>`, so a clear is representable but unreachable.
`mark_thread_paginated` preserves an existing name across migration
(`threads.rs:64-89`).

### 3.4 Resume hint wording

On exit the CLI prints a resume hint: with a name, "codex resume, then select
<name> (<uuid>)"; without one, `codex resume <uuid>`; and `resume_command`
prefers the name (`codex resume my-thread`, quoting it with shlex and
inserting `--` when it starts with `-`)
(`codex-rs/utils/cli/src/resume_command.rs:6-30`).

## 4. Legacy vs paginated, `migrate-rollouts`, and the console walker

### 4.1 New threads are paginated

The TUI's `thread/start` request sets `history_mode: (!config.ephemeral)
.then_some(ThreadHistoryMode::Paginated)`
(`codex-rs/tui/src/app_server_session.rs:1862`); the app-server only refuses
this when the thread store lacks paginated list support
(`thread_processor.rs:1124-1131`). The store-level default is `Legacy`
(`codex-rs/thread-store/src/store.rs:76-78`) and core uses
`requested_history_mode.unwrap_or_else(|| thread_store.default_history_mode())`
(`codex-rs/core/src/session/mod.rs:669-670`), so the paginated choice is the
TUI's. The host confirms it: all 17 threads are paginated and were never
migrated (§2.2), and their rollouts carry `"history_mode":"paginated"` in
`session_meta` (§2.1).

### 4.2 What `codex migrate-rollouts` does

Help: "Inspect or migrate legacy local sessions to paginated thread history";
`--apply` publishes, otherwise it only reports; `--thread <THREAD_ID>`,
`--max-mib-per-second`, `--json`, `--verbose`
(`codex-rs/cli/src/migrate_rollouts.rs:21-46`). Dry-run output: "Scanned {}
rollout(s): {} eligible, {} already paginated, {} skipped ({} empty, {} busy),
{} failed." and "Run `codex migrate-rollouts --apply` to migrate eligible
sessions." (lines 309-338).

Mechanics (`codex-rs/thread-store/src/local/rollout_migration.rs`): "find
rollout files, decide whether each one is eligible, take the maintenance and
writer locks, canonicalize into a staged JSONL file, project that staged file
into SQLite, verify the projection, then atomically publish it. The important
invariant is that we always leave behind either the original legacy rollout or
a recoverable paginated rollout." (lines 1-9). Publishing is
`tokio::fs::rename(&staged_path, rollout_path)` (line 821; compressed variant
line 813) — **the rollout keeps its path under `sessions/`** — and "Paginated
rollouts always keep their canonical SessionMeta at ordinal zero" (line 679).
It scans both `sessions/` and `archived_sessions/` ("beneath active and
archived sessions", line 267) and promotes the legacy name into `threads.name`
(`promote_legacy_name` → `mark_thread_paginated`, lines 343-359, 515).
It can also run automatically at startup, but only behind the
`background_paginated_rollout_migration` feature, which is
`Stage::UnderDevelopment, default_enabled: false`
(`codex-rs/core/src/thread_manager.rs:373-403`,
`codex-rs/features/src/lib.rs:1032-1037`).

### 4.3 Impact on `apps/server/src/adapters/codex-conversations.ts`

What the walker relies on, and whether it still holds:

| Walker assumption | Status | Evidence |
| --- | --- | --- |
| Files named `sessions/…/rollout-*-<uuid>.jsonl` (`openRollouts` regex l.80, `validRolloutRef` l.45-53, `rolloutFileById` l.208-228, `rolloutByCwd` l.253) | holds for every thread on the host; migration keeps the path | §2.2 `rollout_path` column, §4.2 |
| Line 1 is `session_meta` with `id`, `cwd`, `originator === 'codex-tui'`, optional `parent_thread_id` (`rolloutMetadata` l.92-112) | holds; paginated meta adds `history_mode` but keeps those fields | §2.1 |
| Title = newest `response_item` `message`/`role: user` in the tail (`rolloutTitle` l.155-167) | holds: paginated rollouts still persist `ResponseItem`s (policy keeps `should_persist_response_item` unconditional, `codex-rs/rollout/src/policy.rs:10-13,42`); host newest rollout has 2 `response_item/message/user` records | `python3` record census of the newest rollout: `3 developer, 2 user, 1 assistant` messages |
| Completion = `event_msg` `task_started` … `task_complete` / `turn_aborted` with monotonic `ordinal` (`completionFromRecords` l.305-325) | holds: `TurnStarted`, `TurnComplete`, `TurnAborted`, `TokenCount` are persisted in both modes (`policy.rs:107-113`); host rollout has `task_started`, `task_complete`, `token_count`, `item_completed` | same census |
| Not relied on, but changed: `event_msg` `user_message` / `agent_message` / reasoning events are **no longer persisted** for paginated threads (`policy.rs:115-131`); `item_completed` (`TurnItem`s) is persisted instead (`policy.rs:91-96`) | — | — |

Two caveats the walker does not handle today:

1. **Compression.** With the `local_thread_store_compression` feature
   (`Stage::UnderDevelopment, default_enabled: false`,
   `codex-rs/features/src/lib.rs:1026-1031`) a worker renames rollouts older
   than 7 days to `rollout-….jsonl.zst` (`codex-rs/rollout/src/compression.rs:18,
   256, 726-729`; `MIN_ROLLOUT_AGE = 7 days`). All walker regexes require a
   `.jsonl` suffix, so compressed rollouts would become invisible. Off by
   default; no `.zst` on this host.
2. **Archived threads** move to the flat `archived_sessions/` directory (§7.1),
   which the walker never visits — acceptable, since archived means "hide from
   active lists".

Also relevant for a selector: the walker cannot obtain the **name** from the
rollout at all; it must come from `state_5.sqlite` (`threads.name`) or, for
legacy threads, `session_index.jsonl` (§2.4).

## 5. Listing recipe

### 5.1 What the resume picker asks for

`codex resume` with no id opens the picker
(`codex-rs/cli/src/main.rs:344-366` `ResumeCommand`: `[SESSION_ID]`, `--last`,
`--all` "Show all sessions (disables cwd filtering and shows CWD column)",
`--include-non-interactive`; `main.rs:2740-2752` sets `resume_picker`,
`resume_show_all`, `resume_include_non_interactive`).

`codex-rs/tui/src/resume_picker.rs`:

- `PAGE_SIZE = 25` (line 88); default sort `ThreadSortKey::UpdatedAt`
  (line 1009), toggled to `CreatedAt` in the toolbar (lines 1774-1781, labels
  "Created"/"Updated" 757-760).
- cwd filter: `picker_cwd_filter(config.cwd, show_all, …)` returns `None` when
  `--all`, else `config.cwd` (lines 637-650); `SessionFilterMode::Cwd|All` can
  be toggled in-picker (lines 199-220, 1784-1790). Rows are additionally
  post-filtered locally with `paths_match_after_normalization(row.cwd,
  filter_cwd)` (lines 1584-1595, 2007-2009).
- `thread_list_params` (lines 1976-2000): `limit: 25`, `sort_key`,
  `model_providers: [config.model_provider_id]` (local), `source_kinds:
  resume_source_kinds(include_non_interactive)` = `[Cli, VsCode]` (+ `Exec,
  AppServer` with the flag; `codex-rs/tui/src/lib.rs:635-645`), `archived:
  status == Archived` (the picker also has an Archived tab, `SessionStatus`
  lines 224-228, and Archive/Unarchive actions 705-753), `cwd` filter,
  `use_state_db_only` for the first fast page then a scan-and-repair page
  (`PageLoadMode`).
- Row (`row_from_app_server_thread`, lines 1950-1974): `preview` (or "(no
  message yet)"), `thread_name: thread.name`, `created_at`, `updated_at`,
  `cwd`, `git_branch`; the label shown is `thread_name` else `preview`
  (line 935); the search box matches name, preview and cwd (lines 942-963).
- `--last`: `thread/list` with `limit: 1`, sort `UpdatedAt`, same source/
  provider/cwd filters, first StateDbOnly then ScanAndRepair, and the hit must
  have an existing rollout path (`codex-rs/tui/src/lib.rs:682-751`,
  `latest_session_cwd_filter` 837-851).

### 5.2 What the server does

`thread/list` → `codex-rs/thread-store/src/local/list_threads.rs:24-118` →
`RolloutRecorder::list_threads*` → `list_threads_with_db_fallback`
(`codex-rs/rollout/src/recorder.rs:460-660`):

- `StateDbOnly` → pure SQLite (`state_db::list_threads_db`, lines 480-500).
- Otherwise a filesystem page is scanned first (double page size for DESC),
  each hit read-repairs its SQLite row, then the SQLite page is returned, with
  scan-only fallback when the DB is unavailable (lines 504-660). Names are
  filled afterwards by `resolve_thread_names` (§2.4).
- SQLite filter/order (`codex-rs/state/src/runtime/threads.rs:1264-1300,
  1370-1450, 1500-1527`): `WHERE archived = 0|1 AND preview <> '' AND source IN
  (…) AND model_provider IN (…) AND cwd IN (…) [AND (instr(COALESCE(name,''),
  ?) > 0 OR instr(title, ?) > 0 …)] ORDER BY updated_at_ms|created_at_ms|
  recency_at_ms DESC, id DESC LIMIT ?`. cwd values are normalised with
  `normalize_cwd_for_state_db` (`codex-rs/rollout/src/state_db.rs:290-292`,
  also applied on write at 558, 631, 710), so the match is on the normalised
  string.

### 5.3 Scan bounds (thousands of rollouts)

`codex-rs/rollout/src/list.rs`: `MAX_SCAN_FILES = 10000` ("Hard cap to bound
worst-case work per request"), `HEAD_RECORD_LIMIT = 10`,
`USER_EVENT_SCAN_LIMIT = 200` (lines 123-126). The walk is
`sessions/<year desc>/<month desc>/<day desc>/rollout-*` sorted by the
filename timestamp+uuid descending (`walk_rollout_files` 1039-1070,
`collect_rollout_day_files` 958-969); `UpdatedAt` sorting pre-sorts candidates
by mtime (`traverse_directories_for_paths_updated` 553-597). Per file it reads
at most 10 head lines (+ up to 200 more until a preview is found) and takes
`cwd`, `source`, `history_mode`, `parent_thread_id`, `model_provider`,
`cli_version`, `created_at` from `session_meta`, `updated_at` from file mtime
(`read_head_summary` 1105-1160; `ThreadItem` doc "RFC3339 timestamp string for
the most recent update (from file mtime)" line 87-90). A file with no
`session_meta` or no preview is dropped (line 813).

### 5.4 Recipe for the console (derived)

- Fast path: read `state_5.sqlite` read-only (`immutable=1`, no WAL/SHM
  writes):
  `SELECT id, name, title, preview, cwd, recency_at_ms, updated_at_ms,
  rollout_path, history_mode FROM threads WHERE archived = 0 AND source = 'cli'
  AND preview <> '' [AND cwd = ?] ORDER BY updated_at_ms DESC, id DESC LIMIT 25`.
  Use `name` for paginated rows; for legacy rows use `title` when it differs
  from `first_user_message`, else the newest `session_index.jsonl` line for
  that id (§2.4). The filename is versioned (`state_5.sqlite` at 0.150.0,
  `codex-rs/state/src/sqlite.rs:33`) and changes with schema major bumps.
- Fallback (DB missing or version mismatch): the existing newest-first walk of
  `sessions/`, reading line 1 only, capped (the console already caps at 512 /
  4096 entries; Codex itself caps at 10 000 files and 10 lines per file).
- Names for the fallback: one forward read of `session_index.jsonl` (last
  entry per id wins).

## 6. `codex resume <name>`

### 6.1 Resolution order

`lookup_session_target_with_app_server` (`codex-rs/tui/src/lib.rs:647-680`):
if `Uuid::parse_str` succeeds → `thread/read`; else
`named_session_lookup::lookup` (`codex-rs/tui/src/named_session_lookup.rs:52-90`):

1. `StateDbOnly` pass: page `thread/list` (limit 100, sort `RecencyAt` on the
   embedded server, `archived: false`, `source_kinds` `[Cli, VsCode]`,
   `search_term: name` as a substring prefilter, `cwd: None`) and take the
   first thread whose `name == name` **exactly** (`NamedSessionCandidates::next`,
   lines 221-297; equality at 227). The candidate's `path` must exist under
   `sessions/`, and its rollout `session_meta.id` must equal the thread id
   (lines 233-256); source must be `cli`/`vscode` and provider must match
   (lines 168-176).
2. Legacy index pass: `find_thread_meta_candidates_by_name_str` over
   `session_index.jsonl` (§2.3), path must be under `sessions/`, the current
   SQLite title must be compatible, then the name is repaired into SQLite
   (lines 92-140, `current_name_is_compatible` 142-148).
3. `ScanAndRepair` pass (filesystem scan with SQLite repair).

Duplicate names therefore resolve to the most recently active thread. A name
that is archived is not found by `resume` (active-only), and a miss exits with
`missing_session_exit(id_str, "resume", …)` (`lib.rs:1358-1385`). Resuming an
archived thread by **UUID** shows "This conversation is archived — Unarchive
and resume / Cancel" (`codex-rs/tui/src/unarchive_prompt.rs:154-181`).
CLI help wording: "Session id (UUID) or session name. UUIDs take precedence if
it parses." `fork` accepts only a UUID (`codex fork --help`).

### 6.2 No cwd filter on id/name resume

Neither pass above passes a cwd (`cwd: None`, line 288), so `codex resume
<name>` works from any directory; only the picker and `--last` apply the cwd
filter that `--all` lifts (§5.1).

### 6.3 Which directory the resumed thread runs in

`tui.resume_cwd` (`ResumeCwdMode`, `codex-rs/config/src/types.rs:86-94`):
`current` = "Use the directory where Codex was launched", `session` = "Use the
latest working directory recorded in the selected session". Docs: "Working
directory to use when resuming or forking a session. When unset, Codex asks you
to choose if your current directory differs from the session's saved
directory." (<https://learn.chatgpt.com/docs/config-file/config-reference>).
Implementation `resolve_cwd_for_resume_or_fork`
(`codex-rs/tui/src/session_resume.rs:109-167`): `current` short-circuits;
`session` uses the recorded cwd; unset prompts only when `cwds_differ`, and the
prompt can persist the choice (`cwd_prompt.rs:84-90, 159-172`). `--cd <DIR>`
forces `current` (`effective_resume_cwd_mode`, `session_resume.rs:66-74`).
The `-C/--cd` flag is available on `codex resume` (`codex resume --help`).

## 7. archive, unarchive, delete

All three CLI commands are "thin app-server clients: resolve a user-provided
UUID or exact session name, then call the corresponding app-server RPC"
(`codex-rs/tui/src/session_archive_commands.rs:1-5`). Name resolution searches
`active` for archive, `archived` for unarchive, and `active` then `archived`
for delete (lines 164-181), with the same exact-match candidate iterator as
resume (lines 187-275). Success message: "Archived|Deleted|Unarchived session
<name> (<uuid>)." (lines 65-80).

### 7.1 archive

`codex-rs/thread-store/src/local/archive_thread.rs:63-140`: the rollout (and
any owned descendant rollouts, lines 15-60) is renamed from
`sessions/YYYY/MM/DD/<file>` to **`<codex_home>/archived_sessions/<file>`**
(flat; `archive_folder.join(&file_name)`, lines 76-99, `std::fs::rename`
line 115), then `mark_archived(thread_id, archived_path, now)` sets
`archived = 1`, `archived_at`, and the new `rollout_path` (line 131). TUI
`/archive` = "archive this session and exit". Docs: archive "hides it from
active session lists while preserving the transcript".

### 7.2 unarchive

`codex-rs/thread-store/src/local/unarchive_thread.rs:40-125`: reverse move to
`sessions/<year>/<month>/<day>/` derived from the filename timestamp
(`rollout_date_parts`, lines 56-70), mtime touched so it sorts as recent
(`touch_modified_time`, line 103), then `mark_unarchived`. The picker's
Archived tab can unarchive in place and resume (`resume_picker.rs:727-753`).

### 7.3 delete

`codex-rs/thread-store/src/local/delete_thread.rs`: "Existing rollout files are
deleted before this operation reports success … The app-server deletes main
state DB rows after every associated rollout is removed; this module deletes
local history projection rows." (lines 1-5). It removes files from both
`sessions/` and `archived_sessions/` (lines 238-260), deletes the thread's
projection (`thread_history::delete_thread`, line 206), removes its
`session_index.jsonl` entries (`remove_thread_name_entries`, line 217), and
refuses when a fork still references the rollout (lines 117-163). CLI:
`--force` "Delete without prompting. SESSION must be a UUID"; a name always
prompts "Permanently delete session '<name>' (<uuid>)? … This cannot be undone.
Subagent threads will also be deleted. Continue? [y/N]:" and fails without a
TTY (`session_archive_commands.rs:286-312`, `main.rs:963-972`).

## 8. OMX (oh-my-codex 0.21.0)

### 8.1 `omx resume` pass-through

- Help: `Usage: omx resume [--project] [--codex-home <path>] [codex resume
  options]` (`dist/cli/index.js:279-281`; printed only for `--help`, "Read-only
  help does not prepare or launch a Codex session").
- Dispatch: `resume` → `launchWithHud(["resume", ...launchArgs])`
  (`dist/cli/index.js:526-528, 2576-2578`).
- `launchWithHud` (`index.js:3003-3160`): `splitOmxArgsAtEndOfOptions` →
  `parseWorktreeMode` (`-w/--worktree`) → `resolveNotifyTempContract`
  (`--notify-temp`, `--discord` …) → launch policy from `--direct`/`--tmux`/
  `OMX_LAUNCH_POLICY` (`splitLeaderLaunchPolicyArgs` consumes `--direct` and
  `--tmux`, `index.js:564-590`; `resolveEffectiveLeaderLaunchPolicyOverride`
  611-627 parses `OMX_LAUNCH_POLICY`; `resolveTmuxAwareLaunchPolicy` 1456) →
  `normalizeCodexLaunchArgs` (consumes `--madmax`, `--high`,
  `--xhigh`, `--spark`, `--madmax-spark`; appends
  `--dangerously-bypass-approvals-and-sandbox` or `-c
  model_reasoning_effort="high|xhigh"` only when those were given; everything
  else, including the `resume` positional and the name, is pushed through
  unchanged, `index.js:3291-3340`) → `prepareResumeCodexHomeForLaunch`
  (`isResumeCodexLaunch` finds the first non-option token and checks it is
  `resume`, `index.js:954-978`; `parseResumeCodexHomeSelection` strips
  `--project` and `--codex-home[=]<path>`, `index.js:878-916`) →
  `runCodex(cwd, normalizedArgs, …)` (`index.js:3155`).
- `runCodex` (`index.js:4806-4812`): `launchArgs =
  injectModelInstructionsBypassArgs(cwd, args, env,
  sessionModelInstructionsPath(cwd, sessionId))`, which appends `-c
  model_instructions_file="<path>"` unless `OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0`
  or the caller already set that key (`index.js:3488-3500, 3374-3382`;
  `CONFIG_FLAG = '-c'` in `dist/cli/constants.js:8`; key
  `model_instructions_file` `index.js:237`). Env gets `CODEX_HOME` /
  `CODEX_SQLITE_HOME` **only when an override is resolved** (`index.js:4878-4886`),
  plus `OMX_ROOT`, `OMX_CODEX_LAUNCH_ID`, HUD vars and a PATH shim.
- `--direct` branch: `runCodexBlocking(cwd, launchArgs, codexEnvWithNotify)` =
  `spawnPlatformCommandSync("codex", launchArgs, { cwd, stdio: "inherit", env })`
  (`index.js:5023-5028, 1533-1540`) — the `codex` found on `PATH`, foreground,
  no tmux wrapper.

So `omx --direct resume <name>` runs `codex resume <name> -c
model_instructions_file="…"`; the name reaches Codex unchanged and Codex's own
name resolution (§6) applies. `omx resume --project` instead launches Codex with
`CODEX_HOME` pointed at a per-launch mirror under
`<omxRoot>/runtime/codex-home/<sessionId>` (`runtimeCodexHomePath`,
`index.js:633-635`; `prepareResumeCodexHomeForLaunch` 980-1030), which is a
different sessions tree — avoid it for console launches.

### 8.2 Which `CODEX_HOME` OMX uses

`dist/cli/codex-home.js:6-22`: `resolveCodexHomeForLaunch` returns
`env.CODEX_HOME` when set, else `<projectRoot>/.codex` **only if** a
project-scoped `omx setup` was persisted for that tree, else `undefined` (Codex
default `~/.codex`). This host uses the default: the newest rollout under
`~/.codex/sessions/` was launched through OMX (its `base_instructions` contain
the `<!-- OMX:RUNTIME:START --> … **Session:** omx-1788382397164-z7eppk`
overlay) and records `cwd: /tachi/code/remoteagents`.

### 8.3 OMX keeps no thread names or index

- `omx session` (`dist/cli/session-search.js`) offers `search`, `friction`,
  `lock inspect|recover`, `pointer recover`; `search` and `friction` walk
  `<codexHome>/sessions` for files that `startsWith('rollout-') &&
  endsWith('.jsonl')` (`dist/session-history/search.js:106-111, 323`;
  `friction.js:159, 334`) and read only `session_meta` `id`/`cwd`/`timestamp`
  (`search.js:149-162`); they also include OMX project runtime homes
  (`discoverProjectRuntimeCodexHomes`, `search.js:47`). No name field is read
  and no OMX-side index is written.
- `.omx/state/session.json` (path: `<cwd or OMX_ROOT>/.omx/state/session.json`,
  `dist/mcp/state-paths.js:286-303`, `dist/hooks/session.js:26,54-65`,
  `dist/scripts/notify-hook.js:109`) is the "selected session pointer", written
  by `establishLaunchSessionBinding` during `preLaunch` (`index.js:4676, 4785`).
  Record shape (`createSessionState`, `dist/hooks/session.js:793-840`):
  `session_id` (OMX id `omx-<ms>-<rand>`, `index.js:3068`), optional
  `native_session_id` / `previous_native_session_id` /
  `native_session_switched_at` (the Codex thread id, taken from the native
  hook payload `session_id`, `dist/scripts/codex-native-hook.js:2037-2059`),
  `owner_omx_session_id`, `started_at`, `launch_lineage_token`, `cwd`,
  `state_root`, `pid`, `platform`, `process_identity` / `pid_start_ticks` /
  `pid_cmdline`, `tmux_session_name`, `tmux_pane_id`. It is used for liveness
  and pointer recovery (`isSessionStale`, `session.js:471-497`), not naming.
  (The stale-dead pointer failure mode is covered in the OMX memory note; not
  re-verified here.)

## Unverified

- Codex docs beyond the two pages above (e.g. a sessions/storage page) were not
  located; the developer-commands page is the only doc quote for `/rename`,
  `codex resume --all`, and "Interactive sessions are stored in
  `~/.codex/sessions/`".
- Whether the `RecencyAt` sort (`recency_at_ms`, "product recency timestamp")
  ever differs from `updated_at_ms` for TUI threads was not traced; on this
  host the picker default is `UpdatedAt` anyway.
- `path_utils::paths_match_after_normalization` / `normalize_for_path_comparison`
  (used for the cwd filter) were not read; the crate is
  `codex-rs/utils/absolute-path` or a sibling. Treat the cwd match as
  "normalised string equality", exact rules unverified.
- The 36-char provisional name and generated title were observed on the host
  and read in source; whether title generation is skipped for non-OpenAI
  providers without a ChatGPT account (it falls back to the current model) was
  not exercised.
- OMX's `prepareCodexHomeForLaunch` history-artifact copying for `--project`
  launches (`index.js:701-810`) was not read in detail; only its trigger
  conditions are cited.
- No interactive TUI was started in this sandbox (unix sockets/ptys are
  blocked), so `/rename` and the picker were verified from source and host
  artifacts, not by running them.
