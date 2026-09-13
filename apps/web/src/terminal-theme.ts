import type { ITheme } from '@xterm/xterm';

// The monospace stack every terminal pane renders in, shared with the Log viewer
// so a streamed Terminal and the agent pane look identical.
export const terminalFontFamily = '"JetBrainsMono Nerd Font", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

// Derive the xterm theme from the same CSS palette tokens the whole UI reads, so a
// Terminal shares one source of truth with every other surface. The bright ANSI
// slots read the terminal-only `--term-bright-*` tokens; white/brightWhite follow
// canonical Catppuccin (subtext-0/subtext-1). `getComputedStyle` is read afresh on
// each call, so recomputing after the flavour flips `[data-theme]` yields the new
// palette — a Terminal reflavours with the UI rather than freezing on the flavour it
// was born in. (Transcribed from the Log viewer's inline `computeTerminalTheme`.)
export const computeTerminalTheme = (): ITheme => {
  const paletteStyle = getComputedStyle(document.documentElement);
  const paletteColor = (token: string) => paletteStyle.getPropertyValue(token).trim();
  return {
    background: paletteColor('--base'),
    foreground: paletteColor('--text'),
    cursor: paletteColor('--rosewater'),
    selectionBackground: paletteColor('--mauve'),
    selectionForeground: paletteColor('--crust'),
    black: paletteColor('--surface-1'),
    red: paletteColor('--red'),
    green: paletteColor('--green'),
    yellow: paletteColor('--yellow'),
    blue: paletteColor('--blue'),
    magenta: paletteColor('--pink'),
    cyan: paletteColor('--teal'),
    white: paletteColor('--subtext-0'),
    brightBlack: paletteColor('--surface-2'),
    brightRed: paletteColor('--term-bright-red'),
    brightGreen: paletteColor('--term-bright-green'),
    brightYellow: paletteColor('--term-bright-yellow'),
    brightBlue: paletteColor('--term-bright-blue'),
    brightMagenta: paletteColor('--term-bright-magenta'),
    brightCyan: paletteColor('--term-bright-cyan'),
    brightWhite: paletteColor('--subtext-1')
  };
};
