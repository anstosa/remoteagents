# Pane output and input: what the console does today, what first-class terminals need, and the options

How pane content reaches the browser and keystrokes reach tmux in the console today, why input feels
slow and scrolling is paged, and which mechanisms (tmux control mode, a real attached client over a
pty, per-pane snapshots, `pipe-pane`) could carry the desired end state: any pane of an Agent's tmux
session shown as a first-class panel next to the agent, notes and browser; wheel and touch scrolling
through history; keystroke echo that feels local; and fidelity for heavy TUIs such as neovim.
Gathered 2026-09-06 on branch `terminal` (tip `5f105e4`) for the terminal-panes exploration; the
latency probe in Appendix A was run on the host the same day and its figures are in §1.8.

**Sources.** Console code is cited as `path:line` at `5f105e4`. tmux facts come from the host's tmux
(`tmux -V` = 3.7b; the image installs Debian's `tmux` package, `Dockerfile` L25) and the mdoc source of
`tmux.1` at upstream commit `2677466` (2026-08-25, checked out at `/tmp/tmux-man-src/tmux.1`), cited as
`tmux.1 § SECTION` or `tmux.1 <command>`. xterm.js facts come from the xtermjs/xterm.js repository at
the `5.5.0` tag (the version the web app locks, `pnpm-lock.yaml` L818) and the xtermjs.org guides;
node-pty and prior-art facts from those projects' repositories and npm registry metadata; each is cited
inline. Everything marked `probe:` is measured by the script in the appendix, which needs a live tmux
and so runs outside the sandbox. A 2026-09-04 note on the same ground, `browser-tmux-interaction-
options.md` beside this file (recovered from a stash on main and committed as superseded), is folded
in here where its conclusions still hold, with corrections marked.

## TL;DR

- **Slow input is the poll, not `send-keys`.** Echo waits for the next 500 ms tick and then a 750 ms
  reset throttle (`app.ts:1713`), so it lands 500-1000 ms later and never under one tick; live
  output is sampled at about 1 Hz. Measured: a spawned tmux command costs 1.3 ms, the same command
  over a control-mode connection 0.05 ms, and a keystroke's echo comes back through control mode in
  0.11 ms (§1.8). Tuning the loop caps the gain at one tick; only a push channel removes it.
- **Paged history is structural.** The two xterms run with `scrollback: 0`, wheel and touch are
  swallowed, and pages are server-side slices of a 5,000-line capture whose line numbers tmux
  itself shifts as history is trimmed. Native scrolling needs a byte stream feeding an xterm with
  scrollback; the snapshot model cannot feed one.
- **tmux control mode carries everything the brief asks for, without node-pty.** One `tmux -C
  attach` per session over pipes gives the raw pty bytes of *every* pane in the session, layout
  and mode events, per-pane pause/continue, and a client that is size-invisible until it declares
  a size, so the yield-to-smallest sizing survives. iTerm2 has run this model since control mode
  appeared in tmux 1.8 (2013); dsh-tmux-cc does it with xterm 5.5. Input is `send-keys -H` on the
  same connection, byte-exact and spawn-free.
- **A real attached client (the removed `/ws/terminal` route) fits "full tmux in a tab", not "a
  pane next to my agent".** Clients display windows, copy-mode scrolling is shared with every other
  client, and every viewer would count for window sizing. node-pty 1.1.0 has no Linux prebuilds
  and `script(1)` cannot be resized from outside, so that path also costs a native build.
- **xterm.js 5.5 already scrolls natively**; our `scrollback: 0` is what turns wheel into arrow
  keys. Mouse reports arrive on `onData` and `onBinary`; `@xterm/headless` + serialize is how VS
  Code replays a terminal to a late viewer. Stay on 5.5 (6.0 regressed touch), DOM renderer and
  `screenReaderMode` on phones, WebGL optional on desktop; kitty keys are absent until 7.0.
- **Recommendation:** option C in two slices. First a control client per session that makes
  captures event-driven and hosts a pane picker on today's renderer (no wire change, spawns gone,
  echo in tens of ms). Then stream bytes into scrollback-enabled xterms and retire the double
  buffer, sanitiser, paging and scroll containment. Three probes first: the latency script
  (ready), a throwaway stream spike with neovim on desktop and phone, and a standalone HTML panel
  prototype.
- **Traps recorded in §3.6 and §7:** never turn a pane `off` when the console is the only client
  (the program blocks), re-seed after `%pause`, suppress xterm's automatic replies to device
  queries, and use `-C` (pipes) not `-CC` (needs a tty).

## 1. What the console does today

The console never attaches a tmux client. It treats tmux as a database it polls (`capture-pane`,
`display-message`, `list-clients`) and writes to (`send-keys`, `resize-window`), one spawned `tmux`
process per operation (`apps/server/src/tmux/command.ts:24`, `run()` = `child_process.spawn` with a
5 s kill timer). Everything below follows from that choice.

### 1.1 Output: one snapshot poll per viewer

- Each browser tab that shows an Agent opens `/ws/logs/:id` (`apps/server/src/app.ts:1660`). The
  handler owns a `setInterval` at `config.pollIntervalMs` (`app.ts:1767`; schema default 500 ms, floor
  250 ms, ceiling 10 s, `apps/server/src/config/schema.ts:72`).
- Every tick does two things. First `refresh()` re-reads the pane geometry and re-targets the size
  (`tmux.size()` = one `display-message ; list-clients` process, `apps/server/src/tmux/adapter.ts:211`),
  through the `PaneViewportCoordinator` lease (`apps/server/src/logs/viewport-scheduler.ts`). Then
  `poll()` captures the pane: normally `captureRecentWindow` (`adapter.ts:141`, `capture-pane -e -p -S
  -(rows+24)`), or every 30 s (`logMetadataRefreshMs`, `app.ts:70`) and whenever the viewer is paged
  into history, `captureWindow` (`adapter.ts:154`, `capture-pane -e -p -S -5000`). So a live viewer
  costs two tmux process spawns per tick, roughly four per second per tab.
- The capture is sanitised by `safeSnapshot` (`adapter.ts:14`): only SGR (`CSI … m`) escapes survive;
  every other CSI, OSC, DCS, cursor movement and control byte is dropped. What the browser gets is
  "styled text", not a terminal stream. Trailing blank rows are moved above the content
  (`bottomAlignedWindow`, `adapter.ts:42`) so short output sits at the bottom of the viewport.
- `logFrame` (`app.ts:85`) sends a frame only when the text changed, and always as `type: 'reset'`
  (the whole viewport); the `append` type still exists in the wire format but the server never
  emits it. A non-immediate frame is also dropped if the previous one went out less than 750 ms ago
  (`app.ts:1713`). With the 500 ms tick that means at most one frame per second while output is
  changing continuously: the tick at t+500 is inside the 750 ms window and is skipped.
- Multiple viewers of the same pane each run their own loop and their own captures; nothing is
  shared server-side except the per-pane viewport lease.

### 1.2 Input: one spawned `send-keys` per chunk

- Keystrokes go over a second socket, `/ws/input/:id` (`app.ts:1805`), as base64url JSON frames of at
  most 64 KiB. The handler decodes, takes an Agent mutation counter (`prompts.beginAgentMutation`,
  `apps/server/src/prompts/service.ts:153`; a counter, not a lock, so it adds no waiting), and calls
  `tmux.input()` (`adapter.ts:290`), which serialises per pane and then spawns one `tmux send-keys -l
  -t %pane <text>` per chunk, with newlines and `\x03` translated to the key names `Enter` and `C-c`
  (`adapter.ts:303`). A lone `\x03` is first routed through queue cancellation (`app.ts:1805`).
