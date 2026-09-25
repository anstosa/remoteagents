import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// One panel of a Workspace's phone carousel: its split key, its kind (which tints its dot) and the
// label of the dot that shows it.
export type CarouselPanel = { key: string; kind: string; label: string };

// What the carousel tells the rest of the Workspace: its panels in order, the one in view, and how
// to bring one into view.
export type PanelCarousel = { panels: readonly CarouselPanel[]; visibleKey: string | undefined; show: (key: string) => void };

// Track which of a split's panels (`keys`, in column order) is in view. On a phone the split is a
// horizontal scroll-snap carousel, one panel per screen (the CSS lays it out), so the panel in view
// follows the scroll position, and `show` jumps to a panel. A newly opened panel other than the
// agent's comes into view; when the one in view closes, the first panel does. Off the phone no
// scrolling happens, but the panel in view is still tracked, so it is there when the width shrinks.
// Every programmatic scroll is instant: a smooth one is cancelled when a panel's layout changes
// mid-flight (the Code panel loading, say), and the browser re-snaps to the old panel without a
// scroll event, leaving the dots pointing at a panel that is not in view. Only a change of width
// realigns: the toolbar swapping for a Terminal's taller helper keys mid-swipe changes the height,
// and a realign then would yank the carousel from under the finger.
export function usePanelCarousel(containerRef: RefObject<HTMLElement | null>, keys: readonly string[], phone: boolean) {
  const [visibleKey, setVisibleKey] = useState<string | undefined>(keys[0]);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const visibleRef = useRef(visibleKey);
  visibleRef.current = visibleKey;
  const previousKeys = useRef(keys);
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  const scrollTo = useCallback((key: string) => {
    const container = containerRef.current;
    const index = keysRef.current.indexOf(key);
    if (!phoneRef.current || container === null || index < 0) return;
    container.scrollTo({ left: index * container.clientWidth, behavior: 'instant' });
  }, [containerRef]);
  const choose = useCallback((key: string | undefined) => {
    visibleRef.current = key;
    setVisibleKey(key);
  }, []);
  // follow a panel opening or closing, and line the carousel up when the phone layout starts
  const signature = keys.join('|');
  useLayoutEffect(() => {
    const previous = previousKeys.current;
    const current = keysRef.current;
    previousKeys.current = current;
    const opened = current.find(key => key !== 'agent' && !previous.includes(key));
    const shown = visibleRef.current;
    const next = opened ?? (shown !== undefined && current.includes(shown) ? shown : current[0]);
    choose(next);
    if (next !== undefined) scrollTo(next);
  }, [signature, phone, choose, scrollTo]);
  // a swipe moves the panel in view; a resize (rotation, the software keyboard) keeps it in view
  useEffect(() => {
    const container = containerRef.current;
    if (!phone || container === null) return;
    const follow = () => {
      const width = container.clientWidth;
      const key = width > 0 ? keysRef.current[Math.round(container.scrollLeft / width)] : undefined;
      if (key !== undefined) choose(key);
    };
    let width = container.clientWidth;
    const realign = () => {
      if (container.clientWidth === width) return;
      width = container.clientWidth;
      if (visibleRef.current !== undefined) scrollTo(visibleRef.current);
    };
    container.addEventListener('scroll', follow, { passive: true });
    const observer = new ResizeObserver(realign);
    observer.observe(container);
    return () => {
      container.removeEventListener('scroll', follow);
      observer.disconnect();
    };
  }, [phone, containerRef, choose, scrollTo]);
  // Bring a panel into view. Focus left in the panel scrolled away (the Agent's pane taking keys)
  // goes with it, so the keyboard and the helper keys never split between two panels.
  const show = useCallback((key: string) => {
    if (!keysRef.current.includes(key)) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && containerRef.current?.contains(focused) === true) focused.blur();
    choose(key);
    scrollTo(key);
  }, [containerRef, choose, scrollTo]);
  return { visibleKey: visibleKey !== undefined && keys.includes(visibleKey) ? visibleKey : keys[0], show };
}

// The toolbar's position dots: one per open panel, tinted by kind, the one in view marked current.
// Tapping a dot brings its panel into view. The toolbar shows them only for two panels or more.
export function PanelDots({ carousel }: { carousel: PanelCarousel }) {
  return <span className="panel-dots" role="group" aria-label="Panels">{carousel.panels.map(panel => <button key={panel.key} type="button" className={`panel-dot ${panel.kind}-dot`} aria-label={panel.label} title={panel.label} aria-current={panel.key === carousel.visibleKey ? 'true' : undefined} onClick={() => carousel.show(panel.key)} />)}</span>;
}
