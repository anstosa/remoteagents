import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';

type ViewportFlyoutPlacement = 'vertical'|'above'|'left';
// `align` picks which anchor edge a vertical flyout lines up with: its right edge (`end`, the
// default, for controls at the right of a row) or its left edge (`start`, for controls at the left).
// `matchContainerWidth` names an ancestor of the anchor (such as its panel) whose width a vertical
// flyout spans, so it stays within that ancestor rather than the whole viewport.
type ViewportFlyoutOptions = { placement?: ViewportFlyoutPlacement; align?: 'start'|'end'; boundarySelector?: string; boundaryRootSelector?: string; contentSized?: boolean; matchAnchorWidth?: boolean; matchContainerWidth?: string };
type ViewportFlyoutStyle = CSSProperties & { '--flyout-available-height'?: string };

// position one portal flyout within the viewport
export function useViewportFlyout<T extends HTMLElement = HTMLSpanElement>(open: boolean, options: ViewportFlyoutOptions = {}) {
  const { placement = 'vertical', align = 'end', boundarySelector, boundaryRootSelector, contentSized = false, matchAnchorWidth = false, matchContainerWidth } = options;
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
      const container = matchContainerWidth === undefined ? undefined : anchor.closest(matchContainerWidth)?.getBoundingClientRect();
      const containerLeft = Math.max(margin, (container?.left ?? 0) + margin);
      const containerWidth = container && Math.min(window.innerWidth - margin, container.right - margin) - containerLeft;
      const width = Math.max(1, Math.min(containerWidth ?? (matchAnchorWidth ? right - anchorLeft : flyout.offsetWidth), window.innerWidth - margin * 2));
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
      const side = placement === 'above' || below < above ? 'above' : 'below';
      const maxHeight = Math.max(1, side === 'below' ? below : above);
      // a content-sized flyout keeps its own CSS width and height cap, told only the room it has
      const height = Math.min(contentSized ? flyout.offsetHeight : flyout.scrollHeight, maxHeight);
      const flyoutTop = side === 'below' ? bottom + gap : top - height - gap;
      const left = containerWidth === undefined ? Math.max(margin, Math.min(align === 'start' ? anchorLeft : right - width, window.innerWidth - width - margin)) : containerLeft;
      setStyle({ position: 'fixed', top: flyoutTop, left, right: 'auto', bottom: 'auto', width: contentSized ? 'max-content' : width, maxWidth: `${window.innerWidth - margin * 2}px`, ...(contentSized ? { '--flyout-available-height': `${maxHeight}px` } : { maxHeight: `${maxHeight}px` }), visibility: 'visible' });
    };
    position();
    const observer = new ResizeObserver(position);
    if (anchorRef.current) observer.observe(anchorRef.current);
    if (flyoutRef.current) observer.observe(flyoutRef.current);
    // a container resized without the window (a dragged panel divider) moves the flyout's edges
    const container = matchContainerWidth === undefined ? undefined : anchorRef.current?.closest(matchContainerWidth);
    if (container) observer.observe(container);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [align, boundaryRootSelector, boundarySelector, contentSized, matchAnchorWidth, matchContainerWidth, open, placement]);
  return { anchorRef, flyoutRef, style };
}
