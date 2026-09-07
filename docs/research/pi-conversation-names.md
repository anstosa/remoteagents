# How Pi names and lists conversations (pi-coding-agent 0.83.0)

Whether Pi's session store fits the console contract of "list the Named conversations under these
directories" plus "rename through the CLI's own command": where `--name` and `/name` put the name,
the `~/.pi/agent/sessions/` layout, how to enumerate sessions with name and last-active time, how
`--session <path|id>` resolves, whether a session resumes from a different cwd, and whether a name
can be cleared. Gathered 2026-09-06 for the "Replace bookmarks with named session selector" effort
(branch `named-sessions`, tip `2910f0d`). Contract fit only; the Pi Adapter is a separate effort.

**Sources.** The installed package is `@earendil-works/pi-coding-agent` 0.83.0 (`pi --version` prints
`0.83.0`). The bin `/home/tgrosinger/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/0.83.0/node_modules/.bin/pi`
is a shim whose target resolves (`readlink -f` on `node_modules/@earendil-works/pi-coding-agent`) to
`/home/tgrosinger/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/0.83.0/node_modules/.mise/@earendil-works+pi-coding-agent@0.83.0/node_modules/@earendil-works/pi-coding-agent/`,
cited below as `dist:<path>` (line numbers are of the shipped compiled JS) and `docs:<file>` (the
`docs/` directory shipped in the same package). `help:` is the output of `pi --help` (it also prints an
EROFS lock-file warning in this sandbox, ignored). `src:` is the upstream repository named in
`package.json` `repository.url` (`git+https://github.com/earendil-works/pi.git`, directory
`packages/coding-agent`), fetched raw from
`https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/...` on 2026-09-06; the
shipped `docs:session-format.md` L31-32 links the same file under the older name `pi-mono`. `site:` is
`https://pi.dev` and `https://pi.dev/docs/latest/sessions`. `probe:` is a run of the installed
package's own `SessionManager` under a throwaway `PI_CODING_AGENT_DIR` in `$TMPDIR` (script in the
appendix; no network, no user state touched). `host:` is read-only inspection of this machine. No
network host was denied.

## TL;DR

