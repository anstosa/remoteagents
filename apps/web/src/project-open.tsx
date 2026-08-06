import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { stackActionLabel, stackOperationLabel, type StackAction } from './stack-operations.js';
import { useViewportFlyout } from './viewport-flyout.js';

type ProjectStack = { actions?: StackAction[]; operation?: StackAction; transition?: 'starting'|'migrating'; tunnel?: boolean };

export function ProjectOpen({ url, stack, browserOpen = false, onBrowserToggle, onStackAction }: { url?: string; stack?: ProjectStack; browserOpen?: boolean; onBrowserToggle?: () => void; onStackAction?: (action: StackAction) => Promise<unknown> | unknown }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [running, setRunning] = useState<StackAction>();
  const groupRef = useRef<HTMLSpanElement | null>(null);
  const { anchorRef, flyoutRef, style } = useViewportFlyout(menuOpen);
  const actions = stack?.actions ?? [];
  const hasStackActions = actions.length > 0 && onStackAction !== undefined;
  const hasBrowserControl = onBrowserToggle !== undefined;
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!groupRef.current?.contains(target) && !flyoutRef.current?.contains(target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);
  if (url === undefined) return null;
  const operation = running ?? stack?.operation;
  const status = stack?.transition ?? (stack?.tunnel === true ? 'healthy' : stack?.tunnel === false ? 'down' : 'starting');
  const busy = operation !== undefined;
  const disabled = busy || status === 'down';
  const label = operation === undefined ? 'Open' : `${stackOperationLabel(operation)}…`;
  const title = operation === undefined ? `Project is ${status}` : `${stackOperationLabel(operation)} stack`;
  const run = async (action: StackAction) => {
    if (running !== undefined || stack?.operation !== undefined || onStackAction === undefined) return;
    setRunning(action);
    try { await onStackAction(action); }
    finally { setRunning(undefined); setMenuOpen(false); }
  };
  return <><span className={`project-open-group${hasBrowserControl ? ' has-browser-control' : ''}${hasStackActions ? ' has-stack-actions' : ''}`} ref={element => { groupRef.current = element; anchorRef.current = element; }} role="group" aria-label="Project controls"><a className={`project-open status-${status}${disabled ? ' disabled' : ''}${busy ? ' busy' : ''}`} href={url} target="_blank" rel="noreferrer" aria-disabled={disabled} aria-busy={busy || undefined} title={title} onClick={event => { if (disabled) event.preventDefault(); }}>{busy ? <span className="spinner" aria-hidden="true" /> : <i aria-hidden="true" />}{label}</a>{hasBrowserControl && <button className="project-browser-toggle icon-button" type="button" disabled={busy} aria-label="Open project in split view" aria-pressed={browserOpen} title="Split view" onClick={onBrowserToggle}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 4v16" /></svg></button>}{hasStackActions && <button className="project-stack-toggle icon-button" type="button" disabled={busy} aria-label="Stack controls" aria-expanded={menuOpen} title="Stack controls" onClick={() => setMenuOpen(open => !open)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>}</span>{menuOpen && createPortal(<div className="stack-menu more-menu flyout-menu" ref={flyoutRef} style={style}>{actions.map(action => <button key={action} disabled={busy} onClick={() => void run(action)}>{operation === action ? <><span className="spinner" />{stackOperationLabel(action)}…</> : stackActionLabel(action)}</button>)}</div>, document.body)}</>;
}