- The browser side is `terminal.onData` on both xterm instances (`apps/web/src/main.tsx:4285`),
  with the mobile modifier bar folded in, and a Tab/Shift-Tab special case in
  `attachCustomKeyEventHandler` (`main.tsx:4137`). The input socket is opened lazily on the first
  click into the output ("output mode") or immediately in terminal mode (`main.tsx:4031`).
- Adapter-composed key sequences (submit, interrupt, option select) take a separate path,
  `sendKeys` (`adapter.ts:251`), one `send-keys` process per key with a 120 ms pause after `Escape`
  so a following key is not read as Meta.

### 1.3 Rendering: two xterms, no scrollback, whole-frame double buffering

- `Log` creates two `@xterm/xterm` 5.5.0 instances with `scrollback: 0`, `convertEol: true`, and
  `screenReaderMode` on coarse pointers (`main.tsx:4003`), each with a `FitAddon`; no WebGL or canvas
  addon is loaded (`apps/web/package.json`).
- A `reset` frame is rendered by `renderSnapshot` (`main.tsx:4368`): the hidden instance is
  `reset()`, then written a synthetic screen `ESC[H` + bottom-aligned lines each ending in `ESC[K` +
  `ESC[J` (`main.tsx:4382`), and once xterm's write callback fires the visible/hidden roles swap and
  the now-hidden instance is reset on the next animation frame. While the user has focus in the
  output ("output mode") the frame is redrawn into the focused instance instead, so mobile
  keyboards stay open. Selection in either instance defers rendering until it clears.
- Wheel and touchmove over the output are `preventDefault`ed and stopped (`containOutputScroll`,
  `apps/web/src/output-scroll.ts:1`, wired at `main.tsx:4008`; e2e `output-scroll.spec.ts` asserts
  this), and xterm's own viewport scrollbar is hidden (`apps/web/src/styles.css:541`). There is no
  local scrollback to scroll; the viewport is always exactly the tmux pane.
- Link detection, the selection toolbar, copy shortcuts, the font-size store and the theme all
  operate on the two instances and survive a frame swap by being attached to both.

### 1.4 History: server-side pages

- Paging is a `history` frame on the log socket carrying a row offset (`app.ts:1780`): the server
  captures 5,000 history lines and slices `rows` lines ending `offset` lines above the bottom
  (`adapter.ts:154`), bottom-aligned, and reports `older`/`newer` flags. The browser steps by
  `rows - 5` per page (`moveHistory`, `main.tsx:4056`) so adjacent pages overlap by five rows.
- The comment at `adapter.ts:156` records why the console slices its own capture instead of using
  `-S`/`-E` line ranges: tmux's coordinates shift around wrapped and blank rows, so page offsets
  computed from them were not stable.
- While paged, every tick is a 5,000-line capture, and the live tail is not shown until the viewer
  returns to offset 0.

### 1.5 "Swap to terminal" is Ctrl+Z on the agent's own pane

- The swap button (`main.tsx:2286`) posts `/api/agents/:id/background` (`app.ts:969`), which is
  `tmux.suspend` (`adapter.ts:267`): `send-keys C-z`, then poll `#{pane_current_command}` up to
  20 × 25 ms until it is a shell, else `kill -CONT` the job and report failure. The same `Log`
  component remounts with `terminalMode` (`main.tsx:5012`): the only differences are focus, an
  immediately-opened input socket, and skipping the metadata/question parsing. `/foreground`
  (`app.ts:1029`) types `^U fg ⏎` into the pane (`adapter.ts:283`).
- So there is exactly one pane per Agent the console can show, the Agent's own; a "terminal" is
  that pane with the agent stopped. This is why the zsh/bash bootstrap around every launched agent
  is load-bearing: job control is what makes `C-z`/`fg` work
  (`apps/server/src/tmux/interactive-shell.ts`).
- The old full-attach route (`/ws/terminal/:id`) spawned `tmux attach-session` in a node-pty and
  streamed its bytes; it was removed in `6677bdf` (2026-09-03) as never used by the web, together
  with the `node-pty` dependency. `pnpm-workspace.yaml` L6 and L10 still list `node-pty` in the
  build allow-lists, and `TmuxAdapter.attachArgs` (`adapter.ts:344`) is dead code.

### 1.6 What else rides the snapshot channel

Any replacement has to keep feeding these, or move them to their own poll:

