import type { MouseEvent, PointerEvent } from 'react';

// suppress native middle-paste and autoscroll
export function preserveMiddleClickPress(event: MouseEvent | PointerEvent) {
  // leave other buttons unchanged
  if (event.button !== 1) return;
  event.preventDefault();
  event.stopPropagation();
}

// close only the explicitly targeted split or tab
export function closeOnMiddleClick(event: MouseEvent, close: () => void) {
  // ignore primary and context-menu clicks
  if (event.button !== 1) return;
  event.preventDefault();
  event.stopPropagation();
  close();
}
