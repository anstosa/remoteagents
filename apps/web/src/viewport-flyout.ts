import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';

type ViewportFlyoutPlacement = 'vertical'|'left';
type ViewportFlyoutOptions = { placement?: ViewportFlyoutPlacement; boundarySelector?: string; boundaryRootSelector?: string; contentSized?: boolean };
type ViewportFlyoutStyle = CSSProperties & { '--flyout-available-height'?: string };

// position one portal flyout within the viewport
export function useViewportFlyout<T extends HTMLElement = HTMLSpanElement>(open: boolean, options: ViewportFlyoutOptions = {}) {
  const { placement = 'vertical', boundarySelector, boundaryRootSelector, contentSized = false } = options;
  const anchorRef = useRef<T | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<ViewportFlyoutStyle>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open) { setStyle({ visibility: 'hidden' }); return; }
    const position = () => {
      const anchor = anchorRef.current;
      const flyout = flyoutRef.current;
      if (!anchor || !flyout) return;
      const { top, right, bottom, left: anchorLeft } = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const width = Math.min(flyout.offsetWidth, window.innerWidth - margin * 2);
      // keep side flyouts top-aligned until their lower boundary
      if (placement === 'left') {
        const boundaryRoot = boundaryRootSelector === undefined ? anchor.ownerDocument : anchor.closest(boundaryRootSelector);
        const boundary = boundarySelector === undefined ? undefined : boundaryRoot?.querySelector(boundarySelector);
        const boundaryBounds = boundary?.getBoundingClientRect();
        const upperEdge = Math.max(margin, boundaryBounds?.top ?? margin);
        const lowerEdge = Math.min(window.innerHeight - margin, boundaryBounds?.bottom ?? window.innerHeight - margin);
        const availableHeight = Math.max(1, lowerEdge - upperEdge);
        const leftEdge = Math.max(margin, boundaryBounds?.left ?? margin);
        const availableWidth = Math.max(1, anchorLeft - gap - leftEdge);
        const sideWidth = Math.min(width, availableWidth);
        const height = Math.min(flyout.getBoundingClientRect().height, availableHeight);
        const flyoutTop = Math.max(upperEdge, Math.min(top, lowerEdge - height));
        const left = Math.max(leftEdge, anchorLeft - sideWidth - gap);
        setStyle({ position: 'fixed', top: flyoutTop, left, right: 'auto', bottom: 'auto', width: contentSized ? 'max-content' : sideWidth, maxWidth: `${contentSized ? availableWidth : window.innerWidth - margin * 2}px`, '--flyout-available-height': `${availableHeight}px`, visibility: 'visible' });
        return;
      }
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
  }, [boundaryRootSelector, boundarySelector, contentSized, open, placement]);
  return { anchorRef, flyoutRef, style };
}
