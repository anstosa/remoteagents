import type { FileEntry } from './contracts.js';

export type SelectionGesture = { toggle: boolean; range: boolean; mobile: boolean };
export type FileSelection = { tokens: Set<string>; anchor?: string };

// apply desktop modifier or mobile toggle selection against rendered order
export function selectFileEntry(current: FileSelection, entry: FileEntry, ordered: readonly FileEntry[], gesture: SelectionGesture): FileSelection {
  const token = entry.objectToken;
  // mobile rows always toggle without replacing prior choices
  if (gesture.mobile) {
    const tokens = new Set(current.tokens);
    // toggle the tapped entry
    if (tokens.has(token)) tokens.delete(token); else tokens.add(token);
    return { tokens, anchor: token };
  }
  // ranges start from the last surviving anchor or the current row
  if (gesture.range) {
    const anchor = current.anchor !== undefined && ordered.some(candidate => candidate.objectToken === current.anchor) ? current.anchor : token;
    const start = ordered.findIndex(candidate => candidate.objectToken === anchor);
    const end = ordered.findIndex(candidate => candidate.objectToken === token);
    const range = ordered.slice(Math.min(start, end), Math.max(start, end) + 1).map(candidate => candidate.objectToken);
    const tokens = gesture.toggle ? new Set(current.tokens) : new Set<string>();
    // add the rendered range without opening an entry
    for (const item of range) tokens.add(item);
    return { tokens, anchor };
  }
  // modifier clicks toggle one entry
  if (gesture.toggle) {
    const tokens = new Set(current.tokens);
    // toggle the clicked row
    if (tokens.has(token)) tokens.delete(token); else tokens.add(token);
    return { tokens, anchor: token };
  }
  return { tokens: new Set([token]), anchor: token };
}

// retain only selections whose exact object tokens survived a refresh
export function retainCurrentSelection(current: FileSelection, entries: readonly FileEntry[]): FileSelection {
  const available = new Set(entries.map(entry => entry.objectToken));
  const tokens = new Set([...current.tokens].filter(token => available.has(token)));
  return { tokens, ...(current.anchor !== undefined && available.has(current.anchor) ? { anchor: current.anchor } : {}) };
}
