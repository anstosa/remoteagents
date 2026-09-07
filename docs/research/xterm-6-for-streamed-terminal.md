# xterm.js 6.0 versus 5.5 for a streamed terminal

Whether the first-class terminal panes (fed by tmux control mode, see `tmux-pane-io-options.md` §7-8)
should be built on `@xterm/xterm` 6.0.0 or newer instead of the 5.5.0 the web app locks today, and
which renderer to use on a phone versus a desktop. This extends §4 of `tmux-pane-io-options.md`,
which already holds the 5.5.0 facts; nothing there is re-derived. Gathered 2026-09-06 on branch
`research/xterm-6` off `terminal` (tip `3184a59`) for the effort "First-class terminal panes via
tmux control mode".

**Sources.** xterm.js facts come from the npm registry JSON for `@xterm/xterm`, `@xterm/headless`
and the addons (fetched 2026-09-06), the `@xterm/xterm` 6.0.0 and 6.1.0-beta.304 tarballs (both
ship `src/`, `typings/` and `css/`; cited as `file Lnn @ 6.0.0` or `@ beta.304`), the
`@xterm/addon-webgl` 0.19.0 and `@xterm/addon-fit` 0.11.0 tarballs, the 5.5.0 package in the main
checkout's `node_modules` for diffs, the xtermjs/xterm.js GitHub API (tags, releases, milestone
81, issues and PRs, cited by number) and the repository at tag `6.0.0` and `master` via jsDelivr.
VS Code facts come from `microsoft/vscode` `main` (`package.json` version `1.138.0`, fetched
2026-09-06 through two mirrors) and the three terminal source files cited by name. Console code is
cited as `path:line` at `3184a59`. Nothing here was measured; §4 of the earlier note has the
render-loop facts that still apply.

## TL;DR

