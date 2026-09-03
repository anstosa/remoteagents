import { useSyncExternalStore } from 'react';

// Per-browser colour flavour, shared across the tabs of one browser. It recolours
// the whole UI at once: every surface references the Catppuccin palette tokens,
// and Latte overrides them under `[data-theme="latte"]`, so flipping the document
// attribute reflavours everything with no reload.
export const colorThemeKey = 'rac.color-theme';

// Mocha is the default dark flavour; Latte is the light one. The stored value is
// the flavour name `'latte'` and Mocha is the key's ABSENCE — mirroring the
// terminal font-size store's "default absent from storage" semantics — so the key
// means "this browser chose the non-default flavour" and storing a name (rather
// than a boolean) keeps a future flavour cheap.
export type ColorTheme = 'mocha' | 'latte';

// A stored `'latte'` survives a reload; anything else (absent, stale, hand-edited)
// heals to the default Mocha.
const read = (): ColorTheme => {
  try {
    return localStorage.getItem(colorThemeKey) === 'latte' ? 'latte' : 'mocha';
  } catch { return 'mocha'; }
};

// Reflect the flavour onto the document so the CSS palette swaps: Latte sets the
// `data-theme` attribute, Mocha removes it (absence is Mocha). Then point
// `<meta name="theme-color">` at the flavour's resolved `--base` so the mobile
// browser chrome matches. Reading the variable after the attribute change picks
// up the freshly-scoped value; an unresolved variable leaves the static default.
const apply = (theme: ColorTheme): void => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'latte') root.dataset.theme = 'latte';
  else delete root.dataset.theme;
  const base = getComputedStyle(root).getPropertyValue('--base').trim();
  if (base !== '') document.querySelector('meta[name="theme-color"]')?.setAttribute('content', base);
};

let current: ColorTheme | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export const readColorTheme = (): ColorTheme => {
  if (current === undefined) current = read();
  return current;
};

// Apply the stored flavour to the document. Called once at startup — after the
// stylesheet is registered, so `--base` resolves — and idempotent thereafter.
export const applyColorTheme = (): void => apply(readColorTheme());

export const setColorTheme = (theme: ColorTheme): ColorTheme => {
  if (theme === readColorTheme()) return theme;
  current = theme;
  // Keep the default absent from storage, matching the font-size store: the key's
  // presence means the non-default flavour was chosen, and switching back to Dark
  // clears it so stored state stays tidy.
  try {
    if (theme === 'latte') localStorage.setItem(colorThemeKey, 'latte');
    else localStorage.removeItem(colorThemeKey);
  } catch { /* private-mode storage is non-fatal */ }
  apply(theme);
  notify();
  return theme;
};

export const subscribeColorTheme = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// Follow the same key changing in another tab of this browser.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== colorThemeKey) return;
    const next = read();
    if (next === current) return;
    current = next;
    apply(next);
    notify();
  });
}

export const useColorTheme = (): ColorTheme =>
  useSyncExternalStore(subscribeColorTheme, readColorTheme, readColorTheme);
