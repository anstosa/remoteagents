import { useSyncExternalStore } from 'react';

// per-browser launcher density shared across tabs
const dynamicWorktreesKey = 'rac.dynamic-worktrees';

// read the opt-out while keeping dynamic worktrees enabled by default
const read = (): boolean => {
  try {
    return localStorage.getItem(dynamicWorktreesKey) !== 'disabled';
  } catch {
    return true;
  }
};

let current: boolean | undefined;
const listeners = new Set<() => void>();
// notify every mounted launcher and settings page
const notify = () => listeners.forEach(listener => listener());

// expose the cached browser preference
const readDynamicWorktrees = (): boolean => {
  // initialize from storage once
  if (current === undefined) current = read();
  return current;
};

// persist one launcher preference
export const setDynamicWorktrees = (enabled: boolean): boolean => {
  // skip duplicate writes
  if (enabled === readDynamicWorktrees()) return enabled;
  current = enabled;
  try {
    // keep the default absent from storage
    if (enabled) localStorage.removeItem(dynamicWorktreesKey);
    else localStorage.setItem(dynamicWorktreesKey, 'disabled');
  } catch { /* private-mode storage is non-fatal */ }
  notify();
  return enabled;
};

// subscribe one mounted consumer
const subscribeDynamicWorktrees = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// follow the same preference changing in another browser tab
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    // ignore unrelated storage changes
    if (event.key !== null && event.key !== dynamicWorktreesKey) return;
    const next = read();
    // ignore an unchanged value
    if (next === current) return;
    current = next;
    notify();
  });
}

// read the live launcher preference
export const useDynamicWorktrees = (): boolean =>
  useSyncExternalStore(subscribeDynamicWorktrees, readDynamicWorktrees, readDynamicWorktrees);
