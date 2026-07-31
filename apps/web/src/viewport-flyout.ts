import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';

export function useViewportFlyout(open: boolean) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open) { setStyle({ visibility: 'hidden' }); return; }
    const position = () => {
      const anchor = anchorRef.current;
      const flyout = flyoutRef.current;
      if (!anchor || !flyout) return;
      const { top, right, bottom } = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const width = Math.min(flyout.offsetWidth, window.innerWidth - margin * 2);
      const below = window.innerHeight - bottom - gap;
      const above = top - gap;
      const side = below >= above ? 'below' : 'above';
      const maxHeight = Math.max(1, side === 'below' ? below : above);
      const height = Math.min(flyout.scrollHeight, maxHeight);
      const flyoutTop = side === 'below' ? bottom + gap : top - height - gap;
      const left = Math.max(margin, Math.min(right - width, window.innerWidth - width - margin));
      setStyle({ position: 'fixed', top: flyoutTop, left, right: 'auto', bottom: 'auto', width, maxWidth: `${window.innerWidth - margin * 2}px`, maxHeight: `${maxHeight}px`, visibility: 'visible' });
    };
    position();
    const observer = new ResizeObserver(position);
    if (anchorRef.current) observer.observe(anchorRef.current);
    if (flyoutRef.current) observer.observe(flyoutRef.current);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open]);
  return { anchorRef, flyoutRef, style };
}