- **Inline questions** are parsed server-side from the captured text on every frame and sent with
  it (`app.ts:1721`; ADR 0006 for Claude's reported payload).
- **Turn metadata** (`lastPrompt`, `latestAgentMessage`, `latestAssistantMessage`) is parsed from
  the 5,000-line capture every 30 s (`adapter.ts:166`, `codex-turns.ts`) and drives prompt history,
  notes ("save response") and the response-file links.
- **The tab cache** (`logSnapshots`, `main.tsx:241`) stores the last frame per Agent so a
  re-opened tab paints instantly before its socket connects.
- **Attention state** is not on this channel: it is read from pane options in the dashboard poll
  (ADR 0001).

### 1.7 Sizing: the browser drives the pane, and yields to attached clients

- The browser tells the server its grid (`viewport` frame); the server pins the window at that size
  with `resize-window -x -y` then `resize-pane` (`adapter.ts:175`), keeping companion panes' share
  of the window, and the coordinator (`viewport-scheduler.ts`) clamps every request to the smallest
  attached tmux client (mirroring tmux's own `ignore_client_size()` rules: suspended clients and
  control-mode clients that never published a size do not count; `adapter.ts:79`). On release it
  unsets `window-size` so tmux sizes the window again (`adapter.ts:227`).
- `window-size` therefore flips between `manual` (browser attached) and the operator's default; a
  real tmux client attached at the same time sees the pane at the browser's size or smaller
  (see the yield-pane-size work, `viewport-scheduler.ts` comments).

### 1.8 Where the input latency comes from

Keystroke → echo on screen today passes through: input socket → spawn `send-keys` → pane pty →
tmux screen → wait for the next poll tick (0–500 ms) → possibly wait out the 750 ms reset throttle →
spawn `capture-pane` (plus the `size()` spawn ahead of it) → sanitise → JSON frame → xterm
`reset()`+`write()` of the whole viewport → buffer swap on the write callback. The dominant terms are
the poll tick and the throttle, not the spawn: the expected echo delay is on the order of 500–1000 ms
and never below one tick, regardless of how fast tmux itself is.

`probe:` on this host (tmux 3.7b, Node v24.18.1, 40 samples each, 2026-09-06), one spawned tmux
process per command:

| command | median | p90 |
|---|---|---|
| `send-keys -l` (1 char) | 1.18 ms | 1.38 ms |
| `capture-pane -e -p -S -60` | 1.31 ms | 1.38 ms |
| `capture-pane -e -p -S -5000` | 1.33 ms | 1.43 ms |
| `display-message ; list-clients` (size read) | 1.39 ms | 1.54 ms |

So the whole spawn-and-capture path costs under 3 ms of the 500-1000 ms the user waits; the rest is
the tick and the throttle.

`probe:` the same commands over one control-mode client (`tmux -C attach` over pipes, same run):

| command | median | p90 |
|---|---|---|
| `send-keys -l`, reply only (`%end`) | 0.05 ms | 0.10 ms |
| `capture-pane -e -p -S -60` | 0.06 ms | 0.08 ms |
| `capture-pane -e -p -S -5000` | 0.06 ms | 0.07 ms |
| `display-message` layout | 0.07 ms | 0.08 ms |
| **`send-keys -l` → `%output` echo, full round trip** | **0.11 ms** | **0.15 ms** |

A control-connection command is about 25× cheaper than a spawn, and a keystroke's echo is back in a
tenth of a millisecond, so on a streaming design the browser's WebSocket round trip is the whole
budget. The burst test confirmed the pane-coverage claim on this host: 2,000 lines written by a pane
in a second, **non-active** window arrived as 13 `%output` lines for `%1`, all within 7 ms of the
program starting, alongside 4 other notifications (`%window-add`, `%layout-change`, and friends).

Two consequences: typing in a shell shows keystrokes in bursts once a second, and a TUI redrawing
at 60 Hz is sampled at 1 Hz with each sample re-rendering the whole viewport.

### 1.9 The panes the console knows about

Discovery lists every pane on every socket (`list-panes -a`, `adapter.ts:109`) but publishes only
panes whose process tree an Adapter recognises (`discovery/service.ts:374`); everything else is
invisible to the web. Panes that exist in or next to an Agent's session today and would be
candidates for a first-class terminal panel:

- the Agent's own pane (the only one shown today);
- OMX HUD watcher and team worker panes in the same window (hidden by
  `adapters/omx-panes.ts`; the resize code already accounts for their share of the window);
- the idle shell the console starts per Worktree (`launch/service.ts:428`, a session of its own
  running the interactive shell), which an Agent launch later adopts;
- the Project's stack-command session (`CONTEXT.md` "Stack commands");
- any pane the operator splits or opens by hand in the Agent's session.

## 2. What the end state needs

Restating the brief as requirements the options are scored against, plus the constraints the
codebase already imposes.

- **R1 First-class terminals.** Any pane of the Agent's session can be shown as a panel beside the
  agent, notes and browser (the existing three-way `log-split`, `main.tsx:3599`), on desktop and as a
  mobile switch target; switching and combining is cheap. A shell next to the agent is the common
  case; the agent keeps running.
- **R2 Local-feeling input.** Keystroke echo should be bounded by network round trip, not by a poll
  tick. Chords, Escape sequences and application-cursor keys must arrive as the program expects.
- **R3 Native scrolling.** Wheel and touch scroll the pane's history in place, in both agent and
  terminal panels, with the live tail resuming when scrolled back to the bottom. Paging buttons go
  away or become a fallback.
- **R4 Heavy TUIs.** neovim, `less`, `htop`: alternate screen, cursor movement, partial redraws,
  mouse reporting, key chords, at redraw rates well above 1 Hz, without flicker.
- **C1 Multiple viewers.** Two browsers (or a browser and a phone) on the same pane are normal;
  today's yield-to-smallest-client sizing must survive.
- **C2 The snapshot consumers** (§1.6) keep working: questions, turn metadata, tab cache.
- **C3 tmux is the source of truth** (ADR 0001): no state that dies with the console, and nothing
  that needs a pty-per-viewer unless it buys something specific.
- **C4 Security posture.** Every socket is ticket-gated and per-Agent (`auth/tickets.ts`); a pane
  selector widens the target from "the Agent's pane" to "a pane in the Agent's session", so the
  server must own the allowed set.
- **C5 Mobile.** iOS/Android software keyboards, touch selection, and the double-buffer trick that
  keeps the keyboard open all live in `Log`; a new renderer must not regress them.

## 3. What tmux offers (tmux 3.7b, `tmux.1` at `2677466`)

### 3.1 Control mode

- A control client is a normal client started with `-C` (`-CC` disables echo) that speaks a
  line-oriented text protocol on stdin/stdout: commands in, one `%begin … %end|%error` block per
  command out, and notifications between blocks (`tmux.1 § CONTROL MODE`). It needs no pty; pipes
  are enough (the probe attaches with `stdio: pipe`).
- Notifications that matter here (`tmux.1 § CONTROL MODE`): `%output pane-id value` (a pane produced
  output; non-printables and backslash are escaped as octal `\ooo`), `%extended-output pane-id age
  … : value` (the form used when `pause-after` is set; `age` is how long tmux buffered it),
  `%layout-change window-id layout visible-layout flags`, `%window-add`, `%window-close`,
  `%window-pane-changed`, `%pane-mode-changed pane-id` (copy mode entered or left),
  `%session-window-changed`, `%subscription-changed name … : value` (a `refresh-client -B`
  format subscription changed, reported at most once a second), `%pause`/`%continue pane-id`,
  `%exit`.
- Per-pane flow control: `refresh-client -A %pane:on|off|continue|pause` turns a pane's output to
  this client on or off, pauses it, or continues it; when every client has turned a pane off tmux
  stops reading from that pane (`tmux.1 refresh-client`). Client flags set at attach or with
  `refresh-client -f` include `no-output` (receive no pane output at all), `pause-after=seconds`
  (tmux pauses a pane that falls that far behind, and says so with `%pause`), `ignore-size` (the
  client does not affect other clients' size), `read-only`, `wait-exit` (`tmux.1 attach-session`).
- Size: `refresh-client -C WxH` or `-C @win:WxH` sets the size of a control client, or of one window
  for it (`tmux.1 refresh-client`). The console's own comment at `adapter.ts:79` records tmux's
  rule that a control client that never published a size is ignored by `window-size`
  calculations, which is what makes a "read-only observer" control client size-invisible and keeps
  the yield-to-smallest logic intact.
- Subscriptions: `refresh-client -B name:what:format` with `what` = a pane id, `%*` (all panes of the
  attached session), a window id, or `@*`, reports changes to any format string through
  `%subscription-changed`, at most once a second (`tmux.1 refresh-client`). That is a push channel
  for `#{@rac_attention}`, `#{pane_current_command}`, `#{alternate_on}`, `#{history_size}`,
  `#{pane_in_mode}` and friends, replacing polls.
- What `%output` does not carry: the screen a pane already had when the client attached. A client
  therefore seeds each pane with `capture-pane` and then follows `%output`. The escaping is octal for
  bytes below 0x20 and above 0x7e, so UTF-8 arrives as `\303\251`-style triplets to decode.

### 3.2 Reading a pane

- `capture-pane -p -e -t %pane -S -N` prints the last N history lines plus the visible screen with
  SGR escapes; `-S -` / `-E -` are the start of history and end of the visible pane; `-a` reads the
  alternate screen (history is then inaccessible; `-q` silences the error when there is none); `-M`
  reads the mode screen when the pane is in a mode; `-N` keeps trailing spaces, `-J` joins wrapped
  lines, `-C` escapes non-printables, `-T` trims trailing empty cells; `-P` captures a pending
  incomplete escape sequence (`tmux.1 capture-pane`). There is no flag that emits cursor position or
  the pane's current modes; those come from formats: `#{cursor_x}`, `#{cursor_y}`, `#{alternate_on}`,
  `#{pane_in_mode}`, `#{pane_mode}`, `#{scroll_position}`, `#{history_size}`, `#{history_limit}`
  (`tmux.1 § FORMATS`).
- `pipe-pane -O -t %pane cmd` connects the pane's output to a command's stdin; one pipe per pane,
  replacing any existing one; `-I` connects the command's stdout to the pane's input
  (`tmux.1 pipe-pane`). It is a byte tap with no per-client fan-out and no back-pressure semantics
  beyond the pipe; a second viewer needs the server to fan out.

### 3.3 Writing to a pane

- `send-keys -t %pane key…` sends key names, or literal UTF-8 with `-l`, or hex bytes with `-H`;
  all arguments in one command are sent in order; `-M` forwards a mouse event (only from a mouse
  key binding); `-X` sends a copy-mode command; `-N` repeats (`tmux.1 send-keys`). Whether a chord
  in one command is read as Meta is the reason `sendKeys` sends one key per process today
  (`adapter.ts:247`).
- `extended-keys on|off|always` controls whether modified keys are reported to the pane program in
  the xterm `modifyOtherKeys` style, which programs like neovim negotiate (`tmux.1 extended-keys`).
  Keys the console injects via `send-keys` bypass the client terminal's key encoding entirely; tmux
  encodes them for the pane according to the pane's requested modes.

### 3.4 Scrolling and the mouse

- With `mouse on`, wheel and button events over a pane become bindable keys (`WheelUpPane`,
  `MouseDown1Pane`, …) and `send-keys -M` forwards them to the pane program (`tmux.1 § MOUSE
  SUPPORT`). The default bindings scroll history by entering copy mode on the wheel.
- `copy-mode -t %pane` enters copy mode on a pane without it being active; `-e` exits it again when
  scrolling reaches the bottom; `-u`/`-d` enter and page; `send-keys -X scroll-up|scroll-down|
  page-up|halfpage-up` with `-N count` moves the view; `#{scroll_position}` and `#{pane_in_mode}`
  report it; `%pane-mode-changed` announces it (`tmux.1 copy-mode`, `send-keys`, `§ FORMATS`). A
  pane in copy mode is in copy mode for every client: an attached terminal sees it scroll too,
  and live output is held until the mode exits. That is the price of scrolling "inside tmux".

### 3.5 Sizing

- `window-size largest|smallest|manual|latest` picks which attached client sizes a window;
  `aggressive-resize` sizes by the sessions where the window is current; `attach-session -f
  ignore-size` excludes a client (`tmux.1 window-size`, `aggressive-resize`, `attach-session`).
  Control clients participate once they call `refresh-client -C`.

### 3.6 What the tmux source adds (tag `3.7b`; current release is 3.7c with no control-mode changes)

- `%output` is the pane's pty read buffer **before** tmux's own parser sees it (`window.c` L1137-1162,
  `control.c` L634): alternate-screen switches, mouse-mode enables, DCS, everything the program wrote,
  for the `TERM` the pane has (`tmux-256color`), not a re-render (wiki Control-Mode L142-147).
  Only bytes below 0x20 and backslash are octal-escaped; bytes ≥ 0x80 are copied verbatim
  (`control.c` L638-646), so UTF-8 must be reassembled at the byte level before decoding.
- It is delivered for **every pane whose window is linked in the client's session, visible or not**
  (`control.c` L474-481; the read callback offers each pane's data to every attached control client,
  `window.c` L1156-1158). There is no window filter other than `refresh-client -A %p:off`.
- Commands typed by a control client go straight onto the server's command queue with no
  fork/exec (`control.c` L553-577); a spawned `tmux send-keys` reaches the same queue over the
  client socket, so semantics are identical and only the process is saved.
- A plain `-C` client works over pipes: the client sends an empty tty name, reads terminfo only when
  stdin is a tty, and the server wraps the two fds in bufferevents (`client.c` L306-328, L477-482;
  `control.c` L771-808). `-CC` calls `tcgetattr` on stdin and exits without a tty (`client.c`
  L344-361); the wiki calls single `-C` "intended for testing" only because a real tty would echo,
  which pipes do not. Use `-C`.
- Sizing: `ignore_client_size()` skips a control client until it has run `refresh-client -C WxH`
  (`CLIENT_SIZECHANGED`) or `-C @w:WxH` (`CLIENT_WINDOWSIZECHANGED`, per window); control clients
  never reserve a status line (`resize.c` L69-96, L447-454). Per-window sizes for a control client
  are what iTerm2 uses to give each tab its own size (`TmuxController.m` L1080).
- Flow control: per-client and per-pane queues with 512/8192-byte watermarks (`control.c` L30-45,
  L131-135); without `pause-after` a client 300 s behind is dropped as "too far behind" (L456-468).
  With `pause-after=N` the pane's queue is **discarded** at `%pause`, and `-A %p:continue` resumes
  from the pane's current position, so the client must re-seed with `capture-pane` (L364-391; wiki
  L221-225). tmux stops reading a pane only when every attached client is a control client that
  cannot accept its data (`server-client.c` L1662-1747): if the console is the only client and it
  turns a pane `off` or lets it pause, **the program in that pane eventually blocks on write**.
  Panes nobody is viewing must stay `on` and be discarded server-side, never `off`.
- Seeding gaps: `capture-pane` has no way to emit the parser's pending pen (the SGR the next byte
  will take) or a half-received escape sequence except `-P`; every other mode is a format
  (`cursor_flag`, `cursor_shape`, `insert_flag`, `keypad_cursor_flag`, `mouse_*_flag`,
  `mouse_sgr_flag`, `wrap_flag`, `bracket_paste_flag`, `pane_key_mode`, `scroll_region_*`,
  `synchronized_output_flag`, `alternate_on`, `tmux.1 § FORMATS` L6460-6700). `-e` emits an SGR
  delta only where a cell differs from the previous one and threads the pen across lines
  (`grid.c` L1084-1166; `cmd-capture-pane.c` L157, L252), so captured lines must be replayed in order.
  While `alternate_on` is 1 a plain capture returns the full-screen program's screen and `-a` the
  saved primary screen (`screen.c` L676-704; `cmd-capture-pane.c` L168-176).
