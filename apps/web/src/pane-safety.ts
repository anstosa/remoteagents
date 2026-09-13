import type { Terminal } from '@xterm/xterm';

// A pane stream carries the program's raw pty bytes, which tmux's control client
// forwards *before* tmux's own parser clamps, gates or answers them. So none of
// tmux's protections reach the browser: whatever the program wrote is what xterm
// parses. This installs the browser-side allow/deny/intercept table from
// `docs/research/raw-pane-stream-safety.md` §7 on the terminal's parser. Handlers
// that return `true` stop the chain before xterm's built-in handler and survive
// `RIS`, `DECSTR` and `terminal.reset()`; the most recently registered runs first.
//
// Two shapes of hook:
//   - Suppress a reply-producing query so the pane can never make xterm type bytes
//     back into its own stdin (tmux already answers all of these for the pane).
//   - Clamp a parameter-scaled loop, denying only an absurd count that would freeze
//     the main thread; a legitimate program never scrolls/inserts/repeats past the
//     screen, so the deny is invisible.
//
// Sets that repaint (OSC 4 palette) are allowed; sets that make the panel unreadable
// or fight the flavour flip (OSC 10/11/12 fg/bg/cursor) are denied. OSC 52 is pinned
// off so a later clipboard addon cannot win the chain and read the clipboard.

// A whole `?` slot in an OSC colour payload marks a query (`4;1;?`, `10;?`), as
// opposed to a set (`4;1;rgb:..`). Denies queries only; sets fall through.
const isColorQuery = (data: string): boolean => /(^|;)\?(;|$)/u.test(data);

// The first CSI parameter as a plain number; a missing or sub-parameter slot reads
// as 0, which is below any geometry threshold so the built-in handler runs.
const firstParam = (params: (number | number[])[]): number => {
  const value = params[0];
  return typeof value === 'number' ? value : 0;
};

export const installPaneStreamSafety = (terminal: Pick<Terminal, 'parser' | 'rows' | 'cols'>): void => {
  const parser = terminal.parser;
  const deny = () => true;

  // Suppress the nine sequences that make xterm reply on `onData` (indistinguishable
  // from typed input). tmux answers each for the pane on its own pty, so nothing is
  // lost.
  parser.registerCsiHandler({ final: 'c' }, deny); // DA1
  parser.registerCsiHandler({ prefix: '>', final: 'c' }, deny); // DA2
  parser.registerCsiHandler({ final: 'n' }, deny); // DSR, CPR
  parser.registerCsiHandler({ prefix: '?', final: 'n' }, deny); // DECXCPR
  parser.registerCsiHandler({ intermediates: '$', final: 'p' }, deny); // DECRQM (ANSI)
  parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, deny); // DECRQM (private)
  parser.registerDcsHandler({ intermediates: '$', final: 'q' }, deny); // DECRQSS

  // Clamp the four unbounded CSI loops: deny only when the count exceeds the screen,
  // which no legitimate program needs. SU/SD/IL/DL scale with rows; CHT/CBT/REP with
  // columns.
  parser.registerCsiHandler({ final: 'S' }, params => firstParam(params) > terminal.rows); // SU
  parser.registerCsiHandler({ final: 'T' }, params => firstParam(params) > terminal.rows); // SD
  parser.registerCsiHandler({ final: 'L' }, params => firstParam(params) > terminal.rows); // IL
  parser.registerCsiHandler({ final: 'M' }, params => firstParam(params) > terminal.rows); // DL
  parser.registerCsiHandler({ final: 'I' }, params => firstParam(params) > terminal.cols); // CHT
  parser.registerCsiHandler({ final: 'Z' }, params => firstParam(params) > terminal.cols); // CBT
  parser.registerCsiHandler({ final: 'b' }, params => firstParam(params) > terminal.cols); // REP

  // OSC colour policy. 4: allow palette sets, deny only queries. 10/11/12: deny both
  // (a set repaints fg/bg/cursor until reset or the next flavour flip; a query
  // replies). 52: pin off so `@xterm/addon-clipboard` cannot register over it.
  parser.registerOscHandler(4, isColorQuery);
  parser.registerOscHandler(10, deny);
  parser.registerOscHandler(11, deny);
  parser.registerOscHandler(12, deny);
  parser.registerOscHandler(52, deny);
};
