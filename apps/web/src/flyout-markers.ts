import { useSyncExternalStore } from 'react';

// per-browser flyout marker opt-in
const flyoutMarkersKey = 'rac.flyout-markers';

// keep markers hidden unless explicitly enabled
const read = (): boolean => {
  try {
    return localStorage.getItem(flyoutMarkersKey) === 'enabled';
  } catch {
    return false;
  }
};

// include portaled controls in the preference
const apply = (enabled: boolean): void => {
  // skip non-browser rendering
  if (typeof document === 'undefined') return;
  // opt in through the document root
  if (enabled) document.documentElement.dataset.flyoutMarkers = 'enabled';
  else delete document.documentElement.dataset.flyoutMarkers;
};

let current: boolean | undefined;
const listeners = new Set<() => void>();
// notify mounted settings consumers
const notify = () => listeners.forEach(listener => listener());

// cache the persisted preference
const readFlyoutMarkers = (): boolean => {
  // initialize from storage once
  if (current === undefined) current = read();
  return current;
};

// persist one marker preference
export const setFlyoutMarkers = (enabled: boolean): boolean => {
  // skip duplicate writes
  if (enabled === readFlyoutMarkers()) return enabled;
  current = enabled;
  try {
    // keep the hidden default absent from storage
    if (enabled) localStorage.setItem(flyoutMarkersKey, 'enabled');
    else localStorage.removeItem(flyoutMarkersKey);
  } catch { /* private-mode storage is non-fatal */ }
  apply(enabled);
  notify();
  return enabled;
};

// apply stored markers and consume an explicit opt-in link
export const applyFlyoutMarkers = (): void => {
  const url = new URL(window.location.href);
  // allow a settings link to enable this browser only
  if (url.searchParams.get('flyout-markers') === 'enabled') {
    setFlyoutMarkers(true);
    url.searchParams.delete('flyout-markers');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  apply(readFlyoutMarkers());
};

// subscribe one mounted settings consumer
const subscribeFlyoutMarkers = (listener: () => void): (() => void) => {
  listeners.add(listener);
  // release the subscription
  return () => { listeners.delete(listener); };
};

// follow preferences from other browser tabs
if (typeof window !== 'undefined') {
  // reread only relevant storage events
  window.addEventListener('storage', event => {
    // ignore unrelated keys
    if (event.key !== null && event.key !== flyoutMarkersKey) return;
    const next = read();
    // ignore unchanged values
    if (next === current) return;
    current = next;
    apply(next);
    notify();
  });
}

// read the live marker preference
export const useFlyoutMarkers = (): boolean =>
  useSyncExternalStore(subscribeFlyoutMarkers, readFlyoutMarkers, readFlyoutMarkers);