- History coordinates are not stable: once `history_size` reaches `history-limit` (default 2000,
  `options-table.c` L677-683) tmux frees a tenth of the history from the top (`grid.c` L385-408),
  so negative line numbers shift and no persistent line id exists. This is the root of the paging
  instability the console worked around in `adapter.ts:156`.
- Copy mode shows a clone of the screen taken at entry and re-clones only on `refresh-from-pane` or
  resize, while the pane keeps parsing output unseen (`window-copy.c` L368-477, L2788-2820;
  `input.c` L1034-1043). A control client keeps receiving raw `%output` regardless (`window.c`
  L1156-1160), so a browser with its own scrollback never needs copy mode at all.
- `send-keys -H` writes bytes verbatim (`KEYC_LITERAL`, `input-keys.c` L585-589); `-l` writes
  ESC, CR, TAB and 0x20-0x7f verbatim and Unicode as UTF-8, but routes other C0 bytes through key
  translation whose output depends on the pane's key mode (L631-712). Raw mouse reports injected
  with `-H` or `-l` reach the program unchanged; tmux's own `send-keys -M` needs a mouse key binding
  and errors from a control client (`cmd-send-keys.c` L204-211), so the browser must encode
  pane-relative SGR reports itself and honour `#{mouse_sgr_flag}`/`#{mouse_any_flag}`.
- With `extended-keys on`, tmux builds CSI-u/`modifyOtherKeys` encodings only for modified keys it
  translates (`input-keys.c` L426-480, L680-706); raw bytes bypass this. A program that asked for
  extended keys (`#{pane_key_mode}`) still accepts legacy encodings for keys that have one.