- **The name is a `session_info` line, not a header field.** Every naming path (`--name`/`-n`, `/name`,
  RPC `set_session_name`, extension `pi.setSessionName()`, and the `/resume` picker's Ctrl+R rename)
  ends in `SessionManager.appendSessionInfo(name)`, which appends
  `{"type":"session_info","id":…,"parentId":<leaf>,"timestamp":…,"name":"…"}` as a tree entry. The
  effective name is the *latest* such entry, CR/LF collapsed to spaces and trimmed.
- **Layout is deterministic from the cwd.** `<agentDir>/sessions/--<cwd with the leading "/" dropped
  and every "/", "\", ":" replaced by "-">--/<ISO timestamp with ":" and "." replaced by "-">_<uuidv7>.jsonl`,
  where `agentDir` is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. There is no index file; listing is a
  `readdir` for `*.jsonl` plus a full parse of each file.
- **Listing recipe:** `SessionManager.list(cwd)` (exported from the package's main entry) returns
  `{path, id, cwd, name?, parentSessionPath?, created, modified, messageCount, firstMessage,
  allMessagesText}` sorted by `modified` descending, where `modified` is the latest user/assistant
  message timestamp (fallbacks: header timestamp, then file mtime). **File mtime is not faithful to
  last activity**: a rename, label, model change, or version migration bumps it while `modified`
  stays put. `--continue` picks by mtime; the picker orders by `modified`; the probe showed them
  choose different sessions after a rename. "Named" in the picker means `name?.trim()` is non-empty.
- **Files are written lazily.** Nothing reaches disk until the first assistant message; a session
  started with `--name` and never answered is invisible to any directory scan.
- **`--session <arg>`:** if the argument contains `/` or `\` or ends in `.jsonl` it is a path and is
  opened directly; otherwise it is matched as an exact id, then an id prefix, first in the cwd's
  directory and then across every directory. A cross-project id hit prints "Session found in
  different project" and asks on stdin "Fork this session into current directory?". An opened file
  resumes in its *header* cwd (the runtime is built with `sessionManager.getCwd()`; nothing calls
  `process.chdir`). A stored cwd that no longer exists prompts in interactive mode and exits 1 otherwise.
- **Clearing:** the format supports it (`"name":""` makes the session unnamed) but no user-facing path
  accepts an empty name: `--name ""` errors, `/name` with no argument prints the current name, RPC
  rejects empty, the picker ignores empty. Only `pi.setSessionName("")` from an extension, or direct
  SDK use, clears.
- **Fit:** "list the Named conversations under these directories" fits well. "Rename through the CLI's
  own command" is `/name <name>` for the *current* session only; there is no headless
  `pi rename` command, so a console-side rename of an arbitrary session means appending a
  `session_info` line itself (exactly what the picker does) or using RPC on a live session.
- **Host:** `~/.pi/agent/sessions` does not exist on this machine, so no real session files could be
  read; the concrete examples below come from the probe.

## 1. Flags and commands (what the CLI exposes)

`help:` lists `--continue, -c` ("Continue previous session"), `--resume, -r` ("Select a session to
resume"), `--session <path|id>` ("Use specific session file or partial UUID"), `--session-id <id>`
("Use exact project session ID, creating it if missing"), `--fork <path|id>`, `--session-dir <dir>`
("Directory for session storage and lookup"), `--no-session`, and `--name, -n <name>` ("Set session
display name"), with the example `pi --name "Refactor auth module"`. Environment variables:
`PI_CODING_AGENT_DIR` ("Config directory (default: ~/.pi/agent)") and `PI_CODING_AGENT_SESSION_DIR`
("Session storage directory (overridden by --session-dir)").

`docs:sessions.md` L22-35 lists the in-session commands: `/resume`, `/new`, `/name <name>` ("Set the
current session display name"), `/session`, `/tree`, `/fork`, `/clone`. L37-50: `/resume` and `pi -r`
open the same picker, which can "filter to named sessions with Ctrl+N", "rename with Ctrl+R", "delete
with Ctrl+D, then confirm". L52-67 "Naming Sessions": `/name Refactor auth module`, `pi --name
"Refactor auth module"`, `pi --name "CI audit" -p "Review this build failure"`. `site:` at
`/docs/latest/sessions` carries the same text (fetched 2026-09-06). The builtin slash-command table
registers `{ name: "name", description: "Set session display name" }` (`dist:core/slash-commands.js`
L10).

## 2. Where the name lives

### The record

`docs:session-format.md` L296-304 ("SessionInfoEntry"): "Session metadata (e.g., user-defined display
name). Set via `/name`, `--name` / `-n`, or `pi.setSessionName()` in extensions", example
`{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"…","name":"Refactor auth module"}`,
and "The session name is displayed in the session selector (`/resume`) instead of the first message
when set." The type is `interface SessionInfoEntry extends SessionEntryBase { type: "session_info";
name?: string; }` (`dist:core/session-manager.d.ts` L81-84; identical in `src:`).

The writer (`dist:core/session-manager.js` L832-844; identical in `src:`):

```js
appendSessionInfo(name) {
    const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
    const entry = { type: "session_info", id: generateId(this.byId), parentId: this.leafId,
                    timestamp: new Date().toISOString(), name: sanitizedName };
    this._appendEntry(entry);
    return entry.id;
}
```

`_appendEntry` (L754-759) pushes the entry, indexes it, **advances the leaf to it**, and persists it.
So a name is an ordinary tree entry hanging off whatever the current leaf was, not a mutable header
field; renaming twice yields two entries. The header written by `newSession` carries only
`type, version, id, timestamp, cwd, parentSession` (L651-658), and `docs:session-format.md` L189-201
shows the same.

The reader, `getSessionName` (L845-857): walks entries in reverse and returns the first
`session_info`'s `name?.trim() || undefined`; the comment reads "Empty names explicitly clear the
session title."

### Every naming path converges on `appendSessionInfo`

- `--name` / `-n`: after the session manager is created, `main.js` trims the value, exits 1 with
  "Error: --name requires a non-empty value" if empty, else `sessionManager.appendSessionInfo(name)`
  (`dist:main.js` L512-519).
- `/name <name>` in interactive mode: dispatched at `dist:modes/interactive/interactive-mode.js` L2145
  (`text === "/name" || text.startsWith("/name ")`); `handleNameCommand` (L4696-4718) strips the
  command, and with a non-empty remainder calls `this.session.setSessionName(name)`, then warns if the
  stored value was normalised. With an empty remainder it prints "Session name: <current>" or the
  usage warning "Usage: /name <name>" (L4698-4709) and does **not** write.
- `AgentSession.setSessionName(name)` (`dist:core/agent-session.js` L2284-2289) calls
  `sessionManager.appendSessionInfo(name)` and emits `session_info_changed` with the re-read name.
  `docs:extensions.md` L406 documents that event as "Fired when the current session display name is
  set via `/name`, RPC, or `pi.setSessionName()`".
- Extensions: `pi.setSessionName(name)` (`dist:core/extensions/loader.js` L251-254) forwards to the
  runtime without validating; documented at `docs:extensions.md` L1457-1470 alongside
  `pi.getSessionName()`.
- RPC: `set_session_name` trims and returns the error "Session name cannot be empty" for an empty
  value, else `session.setSessionName(name)` (`dist:modes/rpc/rpc-mode.js` L521-528; `docs:rpc.md`
  L772-789, which also says the current name is readable via `get_state`'s `sessionName`).
- Picker rename (Ctrl+R): the `/resume` selector is constructed with
  `renameSession: async (sessionFilePath, nextName) => { const next = (nextName ?? "").trim(); if (!next) return; const mgr = SessionManager.open(sessionFilePath); mgr.appendSessionInfo(next); }`
  (`interactive-mode.js` L3976-3982). It opens the *selected* file, so it renames sessions other than
  the current one. The startup `pi -r` picker passes no `renameSession` and `showRenameHint: false`
  (`dist:cli/session-picker.js` L30), and the component only enables rename when a callback exists
  (`dist:modes/interactive/components/session-selector.js` L642-645, L669-671), so `pi -r` cannot
  rename.

### When the line reaches disk

`_persist` (`dist:core/session-manager.js` L724-753): if the session has no assistant message yet and
the file has never been flushed, the entry is buffered (`this.flushed = false`); the whole file is
written with the `wx` flag once the first assistant message is appended, after which every later entry
is `appendFileSync`'d. `newSession` computes the eventual file path up front (L665-668). `probe:`
confirmed the consequence: after `appendSessionInfo("Alpha named")` and a user message the file did
not exist; it appeared only after the assistant message
("s1 on disk after name only? false / after user msg? false / after assistant msg? true").

## 3. Directory layout and file names

`dist:core/session-manager.js` L240-254 (identical in `src:`):

```js
function getDefaultSessionDirPath(cwd, agentDir = getDefaultAgentDir()) {
    const resolvedCwd = resolvePath(cwd);
    const resolvedAgentDir = resolvePath(agentDir);
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(resolvedAgentDir, "sessions", safePath);
}
export function getDefaultSessionDir(cwd, agentDir = getDefaultAgentDir()) {
    const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
    if (!existsSync(sessionDir)) { mkdirSync(sessionDir, { recursive: true }); }
    return sessionDir;
}
```

`getAgentDir()` is `$PI_CODING_AGENT_DIR` if set, else `~/.pi/agent` (`dist:config.js` L412-418);
`getSessionsDir()` is `<agentDir>/sessions` (L448-450). `docs:session-format.md` L7-11 states the same
shape: `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`, "Where `<path>` is the working
directory with `/` replaced by `-`" (the code also replaces `\` and `:`). The file name is
`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl` (L666-667), and ids are `uuidv7()` (L12-14),
so the lexical order of file names is creation order.

`probe:` for cwd `/tmp/claude-1000/pi-probe-cwd-a.CzpJ` the directory was
`<agentDir>/sessions/--tmp-claude-1000-pi-probe-cwd-a.CzpJ--/` and the first file
`2026-09-06T18-59-10-250Z_01a07816-b92a-7172-8183-f98b81f2435c.jsonl`. Derivation, not observed: a
console worktree such as `/tachi/code/remoteagents.worktrees/named-sessions` maps to
`~/.pi/agent/sessions/--tachi-code-remoteagents.worktrees-named-sessions--/`; each worktree gets its
own directory because the cwd differs.

Because `getDefaultSessionDir` creates the directory, **listing has a side effect**: `probe:`
`SessionManager.list(cwdB)` on a cwd with no sessions returned 0 and left an empty
`--…pi-probe-cwd-b…--` directory behind.

Session-directory overrides: `main.js` L493-496 picks `--session-dir`, then
`PI_CODING_AGENT_SESSION_DIR` (tilde-expanded), then `sessionDir` from settings;
`docs:settings.md` L204-210 documents the same precedence and that the value may be relative or `~`.
When a custom directory is in use (and differs from the cwd's default one), `list` and
`continueRecent` filter files by the header `cwd` instead of trusting the directory (L1283-1285,
L1216-1217, `sessionCwdMatches` L391-393).

No index: `listSessionsFromDir` (L548-572) is `readdir` filtered to `.jsonl`, each file parsed by
`buildSessionInfo`; `listAll` (L1289-1336) walks every subdirectory of `<agentDir>/sessions`. A grep of
`dist/` for an index/manifest found nothing, `docs:session-format.md` documents none, and the upstream
`docs/sessions.md` on `main` (`src:`, fetched 2026-09-06) mentions none. Header discovery reads the
first parsed line, bounded at 1 MiB (L255-264, L325-332).

## 4. Listing recipe: name and last-active per session

`SessionInfo` (`dist:core/session-manager.d.ts` L125-139): `path, id, cwd` ("Empty string for old
sessions"), `name?` ("User-defined display name from session_info entries"), `parentSessionPath?`,
`created`, `modified`, `messageCount`, `firstMessage`, `allMessagesText`. `SessionManager` and this
listing API are re-exported from the package's main entry (`dist:index.js` L23), and `docs:sdk.md` L19
imports it as `import { … SessionManager } from "@earendil-works/pi-coding-agent"`.

`buildSessionInfo` (`dist:core/session-manager.js` L440-513; the quoted lines are identical in `src:`):

- name: on every `session_info` entry, `name = entry.name?.trim() || undefined` (L463-466, comment
  "use latest, including explicit clears").
- last activity: only `message` entries with role `user` or `assistant` count; the time is
  `message.timestamp` (Unix ms) or, failing that, the entry's ISO `timestamp` (L426-439, L467-473).
- `modified` (L491-496):
  `typeof lastActivityTime === "number" && lastActivityTime > 0 ? new Date(lastActivityTime) : !Number.isNaN(headerTime) ? new Date(headerTime) : stats.mtime`.
- `created` is the header timestamp (L503).

`SessionManager.list(cwd)` sorts by `modified` descending (L1281-1288); `listAll()` the same
(L1294, L1330). Up to 10 files are parsed concurrently (L514-547).

**Is file mtime faithful?** No. `modified` ignores `session_info`, `label`, `model_change`,
`thinking_level_change`, `compaction`, and `custom` entries, while every append changes mtime, and
opening a legacy-version file rewrites it in place (`migrateToCurrentVersion` → `_rewriteFile`,
L633-635, L693-705). `findMostRecentSession`, which backs `--continue`, sorts by `statSync(path).mtime`
(L395-412, sort at L405-406). `probe:` after renaming the oldest session (`Alpha named` →
`Alpha renamed`, appended 3 s after its last message) `list()` reported it with
`modified 18:59:10.251Z` but `mtime 18:59:13.552Z` and placed it **last**, while
`continueRecent(cwdA)` picked that same file **first**. A console that wants "last active" should use
the message-derived `modified` (or its own parse of the last user/assistant message), not mtime.

"Named" filter: `hasSessionName(session) = Boolean(session.name?.trim())`
(`dist:modes/interactive/components/session-selector-search.js` L8-10); the picker applies it under
Ctrl+N (`session-selector.js` L300, `docs:sessions.md` L46). Sort modes are `threaded`, `recent`,
`relevance`; `recent` keeps the incoming `modified` order (`session-selector-search.js` L122-139).

Minimal external recipe (derived from the above): for each `<dir>/*.jsonl`, parse line 1 as the header
(`type === "session"`, take `id`, `cwd`, `timestamp`); scan the rest, keeping the last
`session_info.name` (trimmed; empty means unnamed) and the max `message.message.timestamp` over
user/assistant messages; treat "Named" as a non-empty name; sort by that max time, falling back to the
header timestamp.

## 5. How `--session <path|id>` resolves; resuming from another cwd

`resolveSessionPath` (`dist:main.js` L157-176):

1. If the argument contains `/` or `\` or ends with `.jsonl`, it is a path, resolved against the
   startup cwd, and returned as `type: "path"`.
2. Otherwise `SessionManager.list(cwd, sessionDir)` is searched for an exact `id`, then for
   `id.startsWith(arg)` (`type: "local"`).
3. Otherwise `SessionManager.listAll(sessionDir)` is searched the same way (`type: "global"`, with the
   header cwd).
4. Otherwise `not_found`.

`createSessionManager` (L268-287): `path` and `local` → `SessionManager.open(path, sessionDir)`;
`global` → prints "Session found in different project: <cwd>", asks via readline "Fork this session
into current directory?", exits 0 on "no", otherwise `forkFrom` into the current cwd's directory (new
file, new id, header `parentSession` pointing at the source; L1234-1274); `not_found` → "No session
found matching '<arg>'", exit 1. In a console pane this stdin prompt would block the launch, so a
console should pass a **path**, never a bare id, when the target may live under another cwd.

`--session-id <id>` is different: exact match in the current project's list → open, otherwise a new
session is created with that id after a warning (L304-311); ids must match
`/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/` (L15-19); it cannot be combined with `--session`,
`--continue`, or `--resume` (L205-218). `--continue` is `SessionManager.continueRecent(cwd, sessionDir)`
(L301-303; newest by mtime, section 4). `--resume` is the picker over `list(cwd)` and `listAll`
(L288-300). `--fork <path|id>` uses the same resolver and always forks (L249-267).

**Does a session resume from a different cwd?** Yes, in its stored cwd. `SessionManager.open(path)`
takes `cwd` from the file's header (falling back to `process.cwd()` only when there is no header) and,
absent an explicit session dir, uses the file's parent directory for `/new` and branches (L1186-1207).
`main.js` builds the runtime with `cwd: sessionManager.getCwd()` (L636-640), and the resume/fork paths
do the same (`dist:core/agent-session-runtime.js` L134-143, L225-230, L276-284); `grep chdir
dist/main.js` finds nothing, so the process cwd is never changed, but tools, settings, and trust are
resolved against the session's cwd (L488-496 comment, L522-525). If that cwd no longer exists,
`getMissingSessionCwdIssue` fires: interactive mode prompts "cwd from session file does not exist …
continue in current cwd" and reopens with a cwd override, other modes print the error and exit 1
(`dist:core/session-cwd.js` L2-37; `main.js` L498-511). `probe:` `SessionManager.open(<file of cwd A>)`
run with `process.cwd()` = cwd B reported `opened cwd from header: <cwd A>` and `sessionDir` =
cwd A's directory.

## 6. Can a name be cleared?

Storage: yes. `appendSessionInfo("")` writes `{"type":"session_info",…,"name":""}`; `getSessionName`
and `buildSessionInfo` both map an empty/whitespace name to `undefined` (L846-857, L463-466), and the
picker then treats the session as unnamed (`hasSessionName`). `probe:` s3 was named "Gamma named",
then `appendSessionInfo("")`; the file ended with two `session_info` lines, the last `"name":""`, and
`list()` returned the entry with no `name` field.

User-facing paths: none clears. `--name ""` exits 1 (`main.js` L512-517); `/name` with no argument
only displays (L4698-4709); RPC `set_session_name` rejects empty (`rpc-mode.js` L522-525); the picker's
rename callback returns without writing on empty (`interactive-mode.js` L3977-3979). The only
in-product route is `pi.setSessionName("")` from an extension (`loader.js` L251-254 forwards
unvalidated), or the SDK. Neither the shipped `docs:sessions.md` nor the upstream `main` copy
(`src:` `docs/sessions.md`, fetched 2026-09-06) mentions clearing.

## 7. Contract fit

**"List the Named conversations under these directories": fits.** The directory for a cwd is a pure
function of the cwd and `agentDir` (section 3), so the console can compute `--<encoded>--` for each
worktree it manages (or call the package's exported `SessionManager.list(cwd)` if it is willing to
depend on `@earendil-works/pi-coding-agent` and accept the mkdir side effect). Each file is
self-describing: header `id`/`cwd`, latest `session_info.name` as the display name, and a
message-derived last-active time; "Named" is simply "latest name non-empty". Two caveats: a named
session that has not yet received an assistant reply has no file (section 2), and mtime must not be
used as "last active" (section 4). `~/.pi/agent/sessions` does not exist on this host (section 8), so
the console's listing must tolerate a missing `sessions/` directory.

**"Rename through the CLI's own command": partial.** Pi's command is `/name <name>`, an interactive
slash command that renames only the *current* session of a live process; there is no `pi rename` or
other headless CLI verb, and the startup `pi -r` picker cannot rename. Renaming an arbitrary (possibly
idle) session from outside means doing what Pi's own `/resume` picker does, open the file and append a
`session_info` line, or, for a live pane, driving `/name` through the terminal or `set_session_name`
over RPC. Names cannot be cleared from the CLI at all. Initial naming at launch is clean:
`pi --name "<name>"` (also valid with `-p` and `--mode rpc`, `docs:rpc.md` L789).

## 8. Host observations (read-only)

- `readlink -f ~/.pi` → `/tachi/code/dotfiles/home/.pi`; `~/.pi/agent` contains `approval-gate.json`,
  `auth.json`, `extensions/` (`approval-gate.ts`, `atuin.ts`), `settings.json`, `themes/`.
- `~/.pi/agent/settings.json` has no `sessionDir` key (contents: `lastChangelogVersion`, `theme`,
  `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `skills`, `hideThinkingBlock`,
  `enableInstallTelemetry`).
- `ls ~/.pi/agent/sessions` → "No such file or directory"; `find -L /tachi/code/dotfiles/home/.pi
  -maxdepth 3 -type d -name sessions` → nothing. No `PI_*` variable is set in this shell (`env | grep
  ^PI_`). So no real session file could be read here; whether sessions were never persisted or were
  removed is unverified.
- The repository's `docs/adr/0004-…` L8 notes the console keeps `~/.pi/agent` on the host (unsandboxed),
  so console-launched Pi sessions would land under `~/.pi/agent/sessions/` per worktree cwd once one is
  written (derivation from section 3, not observed).

## Unverified

- Behaviour of versions other than 0.83.0. Upstream `main` matched the dist for every quoted function
  (`getDefaultSessionDirPath`, `appendSessionInfo`, `getSessionName`, the `buildSessionInfo` name and
  `modified` lines, the `findMostRecentSession` sort, `SessionInfoEntry`) on 2026-09-06, but `main`
  may have moved elsewhere.
- Real on-host layout (no sessions exist on this machine); the layout above is from source plus the
  probe.
- The interactive prompts (fork-on-global-hit, missing-cwd) were read in source, not exercised; Pi was
  not started interactively.

## Appendix: probe script

Run as
`PKG=<resolved package dir> CWD_A=<mktemp -d> CWD_B=<mktemp -d> PI_CODING_AGENT_DIR=<mktemp -d> NODE_PATH="$PKG/..:$PKG/../../.mise/node_modules" node pi-probe.mjs`
from `CWD_B`, on 2026-09-06 18:59Z with the installed 0.83.0 package.

```js
import { statSync, readFileSync, readdirSync } from "node:fs";
const { SessionManager } = await import(process.env.PKG + "/dist/core/session-manager.js");
const cwdA = process.env.CWD_A, cwdB = process.env.CWD_B;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const exists = (p) => { try { statSync(p); return true; } catch { return false; } };
const user = (t) => ({ role: "user", content: t, timestamp: Date.now() });
const asst = (t) => ({ role: "assistant", content: [{ type: "text", text: t }], api: "x", provider: "x", model: "x",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: Date.now() });
const s1 = SessionManager.create(cwdA);
s1.appendSessionInfo("Alpha named");
console.log("s1 dir:", s1.getSessionDir()); console.log("s1 file:", s1.getSessionFile());
console.log("s1 on disk after name only?", exists(s1.getSessionFile()));
s1.appendMessage(user("hello")); console.log("s1 on disk after user msg?", exists(s1.getSessionFile()));
s1.appendMessage(asst("hi"));    console.log("s1 on disk after assistant msg?", exists(s1.getSessionFile()));
await sleep(1100);
const s2 = SessionManager.create(cwdA); s2.appendMessage(user("second")); s2.appendMessage(asst("ok"));
await sleep(1100);
const s3 = SessionManager.create(cwdA); s3.appendMessage(user("third")); s3.appendMessage(asst("ok"));
s3.appendSessionInfo("Gamma named"); console.log("s3 name after set:", s3.getSessionName());
s3.appendSessionInfo("");            console.log("s3 name after clear:", s3.getSessionName());
await sleep(1100);
SessionManager.open(s1.getSessionFile()).appendSessionInfo("Alpha renamed");
for (const f of readdirSync(s1.getSessionDir()).sort()) console.log(f);
console.log(readFileSync(s1.getSessionFile(), "utf8"));
console.log(readFileSync(s3.getSessionFile(), "utf8"));
for (const s of await SessionManager.list(cwdA)) console.log(JSON.stringify({ id: s.id, name: s.name, cwd: s.cwd,
  created: s.created, modified: s.modified, mtime: statSync(s.path).mtime, messageCount: s.messageCount, path: s.path }));
for (const s of await SessionManager.listAll()) console.log(s.id, "|", s.name ?? "(no name)", "|", s.cwd);
const o = SessionManager.open(s1.getSessionFile());
console.log("opened cwd from header:", o.getCwd(), "| sessionDir:", o.getSessionDir());
console.log("continueRecent(cwdA) picks:", SessionManager.continueRecent(cwdA).getSessionFile());
console.log("list(cwdB):", (await SessionManager.list(cwdB)).length, "sessions");
```

Observed output (abridged; timestamps are those of the run):

```text
s1 dir: <agentDir>/sessions/--tmp-claude-1000-pi-probe-cwd-a.CzpJ--
s1 file: <agentDir>/sessions/--tmp-claude-1000-pi-probe-cwd-a.CzpJ--/2026-09-06T18-59-10-250Z_01a07816-b92a-7172-8183-f98b81f2435c.jsonl
s1 on disk after name only? false
s1 on disk after user msg? false
s1 on disk after assistant msg? true
s3 name after set: Gamma named
s3 name after clear: undefined
--- s1 file
{"type":"session","version":3,"id":"01a07816-b92a-7172-8183-f98b81f2435c","timestamp":"2026-09-06T18:59:10.250Z","cwd":"/tmp/claude-1000/pi-probe-cwd-a.CzpJ"}
{"type":"session_info","id":"e5eeef0e","parentId":null,"timestamp":"2026-09-06T18:59:10.250Z","name":"Alpha named"}
{"type":"message","id":"60dc1862","parentId":"e5eeef0e","timestamp":"2026-09-06T18:59:10.251Z","message":{"role":"user","content":"hello","timestamp":1788721150251}}
{"type":"message","id":"20320a16","parentId":"60dc1862","timestamp":"2026-09-06T18:59:10.251Z","message":{"role":"assistant",…,"stopReason":"stop","timestamp":1788721150251}}
{"type":"session_info","id":"9bcef9fd","parentId":"20320a16","timestamp":"2026-09-06T18:59:13.557Z","name":"Alpha renamed"}
--- s3 file (tail)
{"type":"session_info","id":"a38cb038","parentId":"e17c7132","timestamp":"2026-09-06T18:59:12.455Z","name":"Gamma named"}
{"type":"session_info","id":"74180d2c","parentId":"a38cb038","timestamp":"2026-09-06T18:59:12.455Z","name":""}
--- SessionManager.list(cwdA)  (sorted by modified desc; s1 last despite newest mtime)
{"id":"01a07816-c1c7-…","cwd":"…cwd-a.CzpJ","created":"…18:59:12.455Z","modified":"…18:59:12.455Z","mtime":"…18:59:12.452Z","messageCount":2}
{"id":"01a07816-bd79-…","cwd":"…cwd-a.CzpJ","created":"…18:59:11.353Z","modified":"…18:59:11.353Z","mtime":"…18:59:11.352Z","messageCount":2}
{"id":"01a07816-b92a-…","name":"Alpha renamed","cwd":"…cwd-a.CzpJ","created":"…18:59:10.250Z","modified":"…18:59:10.251Z","mtime":"…18:59:13.552Z","messageCount":2}
opened cwd from header: /tmp/claude-1000/pi-probe-cwd-a.CzpJ | sessionDir: <agentDir>/sessions/--tmp-claude-1000-pi-probe-cwd-a.CzpJ--
continueRecent(cwdA) picks: …/2026-09-06T18-59-10-250Z_01a07816-b92a-7172-8183-f98b81f2435c.jsonl   (the renamed s1, by mtime)
list(cwdB): 0 sessions   (and an empty --…cwd-b…-- directory was created)
```
