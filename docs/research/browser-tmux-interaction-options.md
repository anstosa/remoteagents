# Interacting with tmux from a browser: what RAC does today, what exists, and the options

Research for the question "how could the console show more of a tmux server than one pane at a time —
several panes, window switching, the real tmux UI — and what would it cost?" Three parts: an exact
account of how the console drives xterm.js and tmux today (with `path:line` citations), a survey of
JS/TS tmux clients and browser-terminal projects (what each *actually* does), and candidate
architectures for RAC with trade-offs against the current design. Gathered 2026-09-04 from the repo on
host `voyager` (branch `main`, tip `06621b0`; host tmux is 3.7b from mise, which ships no man page, so
the tmux 3.7b `tmux.1` was fetched from the `3.7b` tag on GitHub and rendered with `man -l`).

Nothing here was live-probed against a tmux server (the sandbox blocks unix sockets). Every tmux
behaviour claim cites `man tmux` (3.7b) by section or command, the tmux wiki, or a project README;
anything that could not be confirmed is marked **unverified**.

## TL;DR

- Today the browser never sees a tmux client. The server polls `capture-pane -e -p -S -N` on one pane
  per viewer every `pollIntervalMs` (default 500 ms), sanitises the text down to SGR-only, dedupes
  unchanged frames, and sends whole-viewport `reset` frames; the browser writes each frame into the
  hidden half of a two-xterm.js double buffer and swaps. Input goes back as base64url over a second
  WebSocket and is replayed with `send-keys -l` / `send-keys Enter|C-c`. Sizing is done by the server
  with `resize-window`/`resize-pane`, clamped to the smallest *real* attached tmux client (a port of
  tmux's `ignore_client_size()`), and unpinned (`set-option -wu window-size`) on release.
- One correction to the brief: agents are **not** one tmux server each. A launch is `new-session -d -s
  <name>` on the console's default server (or on `$RAC_HOST_TMUX_DIR/default` under the host bridge);
  the console then discovers every socket in `/tmp/tmux-<uid>/` and identifies an agent as
  `<socket fingerprint>:<pane id>`.
- A full-attach `/ws/terminal/:id` route (node-pty spawning `tmux -S <sock> attach-session -t <name>`)
  existed from the first commit and was deleted on 2026-09-03 as dormant; `pnpm-workspace.yaml` still
  lists `node-pty` under `allowBuilds`/`onlyBuiltDependencies` (stale).
- There is no mature JS/TS tmux *client* library. The only control-mode protocol parser on npm is
  `@promptctl/tmux-control-mode-js` 0.1.0 (2 stars). Everything else is either a CLI wrapper
  (`libtmux` alpha, `tmux-mcp`, `node-tmux` 2018), a whole application (`tmux-next`, `tmux-web`,
  `tmux-weblink`, `agentboard`, `clsh`, `Codeman`), or a terminal-emulator plugin (`tabby-tmux`,
  `hypermux`). xterm.js itself has no tmux awareness; its README lists tmux only as an app it runs.
- Two real-world patterns cover the field: **stream a real tmux client's bytes** (ttyd/gotty
  `ttyd tmux new -A …`, Zellij's own web client, agentboard, tmux-web) so tmux draws borders and the
  status bar; or **model tmux structurally** via control mode (iTerm2, tabby-tmux, tmux-next, clsh)
  with one xterm.js per pane. Nobody does per-pane `capture-pane` polling at RAC's scale of polish;
  agentboard offers `pipe-pane` as a PTY-less alternative.
- For RAC, the cheapest multi-pane step is option A (capture every pane of the window, place them by
  `list-panes -F '#{pane_left} #{pane_top} #{pane_width} #{pane_height}'`); the highest-fidelity step is
  option C (a control-mode client per session feeding one xterm.js per pane) which composes cleanly
  with the size-yield logic because a control client that never calls `refresh-client -C` is invisible
  to tmux sizing and already ignored by `clientLimit()`. Option B (real attach) is the only one that
  gives prefix keys, copy mode and the status bar for free, but it makes the console's own client a
  size participant, which is exactly what the size-yield work was built to avoid.

## Part 1 — How RAC uses xterm.js with tmux today

### 1.1 Shape of the system

| Piece | Where | What |
|---|---|---|
| Web deps | `apps/web/package.json` | `@xterm/xterm ^5.5.0` (locked 5.5.0, `pnpm-lock.yaml:809`), `@xterm/addon-fit ^0.10.0`, `@xterm/addon-web-links ^0.11.0`. Only `Terminal` and `FitAddon` are imported (`apps/web/src/main.tsx:4-5`); nothing in `apps/web/src` imports `addon-web-links` — link detection is RAC's own `output-links.ts`. Latest on npm 2026-09-04: `@xterm/xterm` 6.0.0, `addon-fit` 0.11.0. |
| Server deps | `apps/server/package.json` | Fastify 5 + `@fastify/websocket`. No node-pty, no tmux library: every tmux call is a child process. |
| tmux wrapper | `apps/server/src/tmux/adapter.ts`, `command.ts` | `TmuxAdapter` spawns `RAC_TMUX_BIN ?? /usr/bin/tmux` per call (`adapter.ts:105`) through `run()` (`command.ts:24`): `spawn` with `safeEnv()`, 5 s SIGKILL timeout, stdout capped at 1 MB. |
| WebSockets | `apps/server/src/app.ts:1569-1729` | `/ws/dashboard`, `/ws/logs/:id`, `/ws/input/:id`; each authenticates with a single-use 30 s ticket carried as the second WebSocket subprotocol (`auth/tickets.ts:2-3`, kinds `dashboard|input|logs`). |
| Browser | `apps/web/src/main.tsx` (6,468 lines), `output-links.ts`, `terminal-font-size.ts` | Two xterm.js instances per Log, double-buffered. |

Agents, sessions, sockets — verified against the launch and discovery code rather than the brief:

- A launch creates **one session per agent on a shared server**: `tmux new-session -d -s <session>
  <node> runner.js <descriptor>` (`launch/service.ts:305`, `:393`), where `<session>` is
  `basename(worktree)` (`tmux/session-name.ts:9-11`) or `rac-<12 chars>` for scratch
  (`launch/service.ts:292`). No `-S` is passed on the local path, so this is the default server for the
  console's uid; under the host bridge every command carries `-S $RAC_HOST_TMUX_DIR/default`
  (`launch/service.ts:67`, `:296`, `:382`). The runner (`launch/runner.ts`) `spawn`s the program with
  `paneEnv()` so `TMUX`/`TMUX_PANE` survive for the ADR 0001 hooks (`tmux/command.ts:19-23`).
- Discovery scans **every** tmux socket: `/proc/net/unix` entries under `/tmp/tmux-<uid>/` (or a mounted
  `RAC_HOST_TMUX_DIR`) become `SocketRef { fingerprint, path }` (`discovery/service.ts:21-60`), and an
  agent id is `${socket.fingerprint}:${paneId}` (`discovery/service.ts:382`). So "one server per agent"
  is possible if the operator runs it that way, but the console neither creates nor assumes it.
- A worktree window may hold companion panes: the resize code preserves "HUD or worker panes"
  (`tmux/adapter.ts:191-194`) and the OMX adapter classifies `omx hud --watch` panes
  (`adapters/omx-panes.ts:17-18`, `:31-44`). There is already a multi-pane window in the product's model,
  just not in its view.

### 1.2 Server: what is captured, how often, how frames are built

`TmuxAdapter` methods that matter for this question (`apps/server/src/tmux/adapter.ts`):

| Method | Lines | tmux command | Notes |
|---|---|---|---|
| `listPanes` | 109-116 | `list-panes -a -F '#{pane_id}\t#{session_id}\t…\t#{@rac_console_managed}'` | 14 tab-separated fields incl. the ADR 0001 pane options `@rac_attention`, `@rac_session`, `@rac_sandboxed`, `@rac_question`. |
| `capture` | 134-138 | `capture-pane -e -p -t %N -S -800` | 800 lines of history, sanitised, last 96,000 chars. Used by the prompts service (questions, turn completion). |
| `captureRecentWindow` | 141-152 | `capture-pane -e -p -t %N -S -<min(300, rows+24)>` | The cheap live poll: slice the last `rows` lines, bottom-align (`bottomAlignedWindow`, 42-53). |
| `captureWindow` | 154-173 | `capture-pane -e -p -t %N -S -5000` | The "detailed" poll and history paging: slices concrete lines at `history` offset ("tmux's -S/-E coordinates shift around wrapped and blank rows", 156-158) and extracts `lastPrompt` / `latestAgentMessage` / `latestAssistantMessage` from the Codex turn parser. |
| `resize` | 175-209 | `display-message -p -t %N '#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}'`, then `resize-window -t %N -x W -y H`, then `resize-pane -t %N -x cols -y rows`, one corrective pass | Window size = pane size + the companion panes' extra cols/rows. |
| `size` | 211-223 | `display-message -p … ; list-clients -t %N -F '#{client_width}\t#{client_height}\t#{client_flags}\t#{status}'` in **one** tmux process | Returns `{cols, rows, clientLimit?}`. |
| `unpinWindowSize` | 227-230 | `set-option -w -t %N -u window-size` | Because `resize-window` "will automatically set window-size to manual" (`man tmux`, *resize-window*). |
| `pastePrompt` | 232-237 | `load-buffer -b rac-… -` then `paste-buffer -p -d -b … -t %N` | Bracketed paste for prompts. |
| `sendKeys` | 244-259 | one `send-keys -t %N <key>` per key; 120 ms after `Escape` | ADR 0002 sequencing: "a chord written in one send-keys is read as Meta" (10-11). |
| `input` → `sendInput` | 290-314 | splits on `\r\n|\r|\n|\x03` → `send-keys Enter`, `send-keys C-c`, or `send-keys -l -t %N <text>` | Per-pane promise queue so keystrokes stay ordered. |
| `suspend` / `foreground` | 267-288 | `send-keys C-z` then poll `#{pane_current_command}`; later `input('\x15fg\r')` | Terminal-mode hand-off to a shell. |
| `close` / `closeSession` | 316-318, 340-342 | `kill-pane` / `kill-session` | |
| `attachArgs` | 344-346 | returns `['-S', sock, 'attach-session', '-t', session]` | **No caller left** after the `/ws/terminal` removal (grep of `apps/server/src`). |

Sanitisation (`safeSnapshot`, `adapter.ts:14-40`): keeps printable characters, `\n \r \t`, and CSI
sequences ending in `m` (SGR) only; drops every other CSI, and skips OSC/DCS/PM/APC bodies to their
terminator. Each line gets a trailing `\x1b[49m`. This is why the browser can `write()` a capture as a
whole frame: there are no cursor-movement or mode sequences left in it.

Snapshot cadence and frame dedup (`apps/server/src/app.ts:1584-1728`, `/ws/logs/:id`):

- A `setInterval(refresh, config.pollIntervalMs)` per viewer (`:1691`). `tmux.pollIntervalMs` is
  validated `int, min 250, max 10000, default 500` (`config/schema.ts:58`).
- Each tick, `refresh()` first re-targets the pane size (`viewportLease().ensure(cols, rows)`,
  `:1676-1685`, comment: "external layout changes are repaired, and a terminal attached to the session
  caps the size") and, if the viewer is live (`history === 0`), runs `poll()`.
- `poll()` (`:1610-1658`) chooses the cheap `captureRecentWindow` unless the viewer is paging history
  or the 30 s metadata refresh (`logMetadataRefreshMs = 30_000`, `:70`) is due, in which case
  `captureWindow` runs and the frame carries `metadata`.
- Frames are always **full resets**. `logFrame()` (`:84-92`) returns `undefined` when the text is
  unchanged or blank (`value === last`) and otherwise `{ type: 'reset', text }` — the comment explains:
  "Captures are complete viewport frames. Replaying a guessed suffix can preserve cells that tmux
  already redrew, producing a mixed old/new frame." A non-immediate reset within 750 ms of the last is
  skipped (`:1637`).
- Outbound frame shape (`:1647`): `{ v: 1, type: 'reset', text, older, newer, metadata?, question?,
  lastPrompt? }` where `metadata = { state: 'complete', latestAgentMessage, latestAssistantMessage,
  latestAssistantMessageOverflows }` and `question` is the adapter's inline-question parse of the
  capture (`:1645`).
- Inbound frames (`:1692-1724`): `{ v:1, type:'viewport', cols, rows }`, `{ v:1, type:'history',
  offset, cols?, rows? }`, `{ v:1, type:'metadata' }`. A viewport request goes through
  `LatestViewportScheduler` (`logs/viewport-scheduler.ts:7-27`) so only the newest size is applied.

Size yield to attached tmux clients (`adapter.ts:79-102` + `logs/viewport-scheduler.ts`):

- `clientLimit()` mirrors tmux's `ignore_client_size()` (comment at `adapter.ts:79-83`): a client with the
  `suspended` flag or a tty under 2×2 is skipped — the latter is how a control-mode client that never
  published a size drops out; `ignore-size` clients count only when no other client is attached; each
  client's usable rows are `client_height − status lines`; then the companion panes' extra cols/rows are
  subtracted so the *pane* limit is what is returned.
- `PaneViewportCoordinator.within()` clamps every requested size to that limit (`viewport-scheduler.ts:44-47`),
  `ensure()` re-reads the limit on every tick (`:100-103`), `release()` restores the largest size seen and
  calls `unpin` (`:115-121`), and `restoreAll()` runs on server close (`app.ts:1730`).
- The tmux side of this: `window-size largest | smallest | manual | latest` (`man tmux`, OPTIONS);
  `resize-window … will automatically set window-size to manual` (COMMANDS, *resize-window*);
  `attach-session -f ignore-size` = "the client does not affect the size of other clients" (COMMANDS,
  *attach-session*); the tmux FAQ: "Until version 2.9, tmux limits the size of the window to the
  smallest attached client" (https://github.com/tmux/tmux/wiki/FAQ).

Input (`app.ts:1729`, `/ws/input/:id`): frames `{ v:1, type:'input', data:<base64url> }`, decoded ≤ 64 KiB,
re-encoded to check canonical form; a lone `\x03` is routed through `prompts.cancel(id)` and only
forwarded to the pane when the agent is not working; everything else goes to `tmux.input`.

### 1.3 Browser: two xterm.js instances, whole-frame writes, swap

All in `apps/web/src/main.tsx` (the `Log` component effect starting around `:3838`):

- Terminal options (`:3856`): `convertEol: true`, `scrollback: 0`, `screenReaderMode` on coarse
  pointers, font from `terminal-font-size.ts` (`rac.terminal-font-size`, 8–24 px), theme from CSS
  palette tokens. Two terminals and two `FitAddon`s (`:3857-3858`) are opened into `primaryHost` /
  `secondaryHost` (`:3867`); `activeFrame: 0 | 1` (`:3862`) drives the `.terminal-frame.active` class
  (`:4444`) so only one is visible.
- Viewport: a `ResizeObserver` on the canvas plus `resize`, `visualViewport.resize`,
  `visibilitychange`, `pageshow` (`:3950-3956`) coalesce into one rAF that refits both terminals and
  sends `{ type:'viewport', cols, rows }` (`:3919-3931`).
- Rendering a frame (`renderSnapshot`, `:4221-4276`): pick the *inactive* terminal (unless input is
  focused, to keep the mobile keyboard up, `:4229-4233`), `reset()` it, `write()`
  `ESC[H` + bottom-aligned text with `ESC[K` per line + `ESC[J` (`:4235-4237`, `bottomAlignedSnapshot`
  `:2268-2271`); in the write callback swap `activeFrame`, `setVisibleFrame`, and `reset()` the
  previous terminal on the next animation frame — guarded with `previousTerminal !== terminal`
  (`:4272`) after the background-tab clobber bug.
- Append frames (`:4112-4126`, `:4367-4377`) go through an animation-frame text batcher into the visible
  terminal followed by `scrollToBottom()`. The server does not currently emit `append` (see `logFrame`
  above) but the client keeps the path (`nextLiveSnapshot`, `client-cache.ts:23-25`).
- Input: `terminal.onData` on both instances → mobile modifier keys → `sendInput` → `/ws/input`
  (`:4138-4143`, `:3883-3903`).
- Cache: `logSnapshots = new BoundedTextCache(64, 64 * 1024)` (`:230`); the dashboard pre-warms it by
  opening a `/ws/logs` socket per agent, taking one frame, and closing (`:5673-5680`).
- History paging asks the server for `offset ± (rows − 5)` (`:3909-3917`).
- `output-links.ts` walks `terminal.buffer.active` cell by cell to find URLs and file paths and draws
  overlays; this is the reason `addon-web-links` is unused.

History of this design (git): `feat: enable direct terminal input from logs` (`6f464e2`, 2026-07-21),
`fix: send focused log input without resizing tmux` (`3c6e70a`), `fix: double buffer terminal frames`
(`8a4253b`, 2026-07-21).

### 1.4 The removed full-attach route

`/ws/terminal/:id` was in the first commit (`488a34d`, `feat: add secure remote agent console`) and lived
until `6677bdf` (2026-09-03, on `main`; `174a3d1` is the same change as it appeared on the since-rebased
`direct-spawn-groundwork` branch, which no longer exists locally). Its body, from `git show 6677bdf^:apps/server/src/app.ts:1711`:

- `pty.spawn(RAC_TMUX_BIN ?? '/usr/bin/tmux', ['-S', socket.path, 'attach-session', '-t', sessionName],
  { name: 'xterm-256color', cols: 120, rows: 36, cwd: '/', env: safeEnv() })`;
- outbound `{ v:1, type:'output', data:<base64url bytes> }`; inbound `{ type:'resize', cols, rows }`
  (2..500 × 2..300) → `terminal.resize`, and `{ type:'input', data }` → `terminal.write`;
- a `terminal` ticket kind, consumed against the *session* id rather than the pane.

The removal message: "`/ws/terminal/:id` spawned a real tmux client in a pty and attached the whole
session. The web never requested it: terminal mode streams the pane through `/ws/logs` and sends keys
through `/ws/input`, and the swap e2e asserts that no `terminal` ticket is ever minted. What remained
was an unused way to attach a client that the per-viewer pane sizing would then have to yield to. Drop
the route together with the `terminal` ticket kind and the `node-pty` dependency that existed only for
it." (`apps/web/e2e/agent-swap.spec.ts:113` still asserts `not.toContain('terminal')`.) Leftovers:
`pnpm-workspace.yaml:6,10` still list `node-pty`; `TmuxAdapter.attachArgs` is dead.

### 1.5 ADRs that constrain the options

| ADR | Title | Why it matters here |
|---|---|---|
| 0001 | Agents report their state through tmux pane options | State rides `@rac_*` pane options read by `list-panes -a -F`; any option below must keep polling that (or subscribe to it via control mode `refresh-client -B`). |
| 0002 | Adapters describe their agent; the console acts | All tmux side effects go through one layer; `send-keys` sequencing (one key per call, Escape delay) lives in `adapter.ts:244-259`. |
| 0003 | Worktrees are discovered from git; operator state is keyed by Project and path | Session naming (`session-name.ts`). |
| 0004 | Sandbox the model's commands, not the agent process | Not directly affected. |
| 0005 | OMX is its own Adapter kind | The HUD/worker pane classification is the existing multi-pane case. |
| 0006 | Claude inline questions ride the reported-state channel | The matcher needs the question text and `1. <label>` within the last 80 lines of a `capture-pane -e -p` (`adapters/claude-questions.ts:23`, `:75-82`; `prompts/service.ts:761-765`). Any option that stops calling `capture` for the agent pane breaks it. |

`docs/integrations.md` is unrelated to the terminal path: the MCP/Realtime gateway "do[es] not expose
the raw terminal or an arbitrary shell".

## Part 2 — What exists: JS/TS tmux clients, browser terminals, agent consoles

### 2.1 tmux's own client-facing interfaces (the primary source)

`man tmux` 3.7b, section **CONTROL MODE** (rendered text lines 4329-4449 of the fetched page), and the
wiki page https://github.com/tmux/tmux/wiki/Control-Mode:

- Start: `tmux -C attach` leaves the terminal in canonical mode ("intended for testing"); `-CC`
  "disables canonical mode and most other terminal features and is intended for applications" and emits
  a `\033P1000p` DCS on entry and `%exit` on exit (wiki). An empty input line detaches.
- Protocol: commands on stdin, one output block per command bracketed by `%begin`/`%end` or
  `%begin`/`%error`, each with `time command-number flags`. "A notification will never occur inside an
  output block."
- Notifications (man page list): `%output pane-id value` ("value escapes non-printable characters and
  backslash as octal \xxx"); `%extended-output pane-id age … : value` when `pause-after` is set;
  `%layout-change window-id window-layout window-visible-layout window-flags`; `%window-add`,
  `%window-close`, `%unlinked-window-add/close/renamed`, `%window-renamed`, `%window-pane-changed
  window-id pane-id`; `%session-changed session-id name`, `%client-session-changed`,
  `%session-window-changed session-id window-id`, `%sessions-changed`, `%session-renamed`;
  `%pane-mode-changed pane-id`; `%pause`/`%continue pane-id`; `%subscription-changed name … : value`;
  `%paste-buffer-changed/deleted`; `%message`; `%config-error`; `%client-detached`; `%exit [reason]`.
- Sizing: "The refresh-client -C command may be used to set the size of a client in control mode";
  `-C size` is `widthxheight` or `window-id:widthxheight` ("sets the width and height of a control mode
  client or of a window for a control mode client", COMMANDS, *refresh-client*). Wiki: "If this is not
  used, control mode clients do not affect the size of other clients no matter the value of the
  window-size option."
- Flow control and flags (*attach-session* / *refresh-client -f*): `no-output` ("the client does not
  receive pane output in control mode"), `pause-after=seconds`, `wait-exit`, `ignore-size`, `read-only`,
  `active-pane` ("the client has an independent active pane"). `refresh-client -A %pane:on|off|continue|pause`
  per pane; `-B name:what:format` subscribes to a format for the session, a pane, `%*`, a window or `@*`
  and reports changes "at most once a second". EXIT MESSAGES include `too far behind`: "The client is in
  control mode and became unable to keep up with the data from tmux."
- Layout: `select-layout` accepts the string shown by `list-windows`, e.g.
  `bb62,159x48,0,0{79x48,0,0,79x48,80,0}`; "tmux automatically adjusts the size of the layout for the
  current window size" and "a layout cannot be applied to a window with more panes than that from which
  the layout was originally defined" (WINDOWS AND PANES). FORMATS provides `window_layout` ("ignoring
  zoomed window panes"), `window_visible_layout`, `window_zoomed_flag`, `pane_left`, `pane_top`,
  `pane_width`, `pane_height`, `pane_active`, `pane_index`, `pane_at_left/right/top/bottom`, `pane_in_mode`,
  `pane_dead`, `cursor_x`, `cursor_y`, `history_size`, `client_width`, `client_height`, `client_flags`,
  `client_control_mode`, `window_active_clients`.
- Commands: `list-panes [-ars] [-F format] [-f filter] [-t target]` (`-a` all panes on the server, `-s`
  all in a session, else the window); `capture-pane [-aeFHLpPqCJMN] [-S start] [-E end]` (`-e`
  attributes, `-C` octal-escape non-printables, `-J` joins wrapped lines and implies `-T`, `-N` keeps
  trailing spaces, `-a` alternate screen, `-M` mode screen, `-S -` whole history); `pipe-pane [-IOo] [-t]
  [shell-command]` ("A pane may only be connected to one command at a time"; `-O` = pane output → command
  stdin, the default; no command closes the pipe; `-o` toggles); `display-message -p -t target-pane
  message`; `select-window [-lnpT]`, `next-window [-a]`, `select-pane [-DdeLlMmRUZ] [-T title]`;
  `send-keys [-FHKlMRX] [-N repeat] [-t target-pane] key…` (`-l` literal, `-K` to a client's key table);
  `resize-pane [-x width] [-y height] [-Z]`; `new-session -t group-name` — "Sessions in the same group
  share the same set of windows … The current and previous window and any session options remain
  independent".

iTerm2 (https://iterm2.com/documentation-tmux-integration.html) is the reference control-mode client:
`tmux -CC`; each tmux window becomes a native window/tab and panes native splits; "Resize a window:
Tells tmux that the client size has changed, causing all windows to resize. Windows are never larger
than the smallest attached client"; "A gray area on the right or bottom of a window indicates that a
physical window is larger than the maximum allowed tmux window size"; "all tmux windows/tabs will
contain the same number of rows and columns"; a dialog lets the user run any tmux command. No tmux
version requirement is stated on that page.

xterm.js (https://github.com/xtermjs/xterm.js, MIT, 21,137 stars; API
https://xtermjs.org/docs/api/terminal/classes/terminal/): "a frontend component that enables
applications to bring fully-featured terminals to their users in the browser"; "works with most terminal
apps such as `bash`, `vim`, and `tmux`" — that is the only tmux mention; there is no tmux-aware
addon. `write(data, callback?)` is asynchronous ("Provide a callback to know when the data was
processed"), `reset()` is "a full reset (RIS, aka '\x1bc')", `resize(columns, rows)`, `clear()`.
Official addons listed in the README: attach ("enables attaching to a web socket", bidirectional),
clipboard, fit, image, ligatures, progress, search, serialize ("serialize a terminal framebuffer into
string or html", experimental), unicode-graphemes, unicode11, web-fonts, web-links, webgl. `addon-canvas`
is **not** in the current README list (status unverified). Latest npm 2026-09-04: `@xterm/xterm` 6.0.0,
`addon-serialize` 0.14.0, `addon-attach` 0.12.0, `addon-webgl` 0.19.0.

### 2.2 JS/TS tmux libraries and apps

Method: `npm view` for 27 candidate names (with a `$TMPDIR` npm cache; the default `~/.npm/_cacache` is
read-only in the sandbox), `npm search tmux`, `gh search repos` (TypeScript, JavaScript, "tmux control
mode"), and `gh api repos/…` for stars/dates/licence on 2026-09-04. Names that **do not exist** on npm
(404): `tmux-control`, `tmux-cc`, `@types/tmux`, `webtmux`, `tmuxjs`, `node-tmux-control`,
`tmux-control-mode`, `@tmux/control`, `tmux-client`, `tmux-control-client`, `tmuxinator`, `tmux-js`,
`tmux-node`, `tmux-cli`, `tmux-ts`, `@tmuxcc/driver`, `@tmuxcc/client`. The bare `tmux` package is an
npm deprecation placeholder ("npm is hanging on to the package name", modified 2022-06-27).

| Project | Repo / npm | Last publish or push | Stars | Wraps | Renders? | Licence | What it actually is |
|---|---|---|---|---|---|---|---|
| tmux-control-mode-js | github.com/promptctl/tmux-control-mode-js; npm `@promptctl/tmux-control-mode-js` 0.1.0 (2026-06-24) | pushed 2026-07-19 | 2 | **control mode** (`tmux -C`): parses `%begin/%end/%error`, `%output`, `%layout-change`, `%window-add`…, unescapes octal, sends commands | No ("proves you can drive a real web UI with this library without pulling it into the browser bundle") | MIT | The only published Node control-mode protocol library found. Node ≥ 20, tmux ≥ 3.2 with 3.4+/3.5+ feature gates; ships a demo multiplexer that is "not production code" (no auth). |
| tmux-next | github.com/niletry/tmux-next; npm `tmux-next` 2.2.0 (2026-09-04) | pushed 2026-09-04 | 0 | **control mode**; per browser connection a disposable grouped session `web-<uuid>` "participates as an ordinary tmux client, and size negotiation and window ownership are arbitrated by tmux itself" | Yes, xterm.js, **one pane** ("none of tmux's own split borders or status bar — what you see in the browser is the program's own screen") | MIT | Mobile-first app. "When a browser connects the window follows it; on disconnect `resize-window -A` hands the size back to whoever is left." Adaptive font so "a phone is always 80 columns". Bun only ("node is not supported"). No auth of its own. |
| tmuxcc-driver | github.com/cwalv/tmuxcc-driver | pushed 2026-07-19 | 0 | **control mode** (`-CC`): "materializes the state" into snapshot + ordered deltas | No (protocol only) | none stated | Early; the `@tmuxcc/*` packages it names are not on npm. |
| dsh-tmux-cc | github.com/adrianleb/dsh-tmux-cc | pushed 2026-09-01 | 0 | control mode (per description) | unverified | MIT | "tmux control-mode cockpit for DeepSeek Harness Web"; README not fetched — **unverified** beyond the description. |
| tabby-tmux | github.com/ruanimal/tabby-tmux; npm `tabby-tmux` 1.4.0 (2026-08-16) | pushed 2026-08-16 | 7 | **control mode**, "inspired by iTerm2 tmux Integration" | Yes, in the Tabby terminal app: "Maps tmux windows and panes into native Tabby components", "syncs tmux layout into Tabby SplitTab" | MIT | Terminal-emulator plugin, not a browser app; Tabby is Electron + xterm.js, so this is the closest existing "one xterm per pane from control mode" TypeScript code. |
| hypermux | github.com/ha-D/hypermux | pushed 2020-10-16 | 0 | control mode plugin for Hyper | (Hyper) | MIT | 4 commits, no README content; abandoned. |
| libtmux (TS) | github.com/libtmux/libtmux-ts; npm `libtmux` 0.1.0-alpha.7 (2026-08-30) | pushed 2026-08-30 | 0 | **CLI** ("invoking tmux commands", immutable snapshots); a `wait_for_text` MCP tool "streaming tmux notifications" (mechanism unverified) | No | MIT | "Alpha … The API is not settled". Bun 1.3.14+ or Node 22+, tmux ≥ 3.2a, Linux only. Port of Python libtmux (1,205 stars, also CLI-based). |
| tmux-mcp | github.com/nickgnd/tmux-mcp; npm `tmux-mcp` 0.2.2 (2025-08-24) | pushed 2026-02-14 | 300 | CLI (tools named `list-sessions`, `capture-pane`, `send-keys`, `split-pane`…; implementation not read — **unverified**) | No | MIT | MCP server for Claude Desktop. |
| node-tmux | github.com/ExodiusStudios/node-tmux; npm `node-tmux` 1.0.2 (2018) | pushed 2018-10-15 | 8 | CLI session wrapper | No | ISC | Dead since 2018. |
| tmux.js | github.com/tadeuzagallo/tmux.js; npm `tmux.js` 0.2.1 (2014) | pushed 2015-05-19 | 2 | nothing — a plugin for the author's `zsh.js` | — | MIT | Not a tmux client despite the name. |
| tmux-web | github.com/ashutoshpw/tmux-web; npm `tmux-web` 0.3.1 (2026-06-13) | pushed 2026-07-11 | 1 | attaches "through a full terminal in your browser" (mechanism not stated — **unverified**, likely a pty) | xterm.js (or `ghostty-web`) | MIT | "Windows drawer — switch tmux windows from the terminal header". Node ≥ 22. |
| tmux-weblink | github.com/Willlee11/tmux-weblink; npm `tmux-weblink` 2.2.28 (2026-09-02) | pushed 2026-09-02 | 1 | "attachments are real: windows/panes you open and what other terminals … see stay fully in sync" (mechanism **unverified**) | xterm.js | MIT | Continuation of tmux-web + persalink; window drawer, PWA, touch. |
| @termwire/tmux | github.com/max-konin/termwire; npm 0.2.2 (2026-08-17) | — | — | unverified (Bun dev-environment tool for tmux + Neovim + OpenCode) | No browser | MIT | Not a client library for our purpose. |
| @cotal-ai/tmux | npm 0.41.2 (2026-09-04), repo Cotal-AI/Cotal | — | — | "a tmux Runtime and TerminalLayout provider for spawning agents into tmux windows" (npm description only — **unverified**) | unknown | Apache-2.0 | Agent-orchestration internals. |

Non-JS control-mode clients found (for reference only): `ArcavenAE/tmux-cmc` and `ace-rs/tmuxctl`
(Rust), `robber-m/C-Tmux-Control-Mode` (C, 2015), `cycorld/cc-tmux` (Python, "Control Claude Code
interactive sessions through tmux control mode"), `wstart/TFA` (Swift), `h3nock/remux-ghostty` (Zig).

Honest summary: there is no maintained, adopted JS/TS *library* that models a tmux server. If RAC goes
the control-mode route it will be writing (or vendoring) the parser; the protocol is small and
line-oriented, and `@promptctl/tmux-control-mode-js` is a 0.1.0 reference for the escaping and block
framing rather than a dependency to rely on.

### 2.3 Browser terminal projects and how each relates to tmux

| Project | Metadata (gh api, 2026-09-04) | Terminal in browser | Relationship to tmux | Model |
|---|---|---|---|---|
| ttyd (tsl0922/ttyd) | C, MIT, 12,302 stars, pushed 2026-08-12 | xterm.js ("Built on top of libuv and WebGL2") | Wiki *Example Usage*: `ttyd tmux new -A -s ttyd vim` — "Sharing single process with multiple clients" (https://github.com/tsl0922/ttyd/wiki/Example-Usage) | **Real pty**: tmux draws borders/status bar; prefix keys work. |
| gotty (yudai/gotty; fork sorenisanerd/gotty) | Go, MIT; original 19,547 stars (last push 2024-08-01), fork 2,544 (pushed 2026-08-05) | "GoTTY uses xterm.js" | README: "you can start a new tmux session named gotty with top command" | Real pty. |
| wetty (butlerx/wetty) | TS, MIT, 5,424 stars, pushed 2026-09-04 | xterm.js | none — spawns `ssh` (or `/bin/login` as root) | Real pty via ssh. |
| sshx (ekzhang/sshx) | Rust, MIT, 7,657 stars, pushed 2025-06-19 | `sshx-xterm` fork + `xterm-addon-webgl/image/web-links` (root `package.json`) | none — its own multiplexer: many terminals "on an infinite canvas", each a pty spawned by the client binary | Own structural model, not tmux. |
| tmate (tmate-io/tmate) | C, 6,123 stars, pushed 2026-07-29; README: "tmux and tmate are BSD-licensed" | https://tmate.io returned **HTTP 503** twice; `tmate-websocket` README is empty | "a fork of tmux" | Web viewer details **unverified** (site unreachable). |
| upterm (owenthereal/upterm) | Go, Apache-2.0, 1,288 stars | none — SSH or SSH-over-WebSocket clients only | `--force-command` for `tmux attach` workflows | Not a browser terminal. |
| Zellij web client | Rust, MIT, 35,282 stars; web client shipped in 0.43.0 (https://zellij.dev/news/web-client-multiple-pane-actions/; docs https://zellij.dev/documentation/web-client.html) | xterm.js | n/a (Zellij is the multiplexer) | **Server-side render, one terminal stream**: the embedded web server "reus[es] the Zellij client code per connection, serving as a translation layer between the browser's websockets and the Zellij server's IPC channels"; two WebSockets — one carries "STDOUT bytes to the client (essentially ANSI instructions representing renders)" and STDIN back, the other window resizes / config / switch-session; Zellij renders "the whole session (panes, tabs, UI) server-side" (author's write-up https://poor.dev/blog/building-zellij-web-terminal/). Token auth, read-only tokens, PWA, mobile viewport/keyboard. |
| xterm.js + node-pty + `tmux attach` | node-pty 2,022 stars, npm 1.1.0 (2026-08-03); needs a C/C++ toolchain (no Linux prebuilds per Codeman's README) | xterm.js | the generic pattern (RAC's old `/ws/terminal`, agentboard, tmux-web) | Real pty. |

### 2.4 AI-agent consoles: does anyone do multi-pane tmux in a browser?

| Project | Metadata | tmux? | Browser terminal? | Multiple at once? | Mechanism |
|---|---|---|---|---|---|
| claude-squad (smtg-ai) | Go, AGPL-3.0, 8,424 stars | yes — "tmux to create isolated terminal sessions for each agent" | **No** — TUI only; attach with `↵/o`, detach `ctrl-q` | n/a | native tmux attach |
| agent-deck (asheshgoplani) | Go, MIT, 839 stars, pushed 2026-09-04 | yes — `agentdeck_*` sessions | TUI plus `agent-deck web` on `127.0.0.1:8420` with a "session terminal" view and `--read-only` | unverified | **unverified** (docs not fetched) |
| vibe-kanban (BloopAI) | Rust, Apache-2.0, 28,013 stars, pushed 2026-04-24, README says "sunsetting" | not stated | browser UI (diffs, built-in browser); terminal detail not stated | — | **unverified** |
| omnara (omnara-ai) | Go, Apache-2.0, 2,818 stars | no mention | dashboard / Slack; no terminal detail | — | not terminal-based |
| Codeman (Ark0N) | TS, MIT, 739 stars, pushed 2026-09-04 | yes — "Every session runs inside tmux"; per-instance socket `-L codeman-<name>` | "a real `xterm.js` terminal; full TUIs render correctly"; "PTY Output → 16ms Server Batch → DEC 2026 Wrap → SSE → Client rAF → xterm.js (60fps)" | yes — "draggable, resizable panels for each agent", "20 parallel sessions" | real pty per session (attach mechanism not read — **unverified**); claims "several clients can attach the same remote session at different window sizes without clamping each other" (how: unverified) |
| mulmoterminal (receptron) | TS, MIT, 202 stars | yes, for persistence only ("a server crash or restart doesn't kill your terminals"; falls back to plain PTYs) | xterm.js | yes — "a grid of live sessions, each cell color-coded by state" | node-pty per cell |
| clsh (my-claude-utils) | TS, MIT, 526 stars, pushed 2026-06-20 | yes — wraps sessions with **`tmux -CC` control mode** "to send structured terminal output rather than screen redraws, allowing xterm.js to receive the original byte stream" | xterm.js (WebGL) | yes — "Session grid — 2-column card layout with live terminal previews", up to 8 PTYs | node-pty + control mode; PWA, custom keyboard |
| agentboard (gbasin) | TS, MIT, 412 stars, pushed 2026-09-04 | yes — discovers sessions via the tmux CLI | React + xterm.js; iOS Safari focus | one session at a time (sidebar, `Ctrl+Shift+1..9`) | `TERMINAL_MODE=pty` (default): `tmux attach` in a Bun pty "through a per-connection session grouped with it (`agentboard-ws-<connection>-x-<session>-<hash>`), so focus in the browser stays independent of your own tmux clients"; or `TERMINAL_MODE=pipe-pane` ("PTY-less, works in daemon/systemd/docker without `-t`"). Also `tmux -T sync` for DEC 2026 atomic frames and `set-clipboard on`. |
| nodeterm (eneskirca) | TS, BUSL-1.1, 1,733 stars | "xterm + tmux"; ships its own tmux on macOS | Electron plus a "browser Server Edition" with "a WebSocket bridge, and the exact same renderer" | each terminal is a canvas node | node-pty (per-pane vs per-window **unverified**) |
| dev-3.0 (h0x91b), ai-maestro (23blocks-OS) | 252 / 761 stars | descriptions mention tmux / dashboards | — | — | not fetched — **unverified** |

Pattern: the consoles that show many agents at once (Codeman, mulmoterminal, clsh) give each agent its
own pty/terminal and tile *terminals*, not tmux panes; the ones that expose an existing tmux server
(agentboard, tmux-web/-weblink, tmux-next) show one session/pane at a time with a window/session picker.
Nobody found renders several *tmux panes of one window* in a browser from a structural model — that
remains the iTerm2/tabby-tmux desktop pattern.

## Part 3 — Options for RAC

Baseline to compare against (from Part 1): per-viewer `capture-pane` polling at 500 ms with dedup and
SGR-only sanitisation; whole-frame `reset` writes into a double-buffered xterm.js; input via
`send-keys`; agent state via pane options (ADR 0001); inline questions from a fresh `capture` (ADR
0006); pane sizing by the server, yielded to attached terminals; phone use over the Cloudflare tunnel
or LAN; the console may run in Docker with the host tmux socket mounted (`RAC_HOST_TMUX_DIR`).

### Option A — Keep capture-pane polling, extend it per pane

What changes:

- `TmuxAdapter`: add `listWindowPanes(socket, pane)` →
  `list-panes -t %N -F '#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_active}\t#{window_width}\t#{window_height}\t#{window_zoomed_flag}'`
  (all verified format variables; `-t` a pane targets its window per *list-panes*), and reuse
  `captureRecentWindow` per pane. To keep one process per tick, chain commands with `;` the way `size()`
  already does (`adapter.ts:214`), separating captures with a sentinel `display-message -p` line — or
  accept N spawns per tick.
- `/ws/logs`: a new frame variant, e.g. `{ type:'reset', panes:[{ id, left, top, width, height, active,
  text }], window:{cols, rows} }`, or one `/ws/logs/:id?pane=%M` socket per pane (the ticket target is
  the agent id, so the server must check the extra pane belongs to the same window).
- Browser: N terminal *pairs* (the double buffer is per pane) laid out with CSS grid from the
  `pane_left/top/width/height` cells; `output-links` and font-size already work per terminal.
- Sizing: today `resize()` sizes the *agent pane* exactly and lets companions absorb the rest
  (`adapter.ts:191-197`). For a multi-pane view the browser's grid should size the *window*
  (`resize-window -x -y`) and let tmux's layout distribute; the agent pane then gets whatever the layout
  gives it. `clientLimit()` needs the same adjustment (its `extraCols/Rows` subtraction assumes the
  single-pane target).
- Window switching: capture by pane id (`capture-pane -t %M`) — tmux keeps a screen per pane whether or
  not its window is current, so nothing needs `select-window`. That the capture of a non-current window's
  pane is complete is expected from tmux's model but was **not live-verified** here. Listing the other
  windows is `list-panes -s -t <session> -F …` with `#{window_index} #{window_active}`. Server-side
  `select-window` would change what an attached operator sees, so avoid it unless the browser is meant
  to drive the operator's view.

What breaks / stays: ADR 0001 unchanged (`list-panes -a` already reads every pane). ADR 0006 unchanged
(`capture` of the agent pane is untouched). Size yield stays, with the window-vs-pane adjustment above.
Nothing about tmux's own UI (borders, status bar, prefix keys, copy mode) appears; the browser draws
its own borders.

Cost/risk: tmux process spawns scale with panes × viewers × 2 Hz; each capture is a full screen even when
only one pane changed (the dedup is per pane, so unchanged panes cost a spawn but no bytes). Mobile:
several panes on a phone need a "tabs of panes" presentation rather than a grid; the snapshot model is
already the friendliest for a backgrounded phone tab (nothing accumulates; the next poll is a full frame).

### Option B — Attach a real tmux client in a pty, stream bytes to one xterm.js

This is the removed `/ws/terminal` route (§1.4) revived. tmux renders panes, borders and the status
bar; the prefix key, copy mode, mouse (if enabled) and every binding in the operator's `.tmux.conf` work;
zoom/splits are one tmux command away.

What changes: bring back a pty spawner (node-pty — native build; or an external helper such as `script`
or `socat` **unverified** for this use here), frames `output`/`input`/`resize`, a `terminal` ticket kind,
and a browser terminal with `scrollback: 0` and no double buffer (bytes are incremental; agentboard's
`tmux -T sync` DEC 2026 trick makes redraws atomic in xterm.js).

What breaks:

- Size yield inverts. The console's own attached client now has a size, so `clientLimit()` will clamp
  every other viewer to the browser's tty, and `resize-window` sets `window-size manual` while a real
  client is attached. Choices: attach with `-f ignore-size` (then the browser shows a window sized for
  someone else — iTerm2's "gray area", the FAQ's dots), or attach through a **grouped session**
  (`new-session -t <agent session> -s rac-view-<id>` then attach it; agentboard and tmux-next do this)
  so each viewer has its own current window and active pane — but a window still has one size ("the
  same window can't render at two widths for two clients", tmux-next README), so `window-size latest`
  or `resize-window -A` on disconnect (tmux-next) is the practical compromise. `PaneViewportCoordinator`
  would need to exclude the console's own clients (match on `#{client_name}` or a flag) to keep yielding
  to human terminals only.
- Input bypasses `TmuxAdapter.input`/`sendKeys` (ADR 0002 sequencing) — keys go to the client's key
  table instead, which is the point (prefix works) but also means `prompts.beginAgentMutation` gating and
  the `\x03`→`prompts.cancel` routing must be re-implemented on the pty write path (the old route did
  the former, not the latter).
- The sanitiser is gone: raw tmux output reaches xterm.js (OSC 52 clipboard, OSC 8 links, DCS
  passthrough if `allow-passthrough`), so the browser terminal's own handling becomes the security
  boundary.
- ADR 0001/0006 unaffected (polling and `capture` continue alongside).
- Per-viewer cost is one long-lived tmux client process per open terminal, not periodic spawns; bytes
  are incremental (cheaper than full frames when idle, burstier when a TUI repaints).

Mobile: the status bar costs a row and tmux's chords need a virtual key bar (agentboard, clsh,
tmux-next all ship one); a backgrounded tab accumulates output until it repaints (Zellij batches
server-side; Codeman batches 16 ms). Docker/bridge: `-S <mounted socket> attach-session` worked in the
old route.

### Option C — A control-mode client per session, one xterm.js per pane (iTerm2 model)

What changes:

- Server: spawn `tmux -S <sock> -C attach-session -t <session>` (or `-CC`) once per viewed session
  (or once per server with `switch-client`; a control client receives `%output` for the session it is
  attached to and `%unlinked-window-*` for the rest). Parse `%begin/%end/%error` blocks and the
  notifications in §2.1; unescape the octal in `%output`; seed each pane's terminal with one
  `capture-pane -e -p` (control mode does not replay the current screen — iTerm2 seeds the same way,
  **unverified** from its docs) and then stream. Layout from `%layout-change` (the same string
  `select-layout` accepts) plus `list-panes -F` for coordinates; `%window-add/close`,
  `%session-window-changed`, `%window-pane-changed` drive a window/pane picker with no polling.
  Flow control with `refresh-client -f pause-after=N` and `%pause`/`%continue`; handle `%exit "too far
  behind"`.
- Browser: one xterm.js per pane positioned by layout; the pane terminal is now the *screen model* (alt
  screen, cursor, wrap all done by xterm.js from raw bytes) — no double buffer, no `bottomAlignedSnapshot`.
- Input can stay exactly as today (`send-keys -l` via `TmuxAdapter`), or be written as `send-keys`
  commands on the control client's stdin (request/response, ordered).

Interaction with size yield — the cleanest of the options: a control client that never issues
`refresh-client -C` "do[es] not affect the size of other clients no matter the value of the window-size
option" (wiki), and `clientLimit()` already skips clients reporting < 2×2 (`adapter.ts:91`, comment
"control-mode clients that never published a size do not count"). So the console can keep sizing panes
with `resize-window`/`resize-pane` as now, or opt in with `refresh-client -C WxH` and let tmux treat
the browser like a terminal. `pause-after` also solves the backgrounded-phone case that Option B lacks.

What breaks: ADR 0001 — nothing (or better: `refresh-client -B rac:%*:#{@rac_attention}` turns the
pane-option poll into `%subscription-changed` events, "at most once a second"). ADR 0006 — nothing as
long as `capture` still runs for the question check. The sanitiser boundary moves to the browser as in
B. Existing JS support is thin (§2.2), so RAC writes the parser; `@promptctl/tmux-control-mode-js` and
tabby-tmux are the references. One long-lived process per viewed session replaces 2 Hz spawns.

Mobile: same layout question as A (pane tabs vs grid); byte streams are smaller than frames when idle
and `pause-after` bounds bursts.

### Option D — pipe-pane streaming instead of polling (single pane, today's view)

`pipe-pane -O -t %N '<command>'` connects the pane's output to a command's stdin — a fifo or a socket the
console reads — giving the same raw bytes as `%output` without a client. It does **not** replay the
current screen (seed with `capture-pane` first), only one pipe may exist per pane ("A pane may only be
connected to one command at a time"; an operator's `pipe-pane -o` toggle binding would close RAC's), and
the pipe is a visible pane property. Under the host bridge the command runs where the tmux server runs,
which is the right side (`runShell` relies on the same fact, `adapter.ts:320-322`). agentboard ships it
as `TERMINAL_MODE=pipe-pane` for "daemon/systemd/docker without `-t`".

Composition: D + A gives streaming for N panes with N pipes and still needs `list-panes` polling for
layout; D is strictly a subset of C (control mode gives every pane's bytes plus layout/window events
from one process), so D only makes sense if the console wants streaming without adopting a long-lived
tmux client. Either way the browser becomes the screen model and the `reset`-frame pipeline
(sanitise, dedup, double buffer, snapshot cache, `bottomAlignedSnapshot`) is replaced rather than
extended. ADR 0001/0006 unaffected.

### Option E — Other credible shapes

1. **Zellij-style server-side render** is Option B by another name: the multiplexer draws everything and
   the browser gets one ANSI stream. tmux offers no equivalent of Zellij's "client code as translation
   layer" other than a real client in a pty.
2. **Hybrid: snapshots for content, control mode for events.** Keep today's capture/reset pipeline
   (mobile-proven, cached, sanitised) and add a control client with `-f no-output` per server that emits
   `%layout-change`, `%window-*`, `%session-window-changed`, `%pane-mode-changed` and
   `%subscription-changed` for `@rac_*`. Use it to (a) trigger an immediate capture instead of waiting
   for the next 500 ms tick, (b) render a window/pane picker, and (c) replace the dashboard's
   `list-panes -a` poll with subscriptions. Smallest blast radius; no change to sizing, input or ADRs.
3. **Proxy `-CC` to the browser and parse there.** Feasible (text protocol) but the control client's
   stdin accepts *any* tmux command including `run-shell`, so the server must become a command
   allow-list proxy anyway; then it may as well own the model. Not recommended.
4. **Per-viewer grouped sessions** (`new-session -t <session>`; agentboard, tmux-next) are a building
   block for B and C when independent current-window/active-pane per browser matters, at the cost of
   extra sessions appearing in the operator's `tmux ls` and the discovery scan (`listPanes` would see
   the grouped sessions' linked windows twice unless filtered by `#{session_group}`).
5. **Browser-side snapshot from a live terminal** — `@xterm/addon-serialize` can turn a streamed pane's
   framebuffer back into escape text for the existing snapshot cache/prefetch path, so B/C need not lose
   the dashboard preview.

### Comparison

| | A: per-pane capture | B: real attach in pty | C: control mode | D: pipe-pane | E2: hybrid events |
|---|---|---|---|---|---|
| Shows several panes of one window | yes (console-drawn borders) | yes (tmux-drawn) | yes (console-drawn) | with A | no (picker only) |
| Window switching without touching the operator's view | yes (capture by id) | no (client's current window) unless grouped session | yes | yes | yes |
| tmux UI: status bar, prefix keys, copy mode, mouse | no | **yes** | no (emulate what you need) | no | no |
| Size-yield logic | keep, adjust to window | inverts; needs ignore-size/grouped session and coordinator changes | keep (control client is size-invisible unless `refresh-client -C`) | keep | keep |
| ADR 0001 pane options | unchanged | unchanged | unchanged or subscriptions | unchanged | subscriptions |
| ADR 0006 inline questions (`capture` last 80 lines) | unchanged | unchanged | unchanged | unchanged | unchanged |
| Input path | unchanged (`send-keys`) | pty write; re-implement cancel routing | unchanged or via control stdin | unchanged | unchanged |
| Sanitisation boundary | server (`safeSnapshot`) | browser | browser | browser | server |
| Server process cost per viewer | 2 Hz × panes spawns | 1 long-lived client | 1 long-lived client | 1 pipe per pane + layout polls | 1 shared event client |
| Backgrounded phone tab | best (frames coalesce) | accumulates | `pause-after` | accumulates | best |
| New native dependency | none | node-pty (or helper) | none | none | none |
| Existing code reused | most | old route in git | least | parts of A | most |
| JS ecosystem support | n/a | node-pty mature | one 0.1.0 parser | n/a | same as C, smaller surface |

## Sources

Repo (all `/tachi/code/remoteagents`, branch `main` at `06621b0`): `apps/web/package.json`;
`apps/server/package.json`; `pnpm-lock.yaml:809`; `pnpm-workspace.yaml:6,10`;
`apps/server/src/tmux/adapter.ts`; `apps/server/src/tmux/command.ts`; `apps/server/src/tmux/session-name.ts`;
`apps/server/src/tmux/interactive-shell.ts`; `apps/server/src/launch/runner.ts`;
`apps/server/src/launch/service.ts:67,292-305,376-423`; `apps/server/src/discovery/service.ts:20-60,382`;
`apps/server/src/app.ts:70,84-92,1569-1730`; `apps/server/src/logs/viewport-scheduler.ts`;
`apps/server/src/config/schema.ts:58`; `apps/server/src/auth/tickets.ts:2`;
`apps/server/src/adapters/claude-questions.ts:23,75-82`; `apps/server/src/adapters/omx-panes.ts:17-44`;
`apps/server/src/prompts/service.ts:761-765`; `apps/web/src/main.tsx:4-7,230,419-424,2268-2271,3709-3712,3838-4444,5673-5680`;
`apps/web/src/client-cache.ts:23-25`; `apps/web/src/output-links.ts`; `apps/web/src/terminal-font-size.ts`;
`apps/web/e2e/agent-swap.spec.ts:113`; `docs/adr/0001…0006`; `docs/integrations.md`; `CONTEXT.md:45-90`;
`README.md:85-115`; git: `488a34d`, `6f464e2`, `3c6e70a`, `8a4253b`, `229514f`, `6677bdf`, `174a3d1`.

tmux: `tmux -V` → 3.7b (`~/.local/share/mise/installs/tmux/3.7b/tmux`; no man page installed);
https://raw.githubusercontent.com/tmux/tmux/3.7b/tmux.1 rendered with `man -l` (sections CLIENTS AND
SESSIONS, WINDOWS AND PANES, OPTIONS, FORMATS, EXIT MESSAGES, CONTROL MODE);
https://github.com/tmux/tmux/wiki/Control-Mode; https://github.com/tmux/tmux/wiki/FAQ.

External: https://iterm2.com/documentation-tmux-integration.html; https://github.com/xtermjs/xterm.js;
https://xtermjs.org/docs/api/terminal/classes/terminal/; addon READMEs for `addon-attach` and
`addon-serialize`; npm registry via `npm view`/`npm search`; GitHub REST via `gh api repos/<owner>/<repo>`
and `gh search repos`; READMEs of promptctl/tmux-control-mode-js, niletry/tmux-next, cwalv/tmuxcc-driver,
libtmux/libtmux-ts, ashutoshpw/tmux-web, Willlee11/tmux-weblink, ruanimal/tabby-tmux, ha-D/hypermux,
nickgnd/tmux-mcp, max-konin/termwire, tsl0922/ttyd (+ wiki Example-Usage), sorenisanerd/gotty,
butlerx/wetty, ekzhang/sshx (+ root `package.json`), tmate-io/tmate, owenthereal/upterm,
smtg-ai/claude-squad, asheshgoplani/agent-deck, BloopAI/vibe-kanban, omnara-ai/omnara, Ark0N/Codeman,
receptron/mulmoterminal, my-claude-utils/clsh, gbasin/agentboard, eneskirca/nodeterm;
https://zellij.dev/documentation/web-client.html; https://zellij.dev/news/web-client-multiple-pane-actions/;
https://poor.dev/blog/building-zellij-web-terminal/ (Zellij author's architecture write-up).

Unreachable or empty: https://tmate.io/ (HTTP 503 on two attempts) and the `tmate-io/tmate-websocket`
README (no content) — tmate web-viewer claims are therefore unverified; https://xtermjs.org/docs/ index
page returned only navigation (the API page above was used instead);
`raw.githubusercontent.com/gbasin/agentboard/main/README.md` 404 (read via `gh api …/readme` instead).