- `pipe-pane` taps the same pre-parser bytes (`window.c` L1141-1160) but is one pipe per pane,
  replaces any pipe the operator set, has no pause or watermark (data accumulates in tmux memory),
  and is a forked shell command per pane (`cmd-pipe-pane.c` L77-184).

## 4. What xterm.js offers (5.5.0, the locked version)

All citations are to the `5.5.0` tag of xtermjs/xterm.js (raw source, line numbers of those files),
the npm registry, and the xtermjs.org flow-control guide.

### 4.1 Scrolling is native, and our `scrollback: 0` is what turns it off

- `scrollback` is the number of rows kept above the viewport, default 1000 (`xterm.d.ts` L242-247).
  The normal buffer's length is `rows + scrollback`; the alternate buffer never has scrollback
  (`Buffer.ts` L106-113, `BufferSet.ts` L42-44). `Buffer.hasScrollback` is false whenever
  `scrollback` is 0 (`Buffer.ts` L91-92).
- The viewport is a real DOM scroll container whose height is `rowHeight × buffer.lines.length`;
  a native `scroll` listener maps `scrollTop` back to a row and calls `scrollLines`, and while the
  user is scrolled up new output advances the buffer but not the view (`Viewport.ts` L120-139,
  L179-200; `BufferService.ts` L90-101, L128-150). `onScroll` reports the new top row; `scrollToBottom`,
  `scrollToLine`, `scrollPages` are public (`xterm.d.ts` L953-958, L1175-1201).
