import { type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

// render one click-through-blocking flyout portal
export function FlyoutPortal({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  // keep early press events away from document handlers
  const blockPress = (event: SyntheticEvent) => { event.stopPropagation(); };
  // consume the completed outside interaction
  const dismiss = (event: SyntheticEvent) => { event.preventDefault(); event.stopPropagation(); onDismiss(); };
  return createPortal(<><div className="flyout-backdrop" aria-hidden="true" onPointerDown={blockPress} onMouseDown={blockPress} onClick={dismiss} onContextMenu={dismiss} />{children}</>, document.body);
}