- **There is exactly one 6.x release: 6.0.0 (2025-12-22).** No 6.0.1 or 6.1.0 tag exists; npm
  `latest` is still 6.0.0 and `beta` is `6.1.0-beta.304` (2026-08-30), the 304th nightly-style
  beta since the release. Every fix since, including the touch-scroll fix (#5563, merged
  2025-12-31) and the kitty keyboard protocol (#5600, merged 2026-01-10), sits on `master` under
  the **7.0.0 milestone**, which has no due date, 7 open issues and 464 closed, and two fresh
  "important" regressions filed by a maintainer in August 2026. **No 7.0 date is published**.
  VS Code itself runs the betas (`^6.1.0-beta.303`), not 6.0.0.
- **6.0.0's viewport is VS Code's `SmoothScrollableElement`.** Desktop wheel and trackpad are
  handled well (normalised deltas, physical-wheel classifier, Alt fast-scroll, smooth scroll only
  for physical wheels and only when `smoothScrollDuration > 0`). **Touch does nothing in 6.0.0**:
  the touch handlers 5.5.0 had were dropped and the replacement lives only on `master`. With
  `scrollback: 0`, wheel becomes one arrow-key sequence per event with partial-line accumulation
  for trackpads, which is better than 5.5.0's unconditional one-arrow-per-line.
- **The API the `Log` component uses is unchanged**: `attachCustomKeyEventHandler`, `onData`,
  `onBinary`, `reset()`, `write(data, cb)`, runtime `options.theme`/`options.fontSize`,
  `screenReaderMode`, `buffer.active.viewportY/getLine`, `getSelectionPosition`, and the DOM
  classes the console and its e2e specs query (`.xterm-screen`, `.xterm-rows`,
  `.xterm-helper-textarea`, `.xterm-char-measure-element`, `.xterm-accessibility*`) all exist in
  6.0.0. Breaking changes (`windowsMode`, `fastScrollModifier`, `overviewRulerWidth`, canvas addon,
  alt→ctrl+arrow hack) touch nothing the console sets. The console's `.xterm-viewport` CSS override
  becomes inert because `.xterm-viewport` is no longer the scroll container.
- **Addons at 6.0.0 carry no `peerDependencies`** (5.x addons declared `^5.0.0`), so pnpm will not
  catch a mismatch; the set must be pinned by hand: fit 0.11.0, web-links 0.12.0, webgl 0.19.0,
  serialize 0.14.0, unicode11 0.9.0, clipboard 0.2.0, headless 6.0.0. The next major moves
  `overviewRuler` again (into `scrollbar.overviewRuler`) and removes `customGlyphs`.
- **Renderer**: DOM is the default and the only one that works everywhere; WebGL is the addon.
  Canvas is gone. Maintainer statements: the DOM renderer is "way faster now than it used to be"
  and "there must always be a fallback to DOM" (Tyriar, #4779). Open WebGL problems: Safari on
  macOS 26.5 renders garbage (#5816, open), high-DPR scaling on mobile (#4728, open), WKWebView
  ghosting (#5847; fix merged for 7.0.0 only). VS Code defaults to `gpuAcceleration: 'auto'`,
  loads WebGL first, falls back to DOM on load failure or context loss, and has no Safari gate.
- **Kitty keyboard / CSI u is not in any 6.x release.** It is `vtExtensions.kittyKeyboard`
  (default false) from `6.1.0-beta.99` onward and is milestoned 7.0.0.
- **Recommendation**: pin `@xterm/xterm` **`6.0.0` exactly** (not `^`) with the matching addon set
  when the terminal-pane work starts; own touch scrolling in the console (a ~15-line handler
  mirroring #5563 and the beta's three-mode `MouseService`, which the console needs anyway for
  tmux panes); DOM renderer plus `screenReaderMode` on coarse pointers, WebGL addon with
  `onContextLoss → dispose → DOM` on desktop except Safari; re-evaluate at 7.0.0 for touch, kitty,
  `scrollbar.showScrollbar` and the DEC 2026 viewport deferral. Migration risks to `Log` are
  listed in §6.3; none is structural.

## 1. Releases since 6.0.0, the touch regression, and the 7.0 timeline

- Tags on xtermjs/xterm.js, newest first: `6.0.0` (`f447274`), `5.5.0` (`9ba6c00`), `5.4.0`,
  … (GitHub tags API, 40 tags listed). No `6.0.1`, `6.1.0` or `7.x` tag exists.
- npm `@xterm/xterm`: stable versions `5.5.0` (2024-04-05T14:01Z) and `6.0.0`
  (2025-12-22T13:50Z); `dist-tags` `latest: 6.0.0`, `beta: 6.1.0-beta.304`; 304 betas from
  `6.1.0-beta.1` (2025-12-22T15:28Z) to `6.1.0-beta.304` (2026-08-30T20:13Z) (npm registry,
  `@xterm/xterm`, fetched 2026-09-06). `master`'s `package.json` still says `"version": "6.0.0"`
  (jsDelivr `xtermjs/xterm.js@master/package.json`, 2026-09-06); the beta number is applied at
  publish time (#5143 in the 6.0.0 notes: "Publish commit and set peerDependencies to @xterm/xterm
  beta when publishing").
- 6.0.0 release published 2025-12-22T13:59:51Z. Headline items with the maintainers' own
  warnings: #5096 "Integrate base/ platform from VS Code and adopt scroll bar" ("potential
  breaking change, the viewport/scroll bar works very differently now"); #5107 overview ruler
  options (`overviewRulerWidth` → `overviewRuler.width`); #5462 remove deprecated `windowsMode`
  and `fastScrollModifier`; #5346 "Remove alt -> ctrl+arrow hack in favor of embedder-specific
  solutions"; #5105 "Remove the canvas renderer" ("we recommend using either the DOM renderer or
  WebGL"); #5453 synchronized output (DEC mode 2026); #5092 ESM via esbuild; #4220 OSC 52;
  #5391 "Bring back partial wheel tracking"; #5437 "Prevent entire page from scrolling when
  scrolling in alt buffer with mouse event off"; #5024 "Fix duplicate input for some IMEs";
  #5282 CapsLock double input on macOS (6.0.0 release notes).
- **Touch regression #5489** "Regression - Touch scrolling not functioning in 6.0.0": opened
  2025-12-24, labels `type/bug`, `area/mouse`, `area/mobile`, milestone **7.0.0**, closed
  2025-12-31T14:33:37Z by Tyriar as completed. Tyriar's only comment links #5377 (the open "Limited
  touch support on mobile devices" proposal, `help wanted`). The fix is PR #5563 "Fix touch
  scrolling" (Tyriar, merged 2025-12-31T14:33:36Z into `master`, milestone 7.0.0): +15/-1 in
  `src/browser/Viewport.ts`, registering `Gesture.addTarget(screenElement)` and a
  `_handleGestureChange` that sets `scrollTop: pos.scrollTop - e.translationY` (#5563 files
  patch). The first beta carrying it is `6.1.0-beta.75` (2025-12-31T14:35Z, npm registry).
  **It is on no 6.x release line; only betas and the eventual 7.0.0.**
- On `master` the fix has since moved: `Viewport.ts` exposes `handleTouchScroll(translationY)`
  (`Viewport.ts L221-226 @ beta.304`) and `MouseService.bindMouse` attaches the gesture recogniser
  to the screen element (`MouseService.ts L99-101 @ beta.304`) with three modes: when the program
  has enabled wheel reporting, touch becomes mouse-wheel reports; when the buffer has no
  scrollback, touch becomes one `CSI A/B` (or `SS3`) per cell height of travel; otherwise the
  viewport scrolls (`MouseService.ts L300-317, L320-343, L346-372 @ beta.304`;
  `CoreBrowserTerminal.ts L659-664 @ beta.304`). That is the behaviour 7.0.0 will ship.
- **7.0.0 milestone** (number 81): open, created 2025-12-22T14:16Z, updated 2026-08-24,
  `due_on: null`, 7 open / 464 closed (GitHub milestones API). Open items: #6106 "massive
  performance degradation" (jerch, 2026-08-14, `important`: ~30 % of cycles in `Viewport.ts`
  scrollbar handling under a 34 MB SGR-heavy load; partially fixed by #6114/#6122, remaining
  cause is `TimeoutTimer` use in `WriteBuffer` and `SmoothScrollableElement._scheduleHide`, jerch
  2026-08-20), #6123 "scrollbar visibility handling partially broken" (jerch, 2026-08-20: Chrome
  shows no scrollbar at all on a large dump, Firefox fades it), #5893 "DOM renderer emoji layout
  regression" between `6.1.0-beta.64` and `beta.65` (so not in 6.0.0), #5854 WebGL tests broken
  on Safari/Firefox, #5755, #5731, #5706 (image addon). No issue or PR titled with a 7.0 or 6.1
  release plan exists (GitHub search, `in:title`, 0 results for both), so **no timeline can be
  cited**.
- VS Code `main` depends on `@xterm/xterm ^6.1.0-beta.303`, `@xterm/addon-webgl
  ^0.20.0-beta.299`, `@xterm/headless ^6.1.0-beta.302` and beta addons throughout
  (`microsoft/vscode` `package.json` version `1.138.0`, fetched 2026-09-06). The stable 6.0.0 is
  therefore a snapshot the largest embedder does not run; the betas are where the traffic is, and
  the August 2026 regressions above were found there.

## 2. The 6.0 viewport and scrollbar for a stream-fed terminal with scrollback

### 2.1 Structure

- `Viewport` (192 lines at 6.0.0) builds a `Scrollable` with `smoothScrollDuration` from the
  option and rAF scheduling (`Viewport.ts L43-51 @ 6.0.0`) and a `SmoothScrollableElement` around
  the screen element with `vertical: Auto`, `horizontal: Hidden`, `useShadows: false`,
  `mouseWheelSmoothScroll: true`, plus `scrollSensitivity`, `fastScrollSensitivity` and
  `overviewRuler.width` (default `DEFAULT_SCROLL_BAR_WIDTH = 14`, `Constants.ts L7`) as change
  options (`L53-64, L126-132`). Scroll dimensions are `height = canvas css height`,
  `scrollHeight = cell height × buffer.lines.length` (`L159-162`); the element's `onScroll` maps
  `scrollTop` to a row and fires `onRequestScrollLines` (`L176-191`), which the terminal turns into
  `super.scrollLines(e, false)` plus a full refresh (`CoreBrowserTerminal.ts L512-516 @ 6.0.0`).
  Every public `scrollLines`/`scrollToBottom`/`scrollToLine` goes through the viewport "in order
  to support smooth scroll" (`L877-885, L895-908`).
- DOM: `.xterm-scrollable-element` (`position: relative`, `role=presentation`) now wraps
  `.xterm-screen` (`scrollableElement.ts L228-234 @ 6.0.0`; `Viewport.ts L76`). `.xterm-viewport`
  is still created (`CoreBrowserTerminal.ts L426-428`) but only hosts the overview ruler
  (`L562-566`) and is handed to the DOM renderer (`L584`); `xterm.css` still styles it as an
  absolutely positioned `overflow-y: scroll` box (`xterm.css L93-100 @ 6.0.0`). The scrollbar is
  VS Code's overlay scrollbar: `visible`/`invisible` classes with a 100 ms fade-in and an 800 ms
  fade-out (`xterm.css L237-253`), slider colours from three new theme keys (§2.6).
- When the program enables wheel reporting (tmux `mouse on` does), the viewport stops listening to
  wheel (`handleMouseWheel: !(type & WHEEL)`, `Viewport.ts L65-70`) and the mouse binding sends
  reports instead (`CoreBrowserTerminal.ts L710-713, L751-757`). A tmux pane with the mouse on
  therefore scrolls tmux's copy mode, never xterm's buffer, exactly as in 5.5.0 (§4.2 of the
  earlier note).

### 2.2 Desktop wheel and trackpad, with scrollback

- `_onMouseWheel` (`scrollableElement.ts L391-491 @ 6.0.0`) returns early if the event is already
  `defaultPrevented` (`L392`); multiplies deltas by `mouseWheelScrollSensitivity` (`L407-408`);
  applies `fastScrollSensitivity` when Alt is held (`L436-440`); converts to pixels with
  `SCROLL_WHEEL_SENSITIVITY = 50` per normalised unit, rounding away from zero "otherwise low speed
  scrolling will never scroll" (`L23, L446-448`); scrolls smoothly only when
  `mouseWheelSmoothScroll` is on **and** `MouseWheelClassifier.isPhysicalMouseWheel()` (a
  five-sample weighted score, `L45-75`) says the device is a real wheel, otherwise
  `setScrollPositionNow` (`L463-472`); and consumes the event (`preventDefault` +
  `stopPropagation`) only if it actually scrolled, since `alwaysConsumeMouseWheel` and
  `consumeMouseWheelIfScrollbarIsNeeded` default to false (`L479-490, L687-688`). So at the top or
  bottom of history the wheel event **propagates to the page**; a host that must not scroll the
  page needs its own containment, which the console already has (`output-scroll.ts:8-9`).
- Deltas are normalised per browser by `StandardWheelEvent`: Chrome `wheelDeltaY / 120` (÷ DPR in
  some cases), Firefox `DOM_DELTA_LINE / 3` off macOS, pixel mode `/ 40` (`mouseEvent.ts L140-192
  @ 6.0.0`). The listener is registered `{ passive: false }` on the scrollable element's own node
  (`scrollableElement.ts L256, L387`).
- Net: with `scrollback > 0` a desktop user gets the Editor's wheel feel, trackpads are detected
  and not animated, Alt is fast-scroll (`fastScrollModifier` is gone: Alt is hard-coded,
  `L436`), and Shift+wheel converts to horizontal off macOS (`L429-433`) which is a no-op with the
  horizontal bar hidden.

### 2.3 Wheel without scrollback (the console's mode today)

- The core keeps its own `wheel` listener on the terminal element (`CoreBrowserTerminal.ts
  L604, L806-843 @ 6.0.0`): nothing if the program reports wheel (`L808`); nothing if
  `attachCustomWheelEventHandler` returns false (`L810-812`); else, if the buffer has no scrollback
  ("enables scrolling in apps hosted in the alt buffer such as vim or tmux even when mouse events
  are not enabled", `L815-818`), it calls `consumeWheelEvent` and sends **one** `CSI A/B` (or
  `SS3 A/B` under DECCKM) per event when the accumulated amount reaches a line, then cancels the
  event so the page does not scroll (`L828-841`; that cancel is #5437).
- `consumeWheelEvent` (`CoreMouseService.ts L241-269 @ 6.0.0`) divides pixel deltas by
  `cellHeight / dpr`, multiplies by 0.3 when `|deltaY| < 50` ("likely trackpad"), accumulates
  `_wheelPartialScroll` and only yields whole lines (`L254-264`); page mode multiplies by rows
  (`L265-267`); Alt/Ctrl/Shift apply `fastScrollSensitivity × scrollSensitivity` (`L271-277`).
  This is #5391 "Bring back partial wheel tracking" (merged 2025-09-10, milestone 6.0.0, "Part of
  microsoft/vscode#224750", the VS Code 1.92 report that full-screen apps scrolled far too fast
  and locked up). The source comment admits the simplification: it "used [to] get the actual
  lines/partial lines scrolled from the viewport but … has been simplified to simply send a
  single up or down sequence" (`L819-821`).
- Compared with 5.5.0, which typed one arrow per line unconditionally (`tmux-pane-io-options.md`
  §4.1), 6.0.0 is strictly better for a `scrollback: 0` tmux pane on a trackpad, and it no longer
  needs the console to swallow wheel to stop page scroll (it still needs it to stop the arrows).

### 2.4 Mobile touch

- **6.0.0 has no touch handling at all.** The only `touch` strings in `src/browser` outside
  `src/vs` are the stale `IViewport.handleTouchStart/handleTouchMove` declarations in `Types.ts
  L103-107 @ 6.0.0`, which nothing implements; `Viewport.ts` at 6.0.0 has no listener and
  `src/vs/base/browser/touch.ts` is shipped but unused. 5.5.0 had `touchstart`/`touchmove` on the
  terminal element applying the delta to `scrollTop` (earlier note §4.1). With `scrollback: 0`
  neither version does anything on touch; with `scrollback > 0`, **6.0.0 cannot scroll history by
  touch** and 5.5.0 can (without momentum).
- The beta/7.0 behaviour (§1) is what the console wants in the end: touch as wheel reports when
  tmux has the mouse on, arrow keys when not, viewport scroll when xterm holds history. Until
  7.0.0 that logic has to live in the console: a `Gesture`-free version is a `touchstart`/
  `touchmove` pair accumulating `translationY / cellHeight` and calling `terminal.scrollLines(n)`
  (public, `xterm.d.ts L1186-1201 @ 6.0.0`) or sending arrows, which mirrors `MouseService.ts
  L320-343 @ beta.304` in about fifteen lines. The console already owns `touchmove` on the pane
  host in capture phase (`output-scroll.ts:9`), so the hook point exists.
- Other open mobile items unchanged by 6.0: copy/paste on touch devices (#3727, open since 2022;
  PR #5961 "Enable native touch copy and paste on iOS", open 2026-05-29, explicitly "for terminals
  rendered with DOM rows"), the "blind spot" statement in #5377 (earlier note §4.6).

### 2.5 Smooth scrolling and synchronized output

- `smoothScrollDuration` (`xterm.d.ts L271-275 @ 6.0.0`, default 0, `OptionsService.ts L39`) is
  the `Scrollable`'s animation length; `scrollLines` reuses a running animation (`Viewport.ts
  L108-114`), `scrollToBottom(true)` on user keydown snaps without animation (`CoreBrowserTerminal.ts
  L1034, L895-901`). With the default 0 every scroll is immediate even though
  `mouseWheelSmoothScroll` is on. VS Code enables 125 ms only when its `smoothScrolling` setting
  (default `false`) is on and a physical wheel was detected (`xtermTerminal.ts`
  `_updateSmoothScrolling`, `RenderConstants.SmoothScrollDuration = 125`;
  `terminalConfiguration.ts` `SmoothScrolling` default `false`).
- 6.0.0 adds DEC private mode 2026 synchronized output (#5453) and exposes
  `modes.synchronizedOutputMode` (`xterm.d.ts L1951 @ 6.0.0`), so a TUI that brackets a redraw in
  `CSI ? 2026 h/l` is painted atomically. The beta goes further and defers the viewport's DOM
  scroll sync until the render after ESU "to prevent visible scroll position flickering while the
  canvas content is frozen" (`Viewport.ts L109-116, L176-181 @ beta.304`); that refinement is
  7.0-only.

### 2.6 Scrollbar, fit, and theme

- Three theme keys drive the overlay scrollbar: `scrollbarSliderBackground`,
  `scrollbarSliderHoverBackground`, `scrollbarSliderActiveBackground` (`xterm.d.ts L365-375 @
  6.0.0`), defaulting to the foreground at 0.2/0.4/0.5 opacity (`ThemeService.ts L61-63, L108-110
  @ 6.0.0`); `overviewRulerBorder` is the fourth new key (`L381`). The viewport re-injects the
  slider rules on every theme change (`Viewport.ts L82-94`), so runtime `options.theme` swaps
  restyle it.
- The scrollbar cannot be hidden by option in 6.0.0; `scrollbar.showScrollbar` and
  `scrollbar.showArrows` arrive with the beta (`xterm.d.ts L740-762 @ beta.304`; `Viewport.ts
  L141-156 @ beta.304`). Hiding it in 6.0.0 means transparent slider colours or CSS on
  `.xterm-scrollable-element > .scrollbar`.
- `@xterm/addon-fit` 0.11.0 reserves `overviewRuler?.width || 14` px for the scrollbar whenever
  `scrollback !== 0` and nothing when it is 0 (`FitAddon.ts L68-70 @ 0.11.0`); it still reads the
  private `_core._renderService.dimensions` ("TODO: Remove reliance on private API", `L60-62`).
  Turning history on therefore costs 14 px of width unless `overviewRuler.width` is set.

## 3. Addon pairings, peer ranges, and API changes

### 3.1 Pairings at 6.0.0

All published 2025-12-22T13:50-51Z alongside the core (npm registry, fetched 2026-09-06):

| package | 6.0.0 pairing | 5.5.0 pairing | beta pairing (peer `^6.1.0-beta.304`) |
| --- | --- | --- | --- |
| `@xterm/addon-fit` | 0.11.0 | 0.10.0 | 0.12.0-beta.301 |
| `@xterm/addon-web-links` | 0.12.0 | 0.11.0 | 0.13.0-beta.301 |
| `@xterm/addon-webgl` | 0.19.0 | 0.18.0 | 0.20.0-beta.300 |
| `@xterm/addon-serialize` | 0.14.0 | 0.13.0 | 0.15.0-beta.301 |
| `@xterm/addon-unicode11` | 0.9.0 | 0.8.0 | 0.10.0-beta.301 |
| `@xterm/addon-clipboard` | 0.2.0 (dep `js-base64 ^3.7.5`) | 0.1.0 | 0.3.0-beta.303 (no deps) |
| `@xterm/headless` | 6.0.0 | 5.5.0 | 6.1.0-beta.303 |
| `@xterm/addon-search` | 0.16.0 | 0.15.0 | 0.17.0-beta.301 |
| `@xterm/addon-attach` | 0.12.0 | 0.11.0 | 0.13.0-beta.303 |
| `@xterm/addon-canvas` | none (removed, #5105) | 0.7.0 (peer `^5.0.0`) | none since 0.8.0-beta.48, 2024-07 |

### 3.2 Peer ranges

- The stable 6.0-era addons publish **no `peerDependencies`** (`versions["0.11.0"].peerDependencies`
  is absent for fit; 0.10.0 declared `^5.0.0`; the same holds for webgl 0.19.0 versus 0.18.0),
  and the repo's addon `package.json` files at tag `6.0.0` carry none either (jsDelivr,
  `addons/addon-*/package.json @ 6.0.0`). Only the betas declare `^6.1.0-beta.304`. pnpm will not
  flag a 5.x addon against a 6.0 core or a 6.0 addon against a future 7.0 core, so the pairing
  must be pinned by hand.
- The console's lock today is `@xterm/xterm 5.5.0` with `addon-fit 0.10.0` and `addon-web-links
  0.11.0`, both declaring peer `^5.0.0` (`pnpm-lock.yaml:808-819`); an upgrade must bump all
  three together.
- The coupling is real, not nominal: fit 0.11.0 reads `options.overviewRuler?.width`
  (`FitAddon.ts L70 @ 0.11.0`), and the beta typings have already moved that option to
  `scrollbar.width` (§3.5), so a 6.0 fit on a 7.0 core would silently mis-size.

### 3.3 API diff 5.5.0 → 6.0.0 (`typings/xterm.d.ts`, 1908 → 1957 lines, 252 diff lines)

- Removed from `ITerminalOptions`: `fastScrollModifier`, `windowsMode` (#5462),
  `overviewRulerWidth` (#5107). Added: `reflowCursorLine` (`L214`), `scrollOnEraseInDisplay`
  (`L258`), `overviewRuler: IOverviewRulerOptions { width, showTopBorder, showBottomBorder }`
  (`L321`, `L153-173` of the diff), the four theme keys of §2.6, and `modes.synchronizedOutputMode`
  (`L1951`). `ITerminalInitOnlyOptions` is still just `cols`/`rows` (`L328-340`).
- Unchanged signatures the console depends on: `attachCustomKeyEventHandler((ev) => boolean)`
  (`L1072`), `attachCustomWheelEventHandler` (`L1094`), `onData: IEvent<string>` (`L943`),
  `onBinary: IEvent<string>` (`L928`), `onScroll: IEvent<number>` (`L990`), `onSelectionChange`
  (`L996`), `onWriteParsed` (`L976`), `write(data, callback?)` (`L1253`), `writeln` (`L1268`),
  `reset()` (`L1296`), `theme?: ITheme` (`L285`), `fontSize` (`L118`), `screenReaderMode` (`L244`),
  `scrollback` (`L251`), `buffer: IBufferNamespace` (`L841`) with `active` (`L1573`), `viewportY`
  (`L1525`), `baseY` (`L1531`), `getLine` (`L1548`), `getSelectionPosition` (`L1173`). The public
  event type is still `IEvent<T>` (`L474`); internally the emitters are VS Code's `Emitter`
  (`public/Terminal.ts` diff), which does not change the `(listener) => IDisposable` shape.
- Implementation-level checks for those members at 6.0.0: the custom key handler still runs on
  keydown, keypress and keyup (`CoreBrowserTerminal.ts L1025, L1122, L1149`) and is carried across
  `reset()` together with rows and cols (`L1268-1288`); `reset()` is still synchronous and still
  does not flush queued writes (doc at `L1262-1267` recommends RIS for in-band resets); `write`'s
  buffer changed only `Date.now()` → `performance.now()` (#5445; `WriteBuffer.ts` diff);
  `screenReaderMode` still creates the `AccessibilityManager` at open and on option change
  (`L554-559, L256-259`) with the same `.xterm-accessibility` and `.xterm-accessibility-tree`
  classes (`AccessibilityManager.ts L63, L67`); the helper textarea is still
  `.xterm-helper-textarea` (`L441`), the screen `.xterm-screen` (`L431`), rows `.xterm-rows`
  (`DomRenderer.ts L21`), and the measure element `.xterm-char-measure-element`
  (`WidthCache.ts L58`).
- Packaging: 6.0.0 adds `"module": "lib/xterm.mjs"` next to `lib/xterm.js` (`package.json L5-6 @
  6.0.0`; 5.5.0 had only `main`), which Vite prefers.

### 3.4 What the `Log` component uses, member by member (`apps/web/src/main.tsx @ 3184a59`)

| use | line | 6.0.0 status |
| --- | --- | --- |
| `new XTerm({ convertEol, fontFamily, fontSize, scrollback: 0, screenReaderMode, theme })` | 4003 | all options exist; none removed |
| `loadAddon(new FitAddon())`, `open()`, `fit()` | 4013-4021 | fit 0.11.0 required; reserves 0 px while `scrollback` is 0 |
| `terminal.rows/cols` for viewport and history paging | 4059, 4066 | unchanged |
| `options.fontSize = px` and `element.style.fontSize` | 4083-4084 | unchanged |
| `options.theme = {...}` on palette change and on selection | 4094, 4123 | unchanged; add the three slider colours once history is on |
| `attachCustomKeyEventHandler` (Tab/Shift+Tab, Ctrl/Cmd+C copy) | 4137-4151 | unchanged semantics |
| `hasSelection`, `getSelection`, `getSelectionPosition`, `clearSelection` | 4107-4123, 4192-4216 | unchanged |
| `element.querySelector('.xterm-screen')` and `buffer.active.viewportY` for the selection toolbar | 4208-4212 | class and property unchanged |
| `write(text, cb)` then `scrollToBottom()` | 4267-4268 | unchanged; `scrollToBottom` now routes through the viewport |
| `onSelectionChange`, `onData` (mobile modifier synthesis) | 4274, 4285-4290 | unchanged |
| double buffer: `reset()` + `write(viewport, cb)` + deferred `previousTerminal.reset()` | 4382-4395, 4419 | unchanged; `reset()` keeps the viewport instance and re-syncs it through `onBufferActivate` (`Viewport.ts L97-102`) |
| `dispose()` | 4540 | unchanged |
| link overlay reads `buffer.active.getLine/getNullCell/length`, `.xterm-screen` bounds, `viewportY` | `output-links.ts:21-66, 127-138` | unchanged |
| `containOutputScroll`: capture-phase `wheel`/`touchmove` `preventDefault` + `stopImmediatePropagation` on the host | `output-scroll.ts:1-15` | still blocks xterm from seeing either event; must be lifted per-pane when history scrolling is wanted |
| CSS `.xterm .xterm-viewport { overflow: hidden !important; scrollbar-width: none }` | `styles.css:541-542` | inert: `.xterm-viewport` no longer scrolls; the scrollbar is in `.xterm-scrollable-element` |
| CSS on `.xterm-accessibility`, `-tree`, `.xterm-helper-textarea` for coarse pointers | `styles.css:546-549` | classes unchanged |
| e2e selectors `.xterm-rows`, `.xterm-screen`, `.xterm-char-measure-element`, `.xterm-helper-textarea` | `apps/web/e2e/*.spec.ts` | all exist |

### 3.5 What the next major changes again (typings at `6.1.0-beta.304`, 2243 lines, 597 diff lines)

- `overviewRuler` leaves `ITerminalOptions` for `scrollbar: IScrollbarOptions { showScrollbar,
  showArrows, width, overviewRuler }` (`xterm.d.ts L292, L740-762 @ beta.304`); `customGlyphs` is
  removed; `vtExtensions` (§5), `quirks`, `mouseEventsRequireAlt`, `blinkIntervalDuration`,
  `showCursorImmediately`, `screenElement`, `dimensions`/`onDimensionsChange`,
  `registerApcHandler` and `IBufferCell` underline getters are added (diff of the two typings). A
  `^6.0.0` range would not pull these (they are a major), but it is a reason to keep the option
  object in one place and to pin exact versions rather than `^`.
- The platform layer was re-homed from `src/vs/base/...` into `src/browser/scrollable/` and
  `src/common/` (`Viewport.ts` import diff), so `master` no longer vendors VS Code's `base/`
  verbatim; behaviour described in §2 is the same code under new paths.

## 4. Renderer: DOM versus WebGL

- **Default is DOM**: `_createRenderer()` instantiates `DomRenderer` (`CoreBrowserTerminal.ts
  L584 @ 6.0.0`); WebGL is `@xterm/addon-webgl`, "a WebGL2-based renderer" (`addon-webgl README
  L3 @ 6.0.0`). Canvas was removed by #5105 (merged 2024-07-14, milestone 6.0.0, fixes #4779).
  #4779's rationale: canvas had been kept for "certain Linux configurations, virtual machines, and
  iOS/Safari" without WebGL, and "WebGL2 support shipping in Safari/WebKit" plus #4605 removed the
  need. In that thread Tyriar wrote "The dom renderer is actually way faster now than it used to
  be" (2024-07-15), that scrollback size does not affect DOM render cost ("it only considers the
  viewport", 2024-07-16), and "There must always be a fallback to DOM" (2024-07-16); a contributor
  reported Chrome losing contexts past 16 live WebGL terminals per origin ("The limit for me is 16
  contexts in chrome", davidfiala, 2024-07-16), which jerch acknowledged he had not known. No
  primary source gives a 6.0-era benchmark of DOM versus WebGL on a full-screen redraw; the only
  quantified claim is VS Code's setting text: "The terminal will render much slower when GPU
  acceleration is off but it should reliably work on all systems" (`terminalConfiguration.ts`,
  `GpuAcceleration`).
- **WebGL addon 0.19.0 mechanics**: the constructor throws `Webgl2 is only supported on Safari 16
  and above` when `isSafari && getSafariVersion() < 16` and no `webgl2` context can be created
  (`WebglAddon.ts L34-45 @ 0.19.0`; `Platform.ts L23-25`), unchanged from 0.18.0. On
  `webglcontextlost` it calls `preventDefault`, waits 3000 ms for `webglcontextrestored`, then
  fires `onContextLoss` (`WebglRenderer.ts L110-125 @ 0.19.0`); the README's recommended handling
  is `addon.onContextLoss(() => addon.dispose())` (`README L24-35`), after which the terminal is
  back on DOM. Ignoring the alpha channel when `allowTransparency` is false (#5335) and shadow-DOM
  support (#5334) are the 6.0-era WebGL changes.
- **VS Code's policy** (`xtermTerminal.ts` on `main`): `_shouldLoadWebgl()` is true when
  `gpuAcceleration === 'auto'` and no renderer has been "suggested" yet, or when it is `'on'`;
  `_enableWebglRenderer()` imports the addon lazily, and on failure logs "Webgl could not be
  loaded. Falling back to the DOM renderer", sets the static `_suggestedRendererType = 'dom'` for
  the rest of the session and disposes the addon; `onContextLoss` logs and disposes ("Webgl lost
  context, disposing of webgl renderer"). `enableGpu` on `attachToElement` "defaults to true"
  (`terminal.ts`, `IXtermAttachToElementOptions`). The setting's default is `'auto'`
  (`terminalConfiguration.ts`). The file contains no `isSafari`, `isIOS`, `isMobile` or `isWeb`
  check, so VS Code does not gate WebGL by platform; it relies on the throw-and-fall-back path.
- **Safari and iOS, open items**: #5816 "Broken webgl rendering in Safari on MacOS beta 26.5
  beta" (open, 2026-04-17; jerch suspects "a fingerprint countermeasure done by safari"; embedders
  in the thread reverted to canvas or DOM for OS ≥ 26.5; #5883, a WebGL atlas-page fix for the
  WKWebView ghosting in #5847, merged 2026-05-21 for 7.0.0 and is not in 0.19.0; a further report
  on macOS 15.7 followed the same day). #4728 "[WebGL and Canvas Rendering] Font does not scale
  correctly with DPR higher than 1" (open since 2023, `area/mobile`; jerch: reproduces on canvas
  and WebGL, "Only the DOM renderer does not show it"; later narrowed to devtools emulation
  reporting device pixels). #5854 WebGL addon tests disabled on Safari and Firefox (7.0.0).
  iOS work in flight (#5961) targets DOM rows only.
- Implication for the console: on phones the DOM renderer plus `screenReaderMode` remains the
  only supported combination (this matches the earlier note's §4.6 and #5377). On desktops the
  WebGL addon is the performance path for neovim-style full redraws, guarded exactly as VS Code
  does; Safari should stay on DOM until #5816 closes. Each live WebGL terminal is one GL context,
  and the double-buffered `Log` creates two xterms per pane (`main.tsx:4005-4021`), so a dashboard
  of several panes approaches the reported 16-context ceiling quickly; load the addon only on the
  frame that is visible, or retire the double buffer once frames are streamed rather than
  snapshotted.

## 5. Kitty keyboard protocol and CSI u

- 6.0.0 has none of it: no `kitty` string in `InputHandler.ts` or `Keyboard.ts`, no
  `vtExtensions` in the typings, and `CSI u` is still only SCORC as in 5.5.0 (earlier note §4.7;
  `typings/xterm.d.ts @ 6.0.0` diff shows no such option).
- PR #5600 "Implement kitty keyboard protocol (CSI =|?|>|< u)" (Tyriar, fixes #4198) merged into
  `master` 2026-01-10T12:46:39Z, milestone **7.0.0**, no comments. The first beta containing it is
  `6.1.0-beta.99` (2026-01-10T12:48Z, npm registry). On `master` it is
  `options.vtExtensions.kittyKeyboard` ("The default is false", `xterm.d.ts L465-474 @
  beta.304`), with `kittySgrBoldFaintControl` (default true, #5601), `win32InputMode` (DECSET 9001)
  and `colorSchemeQuery` beside it (`L476-490`); the parser registers the four `CSI … u` forms
  (`InputHandler.ts L259-262 @ beta.304`) and keyboard encoding consults the option
  (`L2022`); the encoder lives in `src/common/input/KittyKeyboard.ts`. A separate "Move key
  handling into KeyboardService" refactor (#5755) is still open on the 7.0.0 milestone.
- So: **no 6.x release has kitty or CSI u**; getting it means a `6.1.0-beta.≥99` build (with the
  August 2026 regressions of §1) or waiting for 7.0.0. For the console this only matters for
  neovim chords in a browser tab; tmux itself passes through whatever the outer terminal encodes.

## 6. Recommendation

### 6.1 Version to pin

Pin `@xterm/xterm` **`6.0.0` exactly** (no caret) with fit 0.11.0, web-links 0.12.0, and, when
used, webgl 0.19.0, serialize 0.14.0, unicode11 0.9.0, clipboard 0.2.0 and headless 6.0.0
(§3.1), when the terminal-pane work starts. The benefits that matter for a streamed tmux pane
are real and 6.0-only: partial wheel tracking so a trackpad over a no-scrollback pane no longer
floods arrow keys and no longer scrolls the page (§2.3); the VS Code wheel path with a
physical-wheel classifier and Alt fast-scroll once history is held client-side (§2.2);
synchronized output for TUI redraws (§2.5); an ESM build; and an API surface that is unchanged
for everything the console uses (§3.3-3.4). Do **not** pin a `6.1.0-beta.*`: the betas carry
7.0's second breaking move of the scrollbar options (§3.5), an `important` throughput regression
and a scrollbar-visibility bug both filed by a maintainer in August 2026 (§1), and no stability
promise. Re-evaluate at the 7.0.0 tag for native touch (three-mode), kitty, `scrollbar.showScrollbar`
and the DEC 2026 viewport deferral; keep the options object in one module so the
`overviewRuler → scrollbar` move is a one-line change then.

Staying on 5.5.0 is defensible only if touch history scrolling must ship before the console owns
touch itself; everything else about 5.5.0's scrolling is worse for this use (§2.3, earlier note
§4.1), and 5.5.0 has no synchronized output.

### 6.2 Renderer per device

- **Phone / coarse pointer**: DOM renderer, `screenReaderMode: true` (as today,
  `main.tsx:4003`). No WebGL: #4728 and #5377 are open, iOS selection work targets DOM rows, and
  the WebGL addon offers nothing for a 40-column view.
- **Desktop**: load `@xterm/addon-webgl` 0.19.0 after `open()`, subscribe `onContextLoss` and
  dispose the addon there (README recipe), catch the constructor/`loadAddon` throw and stay on
  DOM for the session (VS Code's `_suggestedRendererType` pattern), and skip the addon on Safari
  until #5816 closes. Cap contexts: one WebGL terminal per visible pane, none on the hidden
  double-buffer frame.

### 6.3 Migration risks to `Log` (`apps/web/src/main.tsx @ 3184a59`)

1. **Scroll containment must become per-pane.** `containOutputScroll` (`output-scroll.ts:8-9`)
   kills `wheel` and `touchmove` in capture phase before xterm sees them. It still works on 6.0.0
   (`_onMouseWheel` also bails on `defaultPrevented`, `scrollableElement.ts L392`), but once a
   pane keeps history it must be released for wheel, and touch must be re-implemented in the
   console because 6.0.0 has none (§2.4).
2. **`.xterm .xterm-viewport { overflow: hidden !important }` (`styles.css:541-542`) is inert.**
   Harmless with `scrollback: 0`; with history the overlay scrollbar shows unless the three slider
   theme keys are set (to transparent for the current paged design, or to palette colours).
3. **Fit reserves 14 px when `scrollback > 0`** (`FitAddon.ts L68-70 @ 0.11.0`), so the column
   count sent to tmux (`main.tsx:4066`) drops by one on history-enabled panes unless
   `overviewRuler.width` is set; `boundedViewport()` and the size-yield clamp are unaffected.
4. **Theme**: add `scrollbarSliderBackground/Hover/Active` to `terminalTheme` or accept
   foreground-at-20/40/50 % (§2.6). The selection-colour swap at `main.tsx:4123` keeps working.
5. **`reset()` double buffering** keeps working: rows, cols and the custom key handler survive,
   the viewport instance persists and re-syncs on buffer activation. The stale-rAF `reset()`
   guard (`main.tsx:4419`) is unaffected.
6. **Alt+arrow no longer maps to Ctrl+arrow** (#5346); the console sends raw `onData`, so only a
   user habit is affected, not code.
7. **Addon bump is mandatory** and unchecked by pnpm (§3.2): fit 0.10.0 → 0.11.0, web-links
   0.11.0 → 0.12.0, in the same commit as the core.
8. **CSS import** `@xterm/xterm/css/xterm.css` (`main.tsx:6`) still exists; the file grew the
   scrollbar rules (§2.1) and dropped `.xterm-scroll-area`, which the console never styled.
9. **e2e** selectors and the software-keyboard / prompt-focus specs that target
   `.xterm-helper-textarea` need no change (§3.4). Expect visual diffs only where the scrollbar
   becomes visible.
10. **Unverified in the browser**: everything above is read from source; the first migration
    commit should be eye-verified on the phone (touch, keyboard, selection toolbar) and on desktop
    (trackpad over a no-scrollback pane, Ctrl+C copy) as the existing effort notes require.

## Sources

- npm registry JSON (fetched 2026-09-06): `https://registry.npmjs.org/@xterm/xterm`,
  `/@xterm/headless`, `/@xterm/addon-fit`, `/@xterm/addon-web-links`, `/@xterm/addon-webgl`,
  `/@xterm/addon-serialize`, `/@xterm/addon-unicode11`, `/@xterm/addon-clipboard`,
  `/@xterm/addon-search`, `/@xterm/addon-image`, `/@xterm/addon-ligatures`, `/@xterm/addon-attach`,
  `/@xterm/addon-canvas`; tarballs `xterm-6.0.0.tgz`, `xterm-6.1.0-beta.304.tgz`,
  `addon-webgl-0.19.0.tgz`, `addon-fit-0.11.0.tgz`.
- xtermjs/xterm.js via the GitHub API: tags (`/tags?per_page=40`), release `6.0.0`
  (`/releases/tags/6.0.0`), milestones (`/milestones?state=open`, `/milestones?state=all`),
  milestone 81 open issues, issues/PRs #3727, #4198, #4728 (+comments), #4779 (+comments), #5096,
  #5105, #5107, #5143, #5346, #5377, #5391, #5437, #5453, #5462, #5489 (+comments), #5563 (+files),
  #5600 (+comments), #5601, #5755, #5816 (+comments), #5847, #5854, #5883, #5893, #5961, #6106
  (+comments), #6123; search `in:title` for "7.0", "7.0.0 release", "release 6.1", "safari webgl".
- xtermjs/xterm.js source at tag `6.0.0` (tarball `src/`, `typings/`, `css/`) and via jsDelivr
  (`addons/*/package.json`, `addons/addon-webgl/README.md`, `src/browser/Viewport.ts`), and at
  `master` (`package.json`, 2026-09-06). Files cited: `src/browser/Viewport.ts`,
  `src/browser/CoreBrowserTerminal.ts`, `src/browser/Types.ts`, `src/browser/AccessibilityManager.ts`,
  `src/browser/renderer/dom/DomRenderer.ts`, `src/browser/renderer/dom/WidthCache.ts`,
  `src/browser/services/ThemeService.ts`, `src/browser/shared/Constants.ts`,
  `src/browser/public/Terminal.ts`, `src/common/services/CoreMouseService.ts`,
  `src/common/services/OptionsService.ts`, `src/common/input/WriteBuffer.ts`,
  `src/common/InputHandler.ts`, `src/common/Platform.ts`,
  `src/vs/base/browser/ui/scrollbar/scrollableElement.ts`, `src/vs/base/common/scrollable.ts`,
  `src/vs/base/browser/mouseEvent.ts`, `css/xterm.css`, `typings/xterm.d.ts`, `package.json`.
- `@xterm/xterm` 6.1.0-beta.304 source: `src/browser/Viewport.ts`,
  `src/browser/CoreBrowserTerminal.ts`, `src/browser/services/MouseService.ts`,
  `src/browser/scrollable/touch.ts`, `src/common/InputHandler.ts`,
  `src/common/services/OptionsService.ts`, `typings/xterm.d.ts`.
- `@xterm/addon-webgl` 0.19.0: `src/WebglAddon.ts`, `src/WebglRenderer.ts`, `README.md`;
  `@xterm/addon-fit` 0.11.0: `src/FitAddon.ts`.
- `@xterm/xterm` 5.5.0 (main checkout `node_modules/.pnpm/@xterm+xterm@5.5.0`): `typings/xterm.d.ts`,
  `css/xterm.css`, `src/browser/Terminal.ts`, `src/browser/public/Terminal.ts`,
  `src/common/input/WriteBuffer.ts`, `package.json`.
- microsoft/vscode `main` (2026-09-06): `package.json`,
  `src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts`,
  `src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts`,
  `src/vs/workbench/contrib/terminal/browser/terminal.ts`; issue microsoft/vscode#224750.
- Console at `3184a59`: `apps/web/src/main.tsx`, `apps/web/src/output-scroll.ts`,
  `apps/web/src/output-links.ts`, `apps/web/src/styles.css`, `apps/web/e2e/*.spec.ts`,
  `apps/web/package.json`, `pnpm-lock.yaml`; `docs/research/tmux-pane-io-options.md` §4.