- **Wheel** (`Terminal.ts` L800-833): if the program has enabled wheel mouse reports, xterm emits a
  mouse report instead (see 4.2); else if `attachCustomWheelEventHandler` returns false, nothing;
  else **if the buffer has no scrollback the wheel is converted to arrow keys** (`CSI A/B`, or
  `SS3 A/B` under DECCKM, one per line; comment: "enables scrolling in apps hosted in the alt
  buffer such as vim or tmux", L808-826); else the viewport scrolls (L830). With today's
  `scrollback: 0`, every wheel tick over the live pane would be typed into the agent as arrow keys,
  which is why `containOutputScroll` has to swallow it. `attachCustomWheelEventHandler` arrived in
  5.4.0 (release notes, #4913/#4915) and is consulted on both paths (L804, L642-644).
- **Touch** (`Terminal.ts` L835-846; `Viewport.ts` L380-400): `touchstart` records `pageY`,
  `touchmove` applies the delta to `scrollTop` directly (no momentum) and `preventDefault`s only
  while there is room to scroll. Both are skipped when mouse reporting is on. There is no
  touch-to-arrow conversion in the alternate buffer.
- There is no DECSET 1007 (alternate-scroll) handling in 5.5.0: `setModePrivate` handles 1, 9,
  1000-1006, 1015, 1016, 47, 1047, 1049, 2004 (`InputHandler.ts` L1857-1960). Maintainer jerch
  (#5194, 2024-10) confirms wheel-to-arrows is unconditional without scrollback and that 1007 is
  planned; PR #5728 was closed unmerged.
- Related options and their defaults (`OptionsService.ts` L22-38): `scrollSensitivity` 1,
  `fastScrollModifier` 'alt' with `fastScrollSensitivity` 5 (removed in 6.0.0, #5462),
  `smoothScrollDuration` 0 (rAF interpolation when set), `scrollOnUserInput` true (keydown snaps
  to the bottom, `Terminal.ts` L1013-1015). Shift+PageUp/PageDown scroll the viewport and are never
  sent to the program (`Keyboard.ts` L225-244; `Terminal.ts` L1027-1031).
- 6.0.0 (2025-12-22) rewrote the viewport on VS Code's platform layer (#5096), restored partial
  wheel tracking (#5391), and regressed touch scrolling (#5489, fixed for 7.0.0). Staying on 5.5.0
  is the safer base for this work; an upgrade is a separate decision.

### 4.2 Mouse reporting, for neovim and friends

- Protocols X10, VT200, DRAG (1002), ANY (1003); encodings DEFAULT (`CSI M …`, coordinates capped at
  223), SGR (1006, `CSI < b;x;y M|m`), SGR_PIXELS (1016); UTF8 and URXVT encodings were removed
  (`CoreMouseService.ts` L13-82, L121-158; `InputHandler.ts` L1899-1932). Read-only exposure via
  `terminal.modes.mouseTrackingMode` (`xterm.d.ts` L1883-1890).
- DEFAULT-encoded reports are emitted through **`onBinary`**, SGR ones through `onData`
  (`CoreMouseService.ts` L277-286); the docs say to forward `onBinary` to the pty as binary
  (`xterm.d.ts` L887-896). A host must forward both. Three buttons plus wheel; motion is
  deduplicated per cell (`Terminal.ts` L587-599; `CoreMouseService.ts` L264-270). While tracking is
  on, xterm disables its own selection (`Terminal.ts` L721-733); `macOptionClickForcesSelection`
  exists precisely "to use xterm.js' regular selection inside tmux with mouse mode enabled"
  (`xterm.d.ts` L191-198).

### 4.3 Seeding a terminal: streams only, plus the serialize addon

- The buffer API is read-only (`IBuffer`, `IBufferLine`: `getLine`, `translateToString`, cursor and
  viewport getters, `xterm.d.ts` L1461-1548). The only way to put content in is `write()`; cursor
  placement is in-band escape sequences (L1208-1226).
- `reset()` is RIS: re-runs setup, resets modes, mouse service, selection, decorations and viewport,
  keeps rows/cols and the custom key handler (`Terminal.ts` L1253-1273); the source warns it is
  synchronous and does not flush the write buffer, so a queued write can land after it
  (L1245-1252). `clear()` keeps the cursor line as line 0 and drops the rest (L1221-1243).
- `@xterm/addon-serialize` 0.13.0 (the 5.5.0 pairing) returns a string that "can be written back
  to the terminal to restore the state" including cursor position; options `scrollback` (rows from
  the bottom), `excludeModes`, `excludeAltBuffer`; if the alternate buffer is active it emits
  `CSI ?1049h`, `CSI H`, the alt content and the modes DECCKM, DECNKM, 2004, IRM, DECOM, 45, 1004,
  DECAWM-off and mouse tracking 9/1000/1002/1003 (`addon-serialize.d.ts` L22-73; `SerializeAddon.ts`
  L250-275, L466-520). It does **not** serialize the SGR mouse encoding (1006), cursor style or
  visibility, or titles.
- `@xterm/headless` 5.5.0 exists on npm: the same parser and buffers without a DOM. VS Code's pty
  host keeps one headless terminal per persistent process, feeds it every chunk and resize, and on
  reattach serializes it with `scrollback` into one `{cols, rows, data}` replay event; the renderer
  forces the recorded size, writes, awaits the write promise, and suppresses input meanwhile
  (`ptyService.ts` L944-957, L1032-1108; `basePty.ts` L90-116). That is the reference design for
  "late joiner sees the same screen" without a per-viewer pty.

### 4.4 Write throughput and flow control

- `write()` queues chunks; the first is parsed on `setTimeout(0)`, except that a write following
  user input is parsed synchronously "to minimize input latency" (`WriteBuffer.ts` L103-130,
  `CoreTerminal.ts` L134). Parsing runs in 12 ms slices then yields to the renderer (L22-28,
  L160-245). Rendering is separate and coalesced to one `requestAnimationFrame`
  (`RenderDebouncer.ts` L34-57; `RenderService.ts` L135-143), and paused while the element is not
  intersecting (`RenderService.ts` L121-131). So a 60 Hz neovim redraw stream costs parsing, and
  painting is at most once per frame regardless.
- The write buffer discards data past 50 MB and the source notes the terminal gets unresponsive
  about 100× lower, above ~500 kB pending (`WriteBuffer.ts` L13-20, L104-106). The flow-control
  guide's recipe is watermarks on the `write` callback (HIGH 100 000, LOW 10 000 bytes, or count
  pending callbacks), and it states that over WebSockets "flow control must span across the
  client-server boundary" with acknowledgment messages (xtermjs.org flow-control guide).
- `@xterm/addon-attach` 0.11.0 does none of this: `terminal.write(data)` with no callback per
  message, forwards `onData` as text and `onBinary` as bytes, no resize (`AttachAddon.ts` L27-82).
  Not worth adopting; the console's own socket layer is already richer.

### 4.5 Renderers and versions

- 5.5.0 pairs with `@xterm/addon-webgl` 0.18.0 (WebGL2; throws on Safari below 16, `WebglAddon.ts`
  L34-45; contexts can be lost and the README says to dispose the addon on `onContextLoss`) and
  `@xterm/addon-canvas` 0.7.0 (a fallback "when better performance is desired over the default DOM
  renderer, but WebGL2 isn't supported"). The canvas addon was removed in 6.0.0 (#5105). All
  5.5-era addons declare `peerDependencies: @xterm/xterm ^5.0.0`; the 6.0-era addon releases carry
  no peer range in the registry, so mixing must be checked by hand.
- Primary-source performance claims are limited to "the default DOM-based renderer is
  significantly faster now" (5.3.0 notes) and the README's "GPU-accelerated renderer". No
  maintainer-confirmed iOS Safari WebGL context-limit issue was found; Wetty simply skips WebGL on
  mobile user agents (`term.ts` L14-34), a prior-art choice rather than an xterm.js statement.

### 4.6 Mobile

- Input goes through a hidden `<textarea>` with composition handling (`Terminal.ts` L378-384,
  L444-455; `CompositionHelper.ts` L127-175); iOS hardware-keyboard arrows are special-cased
  (`Keyboard.ts` L54-83). `screenReaderMode`, which the console already enables on coarse pointers,
  keeps keydown uncancelled so the textarea updates (`Terminal.ts` L1074-1080).
- Maintainers describe mobile as a "blind spot" (jerch, #5377, 2025-07) and say touch support
  needs "the default DOM renderer and/or `screenReaderMode`" (Tyriar, same thread; #3727 for iPad).
  Android GBoard jumbled input (#3600) and IME issues (#5108, #3836) are open. Implication: keep the
  DOM renderer on phones, keep `screenReaderMode`, and do not expect WebGL there.

### 4.7 Key encoding

- `onKey` fires before `onData`; `onBinary` is mouse-only; `input()` injects as if typed
  (`xterm.d.ts` L887-919, L983-993). `attachCustomKeyEventHandler` runs on keydown, keyup and
  keypress and survives `reset()` (`Terminal.ts` L1005-1007, L1260).
- Sequences (`Keyboard.ts`): Esc `\x1b`; Enter CR (Alt+Enter `ESC CR`); Tab HT, Shift+Tab `CSI Z`;
  Backspace DEL; arrows `CSI A-D` or `SS3 A-D` under DECCKM, with modifiers `CSI 1;m A-D`; F1-F4
  `SS3 P-S`; F5-F12 `CSI 15~…24~`; Ctrl+letter 0x01-0x1A, Ctrl+Space NUL, Ctrl+[ ESC. Alt+letter
  gives `ESC letter` only when `!isMac || macOptionIsMeta` (L349-376).
- **No kitty keyboard protocol, CSI u, or modifyOtherKeys in 5.5.0**: `CSI u` is registered only
  as SCORC and there is no XTMODKEYS handler (`InputHandler.ts` L247, L264, L2875-2879). The kitty
  protocol landed in PR #5600 (merged 2026-01-10) for milestone 7.0.0. neovim's chord handling in
  the browser is therefore limited to what xterm 5.5 encodes, the same as any plain xterm.

## 5. node-pty and other ways to hold a pty

Only a real attached client (option B) needs a pty; control mode does not. For completeness:

- **node-pty** 1.1.0 (2025-12-22, MIT) ships prebuilds for darwin and win32 only; on Linux
  `scripts/prebuild.js` exits 1 and `node-gyp rebuild` runs, needing make, python and a C++
  toolchain (registry tarball listing; `scripts/prebuild.js` @v1.1.0; README L92-93). The README
  still says "Node.JS 16 or Electron 19 is required" (L88); no primary statement covers Node 22/24,
  though as an N-API addon it is expected to build. `1.2.0-beta.15` (2026-08-03) adds linux-x64 and
  linux-arm64 prebuilds. The image already carries the toolchain for `argon2` (commit `6677bdf`), so
  building is possible, just not free. Open issues: darwin `spawn-helper` exec bit (#919), Windows
  resize crash on Node 22 (#827); nothing tmux-specific beyond a 2020 artefacts report (#430).
- **`@homebridge/node-pty-prebuilt-multiarch`** 0.14.1 (2026-07-23) declares `engines >=20 <27`
  and ships Linux glibc/musl x64 and aarch64 prebuilds with node-gyp fallback (README L29-41).
  **`@lydell/node-pty`** 1.2.0-beta.15 uses per-platform optional packages and never calls
  node-gyp (README L5-17). Either is the practical choice if a pty is ever wanted.
- **`script(1)`** (util-linux) cannot substitute: with a non-tty stdin it opens the pty with no
  size and forwards no SIGWINCH (`lib/pty-session.c` L168-206, L590-592), so the child must `stty`
  itself and the console could never resize it; the man page warns the session "can hang"
  (`script.1.adoc` L163). Python `pty` and `socat EXEC:…,pty` have the same no-resize problem.
  Node's `child_process` has no pty stdio option (nodejs.org `options.stdio`). Bun has
  `Bun.spawn(cmd, { terminal })` since 1.3.5, POSIX only, irrelevant to a Node server.
- Verdict: node-pty is neither needed nor a shortcut. It would only come back with option B, and
  then as the homebridge or lydell build.

## 6. Prior art

- **ttyd** (tsl0922/ttyd, main): one pty per WebSocket, spawned from a JSON hello that carries the
  size; no replay, the client `reset()`s on reconnect (`protocol.c` L154-166, L332-353). Wire format
  is a one-byte prefix: client `0` input, `1` resize, `2` pause, `3` resume; server `0` output,
  `1` title, `2` preferences (`server.h` L8-17). Flow control: after 100 kB the client counts
  pending `write` callbacks, sends pause above 10 and resume below 4; the server pauses libuv reads
  (`xterm/index.ts` L207-227; `pty.c` L124-135). Default renderer WebGL, disposed on context loss
  with canvas fallback (`app.tsx` L13; `index.ts` L484-510).
- **Wetty** (butlerx/wetty): same shape over socket.io; the client acks every 256 KiB from the
  write callback and the server pauses node-pty above 2 MiB unacked (`client/flowcontrol.ts`;
  `server/flowcontrol.ts` L9-79). Skips WebGL on mobile user agents and sets `contenteditable` on
  the screen to summon the keyboard (`mobile.ts`, `term.ts` L14-34).
- **VS Code** (microsoft/vscode): the design for reconnecting viewers described in 4.3: a
  headless xterm per process on the pty host, serialized on reattach; flow-control constants
  High 100 000 / Low 5 000 / Ack 5 000 chars with acks sent from the `write` callback
  (`common/terminal.ts` L876-897; `terminalProcess.ts` L323-330, L579-587).
- **dsh-tmux-cc** (adrianleb, `@xterm/xterm ^5.5.0`): the closest match to option C below. Attaches
  one `tmux -C` control client per session with `ignore-size`, keeps one xterm per pane fed from
  `%output`, takes the layout from `%layout-change`/`list-panes`, seeds and refreshes each pane with
  `capture-pane -epJ -t <pane> -S -<n>`, sends input as `send-keys -H` hex, and offers a "mirror"
  (ignore-size) versus "takeover" (`refresh-client -C WxH`) sizing mode; on mobile, drags become
  synthetic wheel events "xterm interprets per pane state" (`src/tmux-client.ts` L37, L137-140,
  L192-234, L297-313, L486-495; README L146-173). Per-pane scrollback default 2000, bounded at
  20 000 lines / 800 kB, which also bounds the history requested after reconnect (README L173).
  No flow control was found.
- **webtmux** (chrismccord) and **terminal-web** (AaronFei): one pty running a real tmux client;
  panes are whatever tmux draws, scrolling is tmux copy mode (`mouse on`, `history-limit`), extra
  message types for pane switching. Simple, but it is option B with all of its consequences.
- **iTerm2** (gnachman/iTerm2): `tmux -CC attach`; windows become tabs and panes become split
  panes; sizes go up with `refresh-client -C W,H` and per window `-C @w:WxH`; attaches with
  `pause-after` and `wait-exit`, sends `-A continue` after `%pause`, unescapes the 3-digit octal in
  `%output`, and refuses `aggressive-resize` "because it relies on the concept of a current window"
  (`TmuxController.m` L726, L1080, L1190-1263, L1866-1871; `TmuxGateway.m` L157-196, L808-841;
  iterm2.com tmux integration page). The reference implementation of option C.
- **Zellij** web client (v0.43.0, 2025-08; touch UI and PWA in v0.45.0, 2026-08): each browser tab
  is a Zellij client fed a server-rendered full-session stream, with resize on a control channel
  (`web_client/websocket_handlers.rs` L53-61, L176-211). Option B's shape, not per-pane.
- **Tabby** never implemented control mode (#2715, feature request closed 2021-07); no project
  named "tmux-next" was found. The lost 2026-09-04 note's other conclusion still holds: no
  mature JS/TS tmux client library exists (the only control-mode parser on npm was a 0.1.0), so
  control mode means owning a small line parser. The camps are "one emulator per pane over control
  mode" (iTerm2, dsh-tmux-cc) versus "stream a real client" (ttyd, Wetty, webtmux, Zellij).

## 7. Options

Scored against R1 first-class pane panels, R2 local-feeling input, R3 native scrolling, R4 heavy
TUIs, and constraints C1 multiple viewers, C2 snapshot consumers, C3 tmux as source of truth, C4
security, C5 mobile. Letters match the lost 2026-09-04 note where they overlap (A, B, C, E).

### Option 0: tune the snapshot loop

Poll immediately when input arrives (the input and log sockets would share a per-pane "poke"),
drop the 750 ms throttle, run at the 250 ms floor, or make the interval adaptive.

- R2 improves from 500-1000 ms to roughly 250 ms plus a capture, never below one tick; R1, R3, R4
  unchanged. Cost is small, but every viewer then spawns up to eight tmux processes a second.
- Worth doing only as a stop-gap while a push channel is built; it does not change the ceiling.

### Option A: per-pane snapshots (the same loop for any pane)

Add a pane picker; capture the chosen pane by id (no `select-window` needed), place panels from
`list-panes -F '#{pane_left} #{pane_top} #{pane_width} #{pane_height}'`.

- R1 yes, at today's fidelity. R2, R3, R4 no: same tick, same paging, same SGR-only text, so
  a neovim pane is a 1 Hz styled-text sample. C1-C5 as today.
- The cheapest visible step, and a dead end for three of the four goals.

### Option B: a real tmux client per viewer, over a pty (what `/ws/terminal` was)

`tmux attach-session` in a node-pty (homebridge/lydell build), bytes to xterm.js, keystrokes to
the pty, `resize()` on fit.

- R2 yes (bytes stream, no tick). R4 yes and more: tmux draws everything, negotiates extended keys
  and mouse with the program, and the operator gets prefix keys, the status line and copy mode.
- R3 only through tmux copy mode, which is per pane, not per client: a browser that scrolls up
  scrolls the attached terminal too, and live output is held until the mode exits (§3.6). No
  local scrollback, since tmux redraws in place.
- R1 poorly: a client displays a *window*, laid out by tmux. Showing pane X beside the agent in its
  own panel means a grouped session per panel with that window current and the pane zoomed, and
  zoom is window state every client shares. Panels would be windows, not panes.
- C1 inverts the sizing work: every viewer is a client that counts for `window-size`; C4 widens
  the surface to every tmux command reachable from the prefix; C5 fine. Needs node-pty (§5).
- The right answer for "give me a full tmux in a tab", the wrong shape for "a pane next to my
  agent". Could coexist later as an explicit "attach" mode.

### Option C: one control-mode client per tmux session, streams per pane (recommended)

The server runs `tmux -S <socket> -C attach-session -t <session>` once per session that has a
viewer, over pipes (§3.6), parses `%begin/%end`, `%output`, `%layout-change`, `%pause` and
`%subscription-changed`, and fans each pane's byte stream out to the browsers that subscribed to
it. A viewer's xterm is seeded with `capture-pane -e -p -J -S -N -t %pane` (+ the mode formats and
`-P`) sent through the same control connection, then follows `%output`. Keystrokes go back as
`send-keys -H` lines on the same connection.

- **R2 yes.** No process spawn anywhere on the hot path; echo latency is WebSocket round trip plus
  tmux's own pty handling, measured at 0.11 ms median on this host (§1.8). Adapter key sequences
  (`sendKeys`) can stay as they are or move onto the connection.
- **R3 yes.** The browser xterm gets `scrollback > 0` and builds its own history from the stream;
  the seed supplies history from before the subscription. Wheel and touch are handled by xterm.js
  itself (§4.1); `containOutputScroll` and the page buttons go. In the alternate screen, wheel
  becomes arrow keys or mouse reports exactly as in a desktop terminal.
- **R4 yes.** The pane program's raw bytes reach a real emulator at full rate; xterm paints at most
  once per animation frame however fast the stream is (§4.4). Mouse reports come back through
  `onData`/`onBinary` and are injected byte-exact with `-H`. This is iTerm2's model (control mode
  dates from tmux 1.8, 2013) and dsh-tmux-cc's with xterm 5.5 (§6).
- **R1 yes.** `%output` covers every pane in the session, so any pane is streamable without
  changing tmux's current window; other sessions (idle shell, stack commands) get their own
  control client on demand. Panels are pane-shaped, matching the brief.
- **C1.** One control client per session serves every viewer; the client is size-invisible until it
  declares a size, so the existing coordinator (pin `window-size manual`, yield to the smallest
  attached terminal) keeps working unchanged. Per-window `refresh-client -C @w:WxH` is available
  later for sizing a terminal pane's window independently of the agent's.
- **C2.** The 30 s metadata capture and question parse become control-connection commands (no
  spawn) or read from a server-side headless xterm (§4.3) if exactness matters; the tab cache
  keeps the last seed or a serialize of the viewer's buffer. Attention/question pane options could
  move to a `-B '#{@rac_attention}'` subscription on `%*`, but that is a separate change to ADR
  0001's read path, not required here.
- **C3.** tmux stays the source of truth; the console holds only a byte fan-out and, optionally,
  a headless mirror it can rebuild from `capture-pane` at any time (memory: ~12 bytes per cell,
  so 200 cols × 1000 scrollback ≈ 2.4 MB per mirrored pane).
- **C4.** The server owns the allowed set: a pane id is accepted only if `#{session_id}` matches
  the ticketed Agent's session. Input is `send-keys -H` to that pane only; no tmux command syntax
  crosses the socket.
- **C5.** One xterm per panel, no buffer swap, so the mobile keyboard workaround simplifies; keep
  the DOM renderer and `screenReaderMode` on phones (§4.6); touch scroll works in the normal
  buffer, and dsh-tmux-cc's drag-to-wheel synthesis covers the alternate screen.
- **Known costs and traps** (each is bounded, none is a blocker):
  - Write the line parser and the octal unescaper (small; byte-level reassembly, `Uint8Array` into
    xterm so split UTF-8 and escape sequences are handled by its incremental decoder).
  - Flow control both hops: `pause-after` on the tmux side with re-seed on `%continue`; VS Code
    style byte acks from the browser's `write` callback; never `-A off` a pane while the console is
    the only client (§3.6).
  - Suppress xterm's automatic replies to device queries in the stream (DA, DSR, CPR) with
    `parser.registerCsiHandler`, since tmux already answered the program; otherwise the replies
    would be typed into the pane.
  - The stream is for `TERM=tmux-256color`; xterm.js ignores the few tmux-only sequences.
    Extended keys: xterm 5.5 emits legacy encodings only (§4.7), which programs accept.
  - Reconnect when the tmux server restarts (`%exit`), and lifecycle per socket/session.
  - `%pause` after the console falls 300 s behind (a suspended laptop viewer) must re-seed rather
    than be treated as an error.

### Option D: `pipe-pane -O` per pane

Same raw bytes as C, but one pipe per pane, replacing any pipe the operator set, no pause or
watermark, a forked process per pane, no layout or mode events, and a fan-out to build anyway.
Strictly dominated by C. Reject.

### Option E: control client for events only, snapshots stay (a stepping stone inside C)

Attach the control client but discard the bytes: use `%output` as "this pane changed" to trigger
a debounced capture for its viewers, `%layout-change` to replace the per-tick size read, and run
the captures themselves as control commands.

- R2 improves to debounce plus capture, roughly 30-60 ms, with **no browser change**; process
  spawns on the hot path drop to zero. R1 can ship on it (pane picker + per-pane captures). R3 and
  R4 still wait for the stream.
- Everything built for E (spawn, parse, reconnect, per-session lifecycle, allowed-pane check) is
  the first half of C. That makes E the natural first slice rather than a competing option.

### Summary

| | R1 panels | R2 input | R3 scroll | R4 TUIs | Sizing (C1) | Needs pty | Effort |
|---|---|---|---|---|---|---|---|
| 0 tune polls | no | ~250 ms | no | no | as today | no | hours |
| A per-pane snapshots | yes | as today | no | no | as today | no | days |
| B real attach | windows, not panes | yes | tmux copy mode, shared | yes+ | inverted | yes | days + node-pty |
| C control stream | yes | yes | yes, local | yes | as today | no | weeks |
| D pipe-pane | yes | yes | yes | yes | as today | no | ≈C, worse |
| E events + snapshots | yes | ~50 ms | no | no | simpler | no | days |

## 8. Recommendation and prototype plan

**Go with option C, delivered as E first.** The first slice replaces process spawns with one
control client per session and makes every capture event-driven; it ships the latency win and the
pane picker on today's renderer with no wire change. The second slice streams bytes, turns on
scrollback, and retires the double buffer, the sanitiser, paging and scroll containment. Option 0's
tweaks are worth an afternoon only if slice one is more than a few weeks away.

Before committing to an effort, three throwaway probes answer the questions the sources cannot:

1. **Latency probe** (Appendix A, done 2026-09-06): spawn cost versus control-connection cost for
   `send-keys`, `capture-pane` and the size read, plus the full `send-keys → %output` echo. Results
   in §1.8; they also confirm there is nothing in tmux itself that needs a pty and that a non-active
   window's pane streams.
2. **Stream spike** (throwaway Node script + one HTML page under `docs/research/probes/`, not the
   app): one `-C` client, one xterm 5.5 with `scrollback: 5000`, two panes side by side, `send-keys
   -H` input, DA/DSR reply suppression. Run neovim with `mouse=a`, `less`, `htop`, `yes | head -c
   50M`, and Claude Code in the panes; check on the desktop and on the phone. Pass criteria: no
   visible tearing in neovim; wheel/touch scroll the normal buffer and scroll neovim in the
   alternate screen; mouse clicks land in neovim; the burst does not freeze the page (acks work);
   a viewer opened mid-session shows the same screen as an attached terminal; `%pause` recovers.
3. **Panel UX prototype** (one standalone HTML file per the prototype rule): pane picker on the
   agent tab, agent + terminal + notes + browser combinations, mobile switching. Decides the
   interaction model before any React work.

Sizing is the one design decision to settle on paper: keep the coordinator (pin the window, yield
to attached terminals) for the agent pane, and size a terminal pane's *own* window with the same
mechanism or with `refresh-client -C @w:WxH` on the control client; a companion pane in the agent's
window inherits the layout split, which the console already preserves in `resize()`.

What the effort would touch, for sizing it later: a `ControlClient` service (`apps/server/src/tmux/
control.ts`, line parser, per-session lifecycle, fan-out, flow control) with transcript fixtures as
its test seam; a pane stream socket (`/ws/panes/:agentId`, multiplexed subscribe/seed/output/input/
ack frames, binary output frames); an allowed-pane check in discovery; a `TerminalPanel` component
built from today's `Log` minus double buffering, `safeSnapshot` rendering, paging and
`containOutputScroll`, plus scrollback and the reply filter; the `log-split` layout extended from
three panels to N; the metadata scan moved onto the control connection; and an ADR recording that
the console now holds a control-mode client per session (extending, not reversing, ADR 0001).
Retire when done: `captureRecentWindow`, `logFrame`'s throttle, `output-scroll.ts`, the two-terminal
swap, `attachArgs`, and the `node-pty` entries in `pnpm-workspace.yaml`.

## Appendix A: latency probe

`docs/research/probes/tmux-io-probe.mjs` starts a throwaway tmux server on its own socket, measures
N spawned `send-keys`, `capture-pane` and `display-message; list-clients` round trips, then attaches
one control-mode client over pipes and measures the same commands plus the full `send-keys →
%output` echo, and finally times a 2,000-line burst from a non-active window. Run on the host,
outside the sandbox (unix sockets are blocked inside it). Its first version stalled on an echo-off
pane and an off-by-one reply matcher that had not consumed the attach's own `%begin`/`%end` block;
the committed version parses whole blocks, times out instead of hanging, and matches each echo to a
distinct character. Results from 2026-09-06 are in §1.8.

```
node docs/research/probes/tmux-io-probe.mjs 40
```
