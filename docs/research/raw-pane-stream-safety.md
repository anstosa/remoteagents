# What a raw pane stream can do in the browser

What an unsanitised pane byte stream can do once it reaches xterm.js, and which sequences the
console must filter, intercept or answer so that a streamed pane (option C in
`tmux-pane-io-options.md` §7) is as safe as today's SGR-only snapshots. Today `safeSnapshot`
(`apps/server/src/tmux/adapter.ts:14-40`) keeps only `CSI … m`, drops every other CSI, every OSC,
DCS, PM and APC string up to BEL or ST, and every C0 byte except LF, CR and TAB, so the browser has
never parsed anything but styled text. A control-mode client receives the pane's pty bytes
*before* tmux's own parser sees them (`window.c` L1156-1160 @ 3.7b, earlier note §3.6), which means
none of tmux's clamping, gating or answering protects the browser: whatever the program wrote is
what xterm.js will parse. Gathered 2026-09-06 on branch `research/raw-stream-safety` (off `terminal`,
tip `3184a59`).

**Sources.** Console code is cited as `path:line` at `3184a59`. xterm.js facts are cited from the
`6.0.0` tag of xtermjs/xterm.js (raw source, line numbers of those files) because the sibling
research `xterm-6-for-streamed-terminal.md` §6.1 recommends pinning `@xterm/xterm` 6.0.0 exactly
with clipboard 0.2.0, web-links 0.12.0 and headless 6.0.0; this note therefore depends on that
recommendation being adopted, and the few places where 5.5.0 (the version the web app locks today,
`apps/web/package.json:16`) differs are marked. Addon facts come from the same tag
(`addons/addon-clipboard` 0.2.0, `addon-web-links` 0.12.0, `addon-image` 0.9.0) and the npm
registry. tmux facts come from the `3.7b` tag of tmux/tmux (the host's version) and its `tmux.1`.
Specifications: XTerm Control Sequences (`ctlseqs.txt`, Patch #411, 2026-08-23), the kitty keyboard
protocol page, the contour synchronized-output spec, the OSC 8 hyperlink spec (egmontkob gist), and
the xtermjs.org "Hooks" and "Security" guides. Everything marked `probe:` was measured by
`docs/research/probes/raw-stream-probe.mjs` against `@xterm/headless@6.0.0` (the same parser,
`InputHandler` and buffers as the browser build, without a renderer) in the sandbox on 2026-09-06.

## TL;DR

- **Enforce in the browser's parser, not with a server-side regex.** The stream can straddle
  `%output` chunks, arrive as 8-bit C1 introducers (U+009B is a CSI to xterm.js but a UTF-8
  character to tmux) and be re-issued after a `RIS`; `terminal.parser.registerCsiHandler /
  registerOscHandler / registerDcsHandler` returning `true` sees every form after parsing, runs
  before the built-in handler, and survives `ESC c`, `CSI ! p` and `terminal.reset()` (§6, probe §3).
  The server keeps byte-level caps (seed size, per-viewer backlog) and nothing else.
- **Nine sequences make xterm.js write into the pane** (DA1, DA2, DSR 5, CPR 6, DECXCPR `? 6 n`,
  DECRQM ANSI and private, DECRQSS, and the OSC 4/10/11/12 colour queries). tmux answers all of
  them for the pane itself except DECXCPR and out-of-palette OSC 4 lookups, so suppressing every
  one in the browser loses nothing (§2). XTVERSION, XTGETTCAP, DA3, kitty `CSI ? u`, XTWINOPS and
  XTSMGRAPHICS produce no reply in 6.0.0 (probe §1).
- **OSC 52 is inert without the clipboard addon and must stay that way**: the addon answers a `?`
  query by reading `navigator.clipboard` and typing the result into the pane. tmux ignores pane
  OSC 52 entirely at its default `set-clipboard external` (§1).
- **OSC 8 links are the one page-facing feature worth keeping**: xterm.js only links `http:`/
  `https:`, activates on a plain click with a `confirm()`, and can be routed through
  `options.linkHandler` to the console's existing URL opener (§1). Titles never touch
  `document.title`.
- **Four CSI handlers scale with their parameter without a clamp** (SU/SD/IL/DL loop once per
  line, `CSI Ps b` allocates `Ps` cells): `CSI 1000000 S` costs 0.6 s and `CSI 2147483647 b`
  freezes parsing for 55 s before recovering (probe §4-5). A parameter-gated deny hook costs 1 ms.
  Everything else is bounded by the buffer geometry, the 32-parameter / 2^31 value limits, the
  10 MB OSC/DCS payload limit and the `scrollback` option (§4).
- **Modes are traps, not breaches**: mouse tracking disables selection, the alternate screen has no
  scrollback, focus reporting adds a third `onData` source; all of them are what a real attached
  terminal would do and all clear on `RIS`/`DECSTR`. 6.0.0's synchronized output auto-releases
  after 1 s (§3).
- **The seed is not SGR-only**: `capture-pane -e` also emits OSC 8 hyperlinks and SO/SI, and `-P`
  emits raw, incomplete escape bytes. Feed both through the same hooked xterm parser, never through
  a text path (§5).

## 1. Which OSC sequences xterm.js acts on

xterm.js 6.0.0 registers OSC 0, 1, 2 (title/icon), 4 (indexed colour set or query), 8 (hyperlink),
10, 11, 12 (default fg, bg, cursor colour set or query) and 104, 110, 111, 112 (restore)
(`InputHandler.ts` L292-331 @ 6.0.0). Every other OSC number, including 7, 9, 52, 133, 777 and
1337, reaches only the fallback, which logs at debug level and does not accumulate the payload
(`InputHandler.ts` L201-203; `OscParser.ts` L79; probe §1 shows no reply and no effect for each).

- **OSC 0 / 2 title.** `setTitle` stores the string and fires `onTitleChange`; the source states
  that "xterm.js does not manipulate the title directly" (`InputHandler.ts` L2938-2945;
  `xterm.d.ts` L1003). The title stack behind `CSI 22/23 t` is capped at 10 entries
  (`STACK_LIMIT`, L66) and is gated anyway (§2). What it can do to the page: nothing unless the
  console subscribes; if it does, the security guide lists `onTitleChange` among the APIs that hand
  raw terminal data to the embedder and must never reach `innerHTML` (xtermjs.org Security L81-88).
  tmux already applies the same OSC to `#{pane_title}` when `allow-set-title` is on, its default
  (`input.c` L2700-2709; `options-table.c` L1105-1108 @ 3.7b), so the pane title is available from
  formats without parsing the stream at all.
- **OSC 8 hyperlinks.** `setHyperlink` registers `{id, uri}` in the `OscLinkService` and marks the
  cells that follow (`InputHandler.ts` L3008-3020). The link provider skips any URI whose protocol
  is not `http:` or `https:` and any URI that fails `new URL()` unless
  `linkHandler.allowNonHttpProtocols` is set, which the typings warn "may cause security issues
  such as XSS" (`OscLinkProvider.ts` L72-75; `xterm.d.ts` L1381-1387). Activation is a plain
  mouse-up on the same link the mouse went down on, no modifier (`Linkifier.ts` L220-231); the
  default activation shows `confirm("Do you want to navigate to …? WARNING: This link could
  potentially be dangerous")`, then `window.open()` with `opener = null` and a `location.href`
  assignment (`OscLinkProvider.ts` L114-124). With `options.linkHandler` set (`xterm.d.ts` L163),
  activation, hover and leave go to the console instead. The display text is free-form by design
  (the spec's own rationale), so a link can read one thing and target another; the spec recommends
  terminals show the URI, ask, and not open on a bare click (OSC 8 gist L159-171). Link records are
  freed when the buffer line that holds them is trimmed (`OscLinkService.ts` L38-41, L58) and there
  is no count limit. tmux stores the same links in the pane grid and emits them in `-e` captures
  (§5).
- **OSC 52 clipboard.** No core handler (probe §1: `52;c;?` and `52;c;aGk=` produce nothing).
  `@xterm/addon-clipboard` 0.2.0 (present in the 6.0.0 tag's `addons/`, not in 5.5.0's) registers
  OSC 52 and, for `Pd = ?`, calls `navigator.clipboard.readText()` and feeds the base64 result back
  through `terminal.input()` as `OSC 52 ; sel ; data BEL`, i.e. into the pane; for any other `Pd`
  it calls `navigator.clipboard.writeText()`; only the `c` selection is honoured
  (`ClipboardAddon.ts` L21-30, L41, L74-84 @ 6.0.0; typings note the provider "redirect[s] the
  selection parameter always to navigator.clipboard"). XTerm's own definition of the `?` reply is
  the same read-back (ctlseqs L2174-2177). tmux at its default `set-clipboard external` returns
  from `input_osc_52_parse` before doing anything (`input.c` L3233-3234; `options-table.c`
  L508-512, choices L84-86; `tmux.1` L4528-4534 "ignore attempts by applications to set tmux
  buffers"). With `on`, a set creates a paste buffer and is forwarded as `Ms` only to clients with a
  started tty (`input.c` L3289-3296; `tty.c` L2147-2149), which a control client never is
  (`server-client.c` L338-339, L2551-2560), and a `?` is answered from the newest paste buffer at the
  default `get-clipboard buffer` or relayed to the most recently active tty client at `request`
  (`input.c` L3203-3216, L3450-3478; `tmux.1` L4474-4492). So a pane can reach a *desktop* clipboard
  only through tmux and a real attached terminal, never through the console, provided the addon is
  absent.
- **OSC 4 / 10 / 11 / 12 set and query.** A set parses the colour and fires a colour event that the
  browser terminal applies to the live theme (`InputHandler.ts` L2965, L3058-3072;
  `CoreBrowserTerminal.ts` L219-225 via `ThemeService.modifyColors` L170); a `?` fires a report
  that the browser terminal answers on `onData` as `OSC n ; rgb:rr/gg/bb ST`
  (`CoreBrowserTerminal.ts` L213-217). The headless build has no theme service, which is why
  probe §1 shows no reply for these four; in the browser they do reply. A set persists until
  104/110/111/112, a reset, or the next `options.theme` assignment (the console re-assigns the theme
  on every flavour flip, `main.tsx:4000-4003`), so a program's fg/bg choice would be clobbered
  nondeterministically. What it can do to the operator: paint the panel unreadable (bg = fg) until
  the program restores it. tmux applies OSC 4 to the pane palette and OSC 10/11/12 to the pane
  style, redrawing real clients the same way (`input.c` L2937-2948, L3068-3077, L3111-3120), and
  answers queries itself from that palette (§2).
- **OSC 133 shell-integration marks.** Ignored by xterm.js core (probe §1; VS Code registers its own
  handler). tmux flags the line as prompt start (`A`) or output start (`C`) for its copy-mode
  prompt navigation (`input.c` L3173-3191). Nothing for the console to do.
- **OSC 7, 9, 1337.** Ignored by core. tmux sets the pane path from OSC 7 (L2713-2717) and a
  progress bar from `OSC 9;4` only (L3007-3039). `OSC 1337 ; File=` is iTerm2's inline image
  protocol and is handled only by `@xterm/addon-image` (`ImageAddon.ts` L144), which also
  registers sixel `DCS q` and its own DA1 reply (L135, L107) and defaults to a 128 MB image store
  (`addon-image` README L25-30). Do not load it.

## 2. Which sequences make xterm.js reply on `onData`, and what tmux already answers

Replies are `coreService.triggerDataEvent(...)`, indistinguishable from typed input. In option C
they would be sent back as `send-keys -H` into the pane, so an unfiltered stream lets a pane
program (or a file it `cat`s) inject bytes into its own stdin. The full table is probe §1; the
rows that reply in 6.0.0:

| Query | xterm.js 6.0.0 reply | tmux 3.7b for the pane |
|---|---|---|
| DA1 `CSI c` / `CSI 0 c` | `CSI ? 1 ; 2 c` (`InputHandler.ts` L1667-1677) | `CSI ? 1 ; 2 c`, or `? 1 ; 2 ; 4 c` in a sixel build (`input.c` L1557-1572) |
| DA2 `CSI > c` | `CSI > 0 ; 276 ; 0 c` (L1703-1713) | `CSI > 84 ; 0 ; 0 c` (L1573-1584) |
| DSR `CSI 5 n` | `CSI 0 n` (L2653-2667) | `CSI 0 n` (L1698-1704) |
| CPR `CSI 6 n` | `CSI row ; col R` | `CSI row ; col R` (L1705-1708) |
| DECXCPR `CSI ? 6 n` | `CSI ? row ; col R` (L2670-2679) | not answered; `? 996 n` theme query is (L1606-1612, L3577-3595) |
| DECRQM `CSI Ps $ p`, `CSI ? Ps $ p` | `CSI [?] Ps ; Pm $ y` for every `Ps`, 0 for unknown (L2245-2302; 2026 reports its real state, L2301) | ANSI: only IRM; private: 1, 3, 6, 7, 12, 25, 47/1047/1049, 1000-1006, 2004, 2026, 2031, 0 otherwise (L1613-1696) |
| DECRQSS `DCS $ q Pt ST` | `DCS 1 $ r … ST` for `m`, `r`, `" q`, `" p`, `SP q`; `DCS 0 $ r ST` otherwise (L3416-3434) | cursor-style reply or `DCS 0 $ r ST` (L2637-2641, L2586-2592) |
| OSC 4;i;? / 10;? / 11;? / 12;? | `OSC n ; rgb:… ST` (browser only, `CoreBrowserTerminal.ts` L213-217) | from the pane palette / fg / bg (L2925-2935, L3053-3065, L3103-3108); an unset OSC 4 index is looked up on the most recent tty client, or dropped when none (L2933, L3450-3463) |

Replies xterm.js does **not** send, confirmed by probe §1: DA3 `CSI = c`, DECID `ESC Z` (no
handler in the ESC table L343-368), XTVERSION `CSI > 0 q` (tmux answers `DCS > | tmux 3.7b ST`,
`input.c` L1860-1866), XTGETTCAP, the kitty forms `CSI ? u`, `CSI > 1 u`, `CSI = 1 ; 1 u` (only
`CSI u` = SCORC is registered, L263; the sibling note §5 confirms kitty is 7.0-only), XTWINOPS
`CSI 14/18/21 t` (all window options default off, `OptionsService.ts` L51; `xterm.d.ts` L313-315
"disabled by default for security reasons"; a custom `t` handler is gated the same way,
`InputHandler.ts` L657-668; tmux answers 14-19 and keeps the 22/23 title stack, L2113-2170),
XTSMGRAPHICS `CSI ? … S` (tmux answers only in a sixel build, L2080-2097), XTMODKEYS
`CSI > 4 ; 2 m` and XTQMODKEYS (unregistered; tmux honours XTMODKEYS only with `extended-keys`
on, default off, L1502-1520; `options-table.c` L390-394).

**Suppression.** Each reply path is one parser identifier, so one hook each:

```ts
const deny = () => true;
p.registerCsiHandler({ final: 'c' }, deny);                              // DA1
p.registerCsiHandler({ prefix: '>', final: 'c' }, deny);                 // DA2
p.registerCsiHandler({ final: 'n' }, deny);                              // DSR, CPR
p.registerCsiHandler({ prefix: '?', final: 'n' }, deny);                 // DECXCPR
p.registerCsiHandler({ intermediates: '$', final: 'p' }, deny);          // DECRQM ANSI
p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, deny); // DECRQM private
p.registerDcsHandler({ intermediates: '$', final: 'q' }, deny);          // DECRQSS
for (const n of [4, 10, 11, 12]) p.registerOscHandler(n, data => /(^|;)\?(;|$)/.test(data));
```

A handler that returns `true` stops the chain before the built-in handler; the most recently
registered handler runs first (`xterm.d.ts` L1805-1864; `EscapeSequenceParser.ts` L676-689; hooks
guide L165-182, which adds "you should never skip the default handler execution … unless you know
what you are doing"). probe §3: with these hooks installed the whole query set produces no
`onData` at all, the hooks keep working after `ESC c` (RIS), `CSI ! p` (DECSTR) and
`terminal.reset()` (RIS only resets parser state and re-runs setup; the handler lists are untouched,
`InputHandler.ts` L3324-3328; `CoreBrowserTerminal.ts` L166, L1268-1283), and `dispose()` restores
the reply. The OSC colour hook above denies only queries and lets sets fall through; §7 decides
sets separately.

**Does suppression lose anything?** No. tmux replies to the pane directly on its pty
(`input_send_reply` → `bufferevent_write(ictx->event, …)`, `input.c` L1143-1149), so the program
already gets the terminal identity, cursor position, mode states and DECRQSS strings from tmux
whether or not any client is attached, and those answers describe the pane's real state (tmux is
the program's terminal; the browser is a mirror). Where tmux does not answer (DECXCPR, kitty,
DA3, unset-palette OSC 4 with no tty client) the program gets no reply today either. The kitty
spec's detection recipe (query, then DA1, treat a DA1-only answer as "unsupported") therefore
resolves correctly through tmux's DA1. The only behavioural difference from a desktop terminal
running tmux is that DA/DSR answers arrive once instead of twice, which is the bug the hooks
exist to prevent.

## 3. Modes that change input encoding, and modes that can trap the operator

xterm.js 6.0.0 implements DECSET/DECRST 1, 2, 3 (gated), 6, 7, 9, 12, 25, 45, 66, 1000, 1002,
1003, 1004, 1005 (no-op), 1006, 1015 (no-op), 1016, 1047, 1048, 1049, 47, 2004 and, new in 6.0.0,
2026 (`InputHandler.ts` L1877-1973, L2125-2204; release 6.0.0 #5453). tmux tracks the same set plus
2031 for its own redraws (`input.c` L1900-2076), so a real attached terminal would be put into
exactly these modes too.

- **DECCKM (1) and DECKPAM (66 / `ESC =`)** change arrow and keypad encoding to SS3; xterm.js
  emits accordingly (`modes.applicationCursorKeysMode`, probe §7). Benign, required by TUIs. Allow.
- **Bracketed paste (2004)** makes `terminal.paste()` wrap text in `CSI 200~ … CSI 201~`
  (`BrowserClipboard.ts` L21-23, L51-53), which is what shells and agent CLIs rely on to keep a
  pasted newline from executing. Allow; the console's own paste path must go through
  `terminal.paste()` or replicate the wrap from `modes.bracketedPasteMode`.
- **Focus reporting (1004)** adds `CSI I` / `CSI O` on textarea focus and blur
  (`CoreBrowserTerminal.ts` L271, L295): a third source of `onData` beside keys and mouse. Benign
  (tmux tracks `MODE_FOCUSON` for the same purpose, L2042-2043). Allow; the input path must simply
  forward `onData` verbatim.
- **Mouse tracking (9, 1000, 1002, 1003 with 1006/1016)**: xterm.js reports clicks, drags or all
  motion on `onData` (SGR) or `onBinary` (legacy), disables its own text selection while any
  tracking is on, and lets `shouldForceSelection` (Alt/Option on macOS) override it
  (`CoreBrowserTerminal.ts` L547-548, L786; earlier note §4.2). The trap: a program that enables
  1003 and never disables it turns every mouse move over the panel into pane input and removes
  copy-by-selection until it exits, `RIS` or `DECSTR`. That is precisely what happens in a desktop
  terminal, and tmux mirrors the mode for real clients, so this is fidelity rather than a breach.
  Allow; give the operator the existing escape hatches (kill, "Swap to terminal") and consider a
  force-selection modifier on desktop.
- **Alternate screen (47, 1047, 1049)**: swaps to a buffer that never has scrollback
  (`BufferSet.ts` L42; probe §7 `buffer.active.length` 6 with 5000 lines written). A hidden panel
  keeps parsing, so when it is shown it is in the alternate screen exactly as the pane is; the
  operator loses local history until the program leaves it, as on any terminal. Allow. The seed
  path must handle `alternate_on` (earlier note §3.6).
- **Synchronized output (2026)**: xterm.js buffers row refreshes while set and force-releases the
  mode after `SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 1000` (`RenderService.ts` L22, L154-156, L178-180,
  L349-351), so a program that sets 2026 and dies cannot freeze a panel; headless has no renderer,
  which is why probe §7 shows the flag still set after 1.5 s. tmux tracks it too (`input.c`
  L2068-2069). Allow. (5.5.0 has no 2026: DECRQM reports 0 and the mode is ignored.)
- **DECCOLM (3)** would resize to 132 columns but only when `windowOptions.setWinLines` is set
  (`InputHandler.ts` L1890-1896); with the default it is inert. Keep window options off, so a pane
  cannot resize the browser terminal either through `CSI 3 h` or `CSI 8 ; r ; c t`.
- **Kitty keyboard (`CSI > / = / ? … u`), XTMODKEYS**: inert in 6.0.0 (probe §1; sibling note §5),
  so the browser keeps emitting legacy encodings, which tmux would do as well at its default
  `extended-keys off`. Nothing to intercept.
- **RIS `ESC c` and DECSTR `CSI ! p`** reset modes, mouse service, charsets and (RIS) buffers
  (`InputHandler.ts` L3324-3328; `CoreTerminal.ts` L250-256). They are the operator's way out of
  every trap above and must stay allowed; they do not disturb the hooks (probe §3).

## 4. Resource exhaustion

- **Parameter-scaled loops.** Parameters are capped at 2^31-1 and 32 per sequence (`Params.ts`
  L8, L72), but four handlers loop once per unit of the parameter with no clamp to the screen:
  `scrollUp`/`scrollDown` splice a line per iteration (`InputHandler.ts` L1429-1453),
  `insertLines`/`deleteLines` likewise (L1311-1323, L1344-1357), and the tab handlers step a stop
  per iteration (L1097-1122). probe §4 (40×6 headless): `CSI 100000 S` 55 ms, `CSI 1000000 S`
  610 ms, `T`/`L`/`M` at 10^6 630-750 ms, `CSI 10000000 Z` 323 ms; at 2^31-1 that extrapolates to
  roughly twenty minutes of a blocked main thread per sequence. `CSI Ps b` (REP) allocates a
  `Uint32Array(text.length × Ps)` and copies it (L1615-1639): 10^7 takes 375 ms and 2^31-1 froze
  parsing for **55.3 s**, after which the write callback fired and later writes were processed
  normally (probe §5, run with a 2 GB heap; the 5.5.0 run of the same case died without output).
  tmux clamps REP to the columns left on the line (`input.c` L1779-1781) but, again, its clamp
  never reaches the browser. The other geometry-bound handlers (ICH, ECH, DCH, CUF, CUU, DECIC, SL)
  cost about 1 ms at 2^31-1 (probe §4). Mitigation is a parameter-gated deny hook, since a
  legitimate program never scrolls, inserts or repeats past the screen: probe §3 measured
  `registerCsiHandler({ final: 'S' }, p => p[0] > rows)` at 1.1 ms for `CSI 1000000 S`.
- **Scrollback and lines.** The normal buffer is a circular list of `rows + scrollback` lines
  (`Buffer.ts` L111; `CircularList.ts` L112 trims the oldest), the alternate buffer has none, and
  `scrollback` is clamped to 2^32-1 and defaults to 1000 (`OptionsService.ts` L34, L185). A line
  costs 3 × `Uint32` per cell plus sparse maps for combining characters and extended attributes
  (`BufferLine.ts` L22). probe §6: 5000 lines into `scrollback: 100` leaves 106 lines; `CSI 3 J`
  leaves 6; a 1 MB single line wraps into the same 106 (DECAWM on) or overwrites one row (DECAWM
  off). So memory is bounded by the `scrollback` the console chooses, not by the program. Pick
  it per pane (a few thousand lines for a shell, fewer on phones) and keep the tab cache the
  console already bounds at 64 entries × 64 KiB (`main.tsx:241`).
- **String payloads.** A handled OSC or DCS accumulates at most `PAYLOAD_LIMIT` = 10 MB and is then
  dropped (`Constants.ts` L58; `OscParser.ts` L211-212; `DcsParser.ts` L163-164; `xterm.d.ts`
  L1828, L1857). An unhandled one is not accumulated at all (`OscParser.ts` L79; probe §6: a 20 MB
  `OSC 1337` costs a transient 35 MB of heap, a 20 MB `OSC 2` 298 MB until collected). APC, PM and
  SOS strings are skipped to ST (`EscapeSequenceParser.ts` L107, L135). Sixel and IIP are ignored
  without the image addon (§1).
- **Write backlog.** The write buffer throws past 50 MB pending and the source says xterm.js "gets
  unresponsive" a hundred times lower (`WriteBuffer.ts` L17-20, L105). A pane can emit faster than
  a phone parses, so the server must apply per-viewer backpressure (acks from the `write` callback,
  `pause-after` on the tmux side) as the earlier note §4.4 and §7 already require; the 96 KB seed
  cap (`adapter.ts:137`) stays as the per-seed bound.
- **Hyperlinks.** No limit on distinct links, but each record dies with its buffer line
  (`OscLinkService.ts` L38-41), so it is bounded by scrollback.
- **What xterm.js has fixed before.** The only advisory on record is CVE-2019-0542
  (GHSA-mc23-976p-j42x, remote code execution "when the component mishandles special characters",
  fixed in 3.8.1/3.9.2/3.10.1, 2019-01-08). Nothing is open against 5.x or 6.x in the GitHub
  advisory database (queried 2026-09-06 for `xterm` and `@xterm/xterm`).

## 5. The seed: `capture-pane -e` and `-P`

- `-e` sets `GRID_STRING_WITH_SEQUENCES`, under which `grid_string_cells` emits, before each cell
  whose attributes differ from the previous one, the SGR delta, SO/SI for the line-drawing charset,
  and **an OSC 8 hyperlink** open (`ESC ] 8 ; id=… ; uri ESC \`) or close whenever the cell's link
  changes, closing any open link at the end of the line (`cmd-capture-pane.c` L233-234; `grid.c`
  L1121-1123, L1069-1079, L939-963, L1156 @ 3.7b). So today's seed is *not* SGR-only; it has been
  safe only because `safeSnapshot` strips every OSC. The text itself contains no ESC or C0 bytes
  (tmux's parser consumed them before they reached the grid; `-C` would additionally octal-escape
  non-printables, `tmux.1` L2697-2698), so the only escapes in a `-e` capture are the ones tmux
  wrote: SGR, SO/SI and OSC 8. Feeding the seed through the same hooked xterm parser as the stream
  applies the same OSC 8 policy automatically.
- `-P` "captures only any output that the pane has received that is the beginning of an as-yet
  incomplete escape sequence" (`tmux.1` L2708-2710): it is `ictx->since_ground`, the raw bytes since
  the parser last stood in ground state, emitted verbatim unless `-C` (`input.c` L935-940;
  `cmd-capture-pane.c` L78-108, L325). It needs no escaping; it needs to be written **after** the
  seed text and **before** the first `%output`, through the parser, so that the continuation bytes
  in the stream complete the sequence and the hooks judge the whole. Never put `-P` output through
  a text path, and never `-C` it (the octal would then print as text).
- One 8-bit subtlety: tmux's ground state hands every byte ≥ 0x80 to its UTF-8 assembler
  (`input.c` L520, L2836-2850), so U+009B in pane output is a character to tmux and appears in the
  grid, while xterm.js treats the same code point as CSI (§6). A seed can therefore carry a C1
  introducer *as text*; the hooks see it either way.

## 6. Where to enforce: the browser parser, not a server regex

- **Chunk boundaries.** `%output` delivers whatever the pty read returned, escaped only for bytes
  below 0x20 and backslash (`control.c` L637-647), so a sequence can straddle two frames. A
  server-side filter would need its own streaming state machine; the browser already has one, and
  its hooks fire only when a sequence completes.
- **8-bit C1.** xterm.js maps U+009B, U+009D, U+0090, U+009C and U+0098/9E/9F to CSI, OSC, DCS, ST
  and SOS/PM/APC in every state (`EscapeSequenceParser.ts` L104-109; probe §2: U+009B `6n` returned
  a CPR, U+009D `2;title` U+009C set the title, U+0090 `$qm` U+009C returned a DECRQSS report),
  and the same hooks suppressed the 8-bit forms (probe §3). `safeSnapshot` keys on `\x1b` only
  (`adapter.ts:18`); any server regex would need the C1 forms too, and tmux itself never treats them
  as controls (§5), a differential a server filter would have to reproduce.
- **Resets.** RIS, DECSTR and `terminal.reset()` leave registered handlers in place (probe §3), so
  a program cannot shake them off; `dispose()` is the only way out, and it is the console's.
- **Gating that already exists.** Window operations are gated at the option and even for custom
  `t` handlers ("security: always check whether window option is allowed", `InputHandler.ts`
  L657-668), the OSC 8 provider is protocol-gated (§1), and the clipboard is opt-in by addon. The
  console's CSP (`app.ts:309`: `default-src 'self'`, `base-uri 'none'`, `frame-ancestors 'none'`)
  is a second layer behind those, not the first.
- **What stays server-side.** The allowed-pane check, the seed size cap, per-viewer backpressure,
  and the `safeSnapshot` text path for the metadata consumers (questions, turn metadata, tab
  cache), which keep parsing captures as text (earlier note §1.6). The stream and the text path
  are different consumers with different sanitisers, and that is fine.
- **Options that must change with the stream.** `convertEol: true` and `scrollback: 0`
  (`main.tsx:4003`) are snapshot-era settings; a pty stream carries its own CR/LF discipline and
  the stream needs history, so both go (`convertEol` doc, `xterm.d.ts` L58). Leave
  `windowOptions`, `linkHandler.allowNonHttpProtocols` and `allowProposedApi` at their defaults
  (`OptionsService.ts` L31, L44, L51).

## 7. Allow / deny / intercept

"tmux" is what tmux 3.7b already did for the pane before the bytes reached the control client;
"mechanism" is on the browser terminal (`p = terminal.parser`) unless it says server.

| Sequence or class | xterm.js 6.0.0 does | tmux already did | Risk | Decision | Mechanism |
|---|---|---|---|---|---|
| SGR, cursor movement, erase, DECSTBM, DECSCUSR, charsets SO/SI, DECAWM, insert mode, `CSI 3 J` | renders | renders the same | none | **allow** | none |
| SU/SD/IL/DL `CSI Ps S/T/L/M` | loops `Ps` times, 0.6 s per 10^6 (probe §4) | clamps to its screen; irrelevant to the browser | main-thread stall | **intercept** | `p.registerCsiHandler({final:'S'}, p => p[0] > terminal.rows)`, same for `T`, `L`, `M` (deny only the absurd) |
| CHT/CBT `CSI Ps I/Z` | loops `Ps` times (probe §4: 323 ms at 10^7) | n/a | stall | **intercept** | same, `p[0] > terminal.cols` |
| REP `CSI Ps b` | allocates `Ps` cells; 55 s at 2^31-1 (probe §5) | clamps to columns left (`input.c` L1779-1781) | stall | **intercept** | `p.registerCsiHandler({final:'b'}, p => p[0] > terminal.cols)` |
| ICH/ECH/DCH/CUF/CUU/DECIC/SL etc. | bounded by geometry, ~1 ms at max (probe §4) | n/a | none | **allow** | none |
| DA1 `CSI c`, DA2 `CSI > c` | replies `?1;2c`, `>0;276;0c` | replies `?1;2c`, `>84;0;0c` | input injection, double answer | **intercept** | `registerCsiHandler({final:'c'}, ()=>true)`, `({prefix:'>',final:'c'})` |
| DSR/CPR `CSI 5/6 n`, DECXCPR `CSI ? 6 n` | replies | replies 5 and 6; not `?6` | injection | **intercept** | `({final:'n'})`, `({prefix:'?',final:'n'})` → `true` |
| DECRQM `CSI [?] Ps $ p` | replies for every `Ps` | replies for its mode list | injection | **intercept** | `({intermediates:'$',final:'p'})`, `({prefix:'?',intermediates:'$',final:'p'})` → `true` |
| DECRQSS `DCS $ q … ST` | replies | replies | injection | **intercept** | `p.registerDcsHandler({intermediates:'$',final:'q'}, ()=>true)` |
| XTVERSION, XTGETTCAP, DA3, DECID, kitty `CSI ?/>/=/< u`, XTMODKEYS/XTQMODKEYS, XTSMGRAPHICS | no reply, no effect (probe §1) | XTVERSION answered; kitty not; XTMODKEYS only with `extended-keys` | none | **allow** | none; re-check on the 7.0.0 upgrade (kitty arrives, sibling §5) |
| XTWINOPS `CSI … t` (incl. `21 t` title report, `8;r;c t` resize) | inert: all `windowOptions` off, custom `t` gated | answers 14-19, title stack 22/23 | title-report injection if ever enabled | **deny by default** | keep `windowOptions` unset (`OptionsService.ts` L51) |
| OSC 0/1/2 title | `onTitleChange` only | sets `#{pane_title}` (`allow-set-title`) | XSS only if rendered as HTML | **allow** | don't subscribe, or render as text; prefer `#{pane_title}` |
| OSC 8 hyperlink | http(s)-only links, click + `confirm()` + `window.open(opener=null)` | stores link, emits in `-e` | phishing text vs URI; `file:` ignored | **intercept** | `options.linkHandler = { activate: (e, uri) => openOutputUrl(uri) }`, never `allowNonHttpProtocols` |
| OSC 52 clipboard set / `?` | nothing (no addon); addon 0.2.0 would write and **read** `navigator.clipboard` into the pane | ignored at default `set-clipboard external` | clipboard exfiltration if the addon is ever loaded | **deny** | do not load `@xterm/addon-clipboard`; pin `p.registerOscHandler(52, ()=>true)` so a later addon cannot win the chain |
| OSC 4 ; i ; colour (set) | repaints palette index | sets pane palette, redraws | cosmetic | **allow** | none (restore with `OSC 104` on re-seed) |
| OSC 10/11/12 set | changes fg/bg/cursor until reset or next theme write | sets pane style | unreadable panel; clobbered by flavour flips | **deny** | `p.registerOscHandler(n, ()=>true)` for 10, 11, 12 (covers `?` too) |
| OSC 4/10/11/12 `?` query | replies `rgb:` (browser) | replies from pane palette | injection | **intercept** | `p.registerOscHandler(4, d => isQuery(d))` where `isQuery` matches a `?` slot (regex in §2); 10-12 denied above |
| OSC 104/110/111/112 restore | restores | restores | none | **allow** | none |
| OSC 7, 9, 133, 777, 1337 and any other OSC | ignored, not accumulated | 7 path, 9;4 progress, 133 prompt flags | none | **allow** | none; never load `@xterm/addon-image` |
| `DCS tmux; … ST` passthrough, sixel `DCS q`, other DCS | ignored | passthrough only with `allow-passthrough` (default off) | none | **allow** | none |
| APC / PM / SOS strings (kitty graphics etc.) | skipped to ST | ignored | none | **allow** | none |
| RIS `ESC c`, DECSTR `CSI ! p` | full / soft reset; hooks survive | resets pane state | history loss (RIS) as on any terminal | **allow** | none; re-seed if history matters |
| DECCKM 1, DECKPAM 66, bracketed paste 2004, focus 1004 | input encoding changes; `CSI I/O` on focus | tracks the same modes | none | **allow** | forward `onData` verbatim; paste via `terminal.paste()` |
| Mouse 9/1000/1002/1003 + 1006/1016 | reports on `onData`/`onBinary`; selection off | tracks the same modes | operator trap (no selection, wheel → reports) | **allow** | forward both events; keep kill / swap-to-terminal; consider force-selection modifier |
| Alternate screen 47/1047/1049 | buffer swap, no scrollback | tracks | history hidden while set | **allow** | seed handles `alternate_on` |
| Synchronized output 2026 | deferred paint, 1 s auto-release | tracks | none | **allow** | none (5.5.0: ignored) |
| DECCOLM `CSI ? 3 h` | inert without `setWinLines` | resets | none | **allow** (stays inert) | keep `windowOptions` unset |
| 8-bit C1 introducers | honoured as CSI/OSC/DCS | treated as UTF-8 text | bypass of any ESC-keyed server filter | **intercept** | enforcement lives in the parser hooks, which see both forms (probe §3) |
| BEL | `onBell` event | n/a | none | **allow** | optional attention cue later |
| Backlog and size | 50 MB throw, unresponsive far earlier | `pause-after` | memory / stall | **server** | per-viewer ack watermark, `pause-after` + re-seed, 96 KB seed cap, `scrollback` per pane |

## Sources

- Console: `apps/server/src/tmux/adapter.ts` (L14-40 `safeSnapshot`, L137 capture and
  `.slice(-96_000)`), `apps/server/src/app.ts:309` (CSP), `apps/web/src/main.tsx` (L241 tab cache,
  L4000-4013 terminal options and addons), `apps/web/package.json:14-16`, all at `3184a59`.
- xterm.js 6.0.0 tag: `src/common/InputHandler.ts`, `src/common/parser/{EscapeSequenceParser,
  OscParser, DcsParser, Constants, Params}.ts`, `src/common/{CoreTerminal, CircularList}.ts`,
  `src/common/services/{OptionsService, OscLinkService, CoreService}.ts`,
  `src/common/buffer/{Buffer, BufferSet, BufferLine}.ts`, `src/common/input/WriteBuffer.ts`,
  `src/browser/{CoreBrowserTerminal, OscLinkProvider, Linkifier, Clipboard}.ts`,
  `src/browser/services/{RenderService, ThemeService}.ts`, `typings/xterm.d.ts`,
  `addons/addon-clipboard/{src/ClipboardAddon.ts, typings/addon-clipboard.d.ts, package.json}`
  (0.2.0), `addons/addon-web-links/src/WebLinksAddon.ts` (0.12.0),
  `addons/addon-image/{src/ImageAddon.ts, README.md}` (0.9.0), the `addons/` tree listing, and the
  6.0.0 release notes (2025-12-22). Version choice per `docs/research/xterm-6-for-streamed-terminal.md`
  §6.1.
- xtermjs.org guides: "Hooks" (`_docs/guides/hooks.md`, handler order and return semantics) and
  "Security" (`_docs/guides/security.md`, "terminal to HTML/JS attack vector").
- GitHub advisory database: GHSA-mc23-976p-j42x / CVE-2019-0542; xterm.js release 3.9.2.
- tmux 3.7b tag: `input.c`, `control.c`, `window.c`, `tty.c`, `server-client.c`, `grid.c`,
  `cmd-capture-pane.c`, `options-table.c`, `tmux.1`.
- XTerm Control Sequences, `ctlseqs.txt` Patch #411 (2026-08-23): DA1/DA2/DA3 L769-811, DSR
  L1383-1436, DECRQM L1502-1520, XTVERSION L1531-1533, XTWINOPS L1620-1627 and L1689, OSC 52
  L2156-2180, DECRQSS L478-490, DECSET 1003/1004/1006/1049/2004 L977-1043.
- Kitty keyboard protocol (`sw.kovidgoyal.net/kitty/keyboard-protocol`), "Detection of support for
  this protocol"; contour synchronized-output spec (christianparpart gist, DECRQM L21-22, BSU/ESU
  L39-49); OSC 8 hyperlink spec (egmontkob gist, schemes L75, Security L159-171).
- `docs/research/probes/raw-stream-probe.mjs`, run 2026-09-06 with `@xterm/headless@6.0.0`
  (`node raw-stream-probe.mjs` for sections 1-4, 6, 7; `node --max-old-space-size=2048
  raw-stream-probe.mjs 5` for the REP case). The 5.5.0 run of the same script agreed on every row
  except DECRQM 2026 (0, not recognised) and died on the REP case.
