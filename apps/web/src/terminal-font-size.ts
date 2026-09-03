import { useSyncExternalStore } from 'react';

// Per-browser terminal font size, in whole pixels, shared across the tabs of one
// browser. It drives only the xterm agent pane; the note editor, note preview,
// and response file viewer keep the shared `--output-font-size` default.
export const terminalFontSizeKey = 'rac.terminal-font-size';
export const minTerminalFontSize = 8;
export const maxTerminalFontSize = 24;

const clamp = (px: number) => Math.min(maxTerminalFontSize, Math.max(minTerminalFontSize, Math.round(px)));

// The size to use when nothing is stored: the CSS `--output-font-size`, exactly
// as the Log read it before this control existed, falling back to 11 when the
// variable is unavailable. Clamped so a stray default still lands in range.
export const defaultTerminalFontSize = (): number => {
  try {
    const parsed = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--output-font-size'));
    return Number.isFinite(parsed) ? clamp(parsed) : 11;
  } catch { return 11; }
};

// A stored value survives a reload; an absent or unparseable one falls back to
// the default. Out-of-range values are clamped so old or hand-edited keys heal.
const read = (): number => {
  try {
    const raw = localStorage.getItem(terminalFontSizeKey);
    if (raw === null) return defaultTerminalFontSize();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clamp(parsed) : defaultTerminalFontSize();
  } catch { return defaultTerminalFontSize(); }
};

let current: number | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export const readTerminalFontSize = (): number => {
  if (current === undefined) current = read();
  return current;
};

export const setTerminalFontSize = (px: number): number => {
  const value = clamp(px);
  if (value === readTerminalFontSize()) return value;
  current = value;
  // Keep the default absent from storage, so the key means "this browser chose a
  // non-default size" and Reset has nothing left to clear at the default.
  try {
    if (value === defaultTerminalFontSize()) localStorage.removeItem(terminalFontSizeKey);
    else localStorage.setItem(terminalFontSizeKey, String(value));
  } catch { /* private-mode storage is non-fatal */ }
  notify();
  return value;
};

export const stepTerminalFontSize = (delta: number): number => setTerminalFontSize(readTerminalFontSize() + delta);

// Return to the default and forget the stored key, as Ctrl+0 does.
export const resetTerminalFontSize = (): number => {
  const value = defaultTerminalFontSize();
  const changed = value !== readTerminalFontSize();
  current = value;
  try { localStorage.removeItem(terminalFontSizeKey); }
  catch { /* private-mode storage is non-fatal */ }
  if (changed) notify();
  return value;
};

export const subscribeTerminalFontSize = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// Follow the same key changing in another tab of this browser.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== terminalFontSizeKey) return;
    const next = read();
    if (next === current) return;
    current = next;
    notify();
  });
}

export const useTerminalFontSize = (): number =>
  useSyncExternalStore(subscribeTerminalFontSize, readTerminalFontSize, readTerminalFontSize);
