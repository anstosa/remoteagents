import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FlyoutPortal } from './flyout-portal.js';
import { stackActionLabel, stackOperationLabel, type StackAction, type StackOperationLog } from './stack-operations.js';
import { useViewportFlyout } from './viewport-flyout.js';

type ProjectStack = { actions?: StackAction[]; running?: boolean; operation?: StackAction; transition?: 'starting'|'migrating'; tunnel?: boolean };
type ProjectStackStatus = 'working'|'healthy'|'down'|'running'|'stopped'|'unknown';

// derive the stack status badge
function resolveStackStatus(stack: ProjectStack | undefined, inProgress: boolean): ProjectStackStatus {
  // prioritize active operations
  if (inProgress) return 'working';
  // reflect a healthy tunnel
  if (stack?.tunnel === true) return 'healthy';
  // reflect a failed tunnel
  if (stack?.tunnel === false) return 'down';
  // reflect a running stack
  if (stack?.running === true) return 'running';
  // reflect a stopped stack
  if (stack?.running === false) return 'stopped';
  return 'unknown';
}

// render project controls
export function ProjectOpen({ url, projectProxied, stack, browserOpen = false, onBrowserToggle, onStackAction, onStackLog }: { url?: string; projectProxied?: boolean; stack?: ProjectStack; browserOpen?: boolean; onBrowserToggle?: () => void; onStackAction?: (action: StackAction) => Promise<unknown> | unknown; onStackLog?: () => Promise<StackOperationLog | undefined> }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [running, setRunning] = useState<StackAction>();
  const [logsOpen, setLogsOpen] = useState(false);
  const [log, setLog] = useState<StackOperationLog>();
  const [logError, setLogError] = useState('');
  const logOutputRef = useRef<HTMLPreElement | null>(null);
  const stackLogRef = useRef(onStackLog);
  stackLogRef.current = onStackLog;
  const { anchorRef, flyoutRef, style } = useViewportFlyout(menuOpen);
  const actions = stack?.actions ?? [];
  const hasStackActions = actions.length > 0 && onStackAction !== undefined;
  const hasStackLogs = actions.length > 0 && onStackLog !== undefined;
  // identify explicit external targets
  const directProject = projectProxied === false;
  // keep direct targets independent of local stack state
  const hasBrowserControl = onBrowserToggle !== undefined && (directProject || stack?.running === true);
  useEffect(() => {
    // poll only while the log viewer is open
    if (!logsOpen || stackLogRef.current === undefined) return;
    let active = true;
    let loading = false;
    // refresh the retained command output
    const refresh = async () => {
      // avoid overlapping slow requests
      if (loading) return;
      loading = true;
      try {
        const next = await stackLogRef.current?.();
        // ignore responses after closing
        if (!active) return;
        setLog(next);
        setLogError('');
      } catch {
        // retain prior output through transient failures
        if (active) setLogError('Unable to refresh stack output.');
      } finally { loading = false; }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 750);
    return () => { active = false; window.clearInterval(interval); };
  }, [logsOpen]);
  useEffect(() => {
    // follow new output while the viewer is open
    if (!logsOpen || logOutputRef.current === null) return;
    logOutputRef.current.scrollTop = logOutputRef.current.scrollHeight;
  }, [log?.output, logsOpen]);
  useEffect(() => {
    // close the viewer with Escape
    if (!logsOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setLogsOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [logsOpen]);
  // open the latest retained output
  const openLogs = () => { setLogError(''); setLogsOpen(true); };
  // launch one stack action
  const run = async (action: StackAction) => {
    // reject overlapping operations and transitions
    if (running !== undefined || stack?.operation !== undefined || stack?.transition !== undefined || onStackAction === undefined) return;
    const startedAt = Date.now();
    setRunning(action);
    try {
      await onStackAction(action);
    }
    finally {
      // keep the clickable progress state from flickering
      const remaining = Math.max(0, 750 - (Date.now() - startedAt));
      if (remaining > 0) await new Promise(resolve => window.setTimeout(resolve, remaining));
      setRunning(undefined);
      setMenuOpen(false);
    }
  };
  // omit the control only when there is neither a project target nor stack actions
  if (url === undefined && !hasStackActions) return null;
  const operation = running ?? stack?.operation;
  const status = stack?.transition ?? (stack?.tunnel === true ? 'healthy' : stack?.tunnel === false ? 'down' : 'starting');
  const busy = operation !== undefined;
  const transitionLabel = stack?.transition === 'starting' ? 'Starting' : stack?.transition === 'migrating' ? 'Migrating' : undefined;
  const inProgress = busy || transitionLabel !== undefined;
  const unavailable = status === 'down' && !inProgress;
  // describe the server badge state
  const stackStatus = resolveStackStatus(stack, inProgress);
  // disable only known unavailable direct previews
  const browserUnavailable = inProgress || directProject && stack?.tunnel === false;
  const label = operation !== undefined ? `${stackOperationLabel(operation)}…` : transitionLabel !== undefined ? `${transitionLabel}…` : 'Open';
  const title = operation !== undefined ? `${stackOperationLabel(operation)} stack` : transitionLabel !== undefined ? `${transitionLabel} stack` : `Project is ${status}`;
  const logTitle = log === undefined ? 'Stack output' : log.active ? `${stackOperationLabel(log.action)} stack` : `${stackActionLabel(log.action)} output`;
  const logStatus = log === undefined ? 'Waiting for command output…' : log.active ? `${stackOperationLabel(log.action)}…` : `Finished ${new Date(log.completedAt ?? log.startedAt).toLocaleTimeString()}`;
  let splitTitle = 'Open split view';
  // explain unavailable split view
  if (!hasBrowserControl || browserUnavailable) splitTitle = 'Split view unavailable';
  // explain active split view
  else if (browserOpen) splitTitle = 'Close split view';
  // route project-button clicks
  const openProject = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // block unavailable navigation
    if (unavailable || inProgress) event.preventDefault();
    // reveal active stack output
    if (inProgress && hasStackLogs) openLogs();
  };
  const logDialog = logsOpen && createPortal(<section className="dialog stack-log-dialog" role="dialog" aria-modal="true" aria-label="Stack output"><div><header><strong>{logTitle}</strong>{log?.active && <span className="spinner" aria-hidden="true" />}<button type="button" aria-label="Close stack output" title="Close" onClick={() => setLogsOpen(false)}>×</button></header>{logError && <p className="stack-log-error" role="alert">{logError}</p>}<pre ref={logOutputRef} tabIndex={0} autoFocus>{log?.output || (log === undefined ? 'Waiting for command output…' : 'The command has not produced output yet.')}</pre><footer aria-live="polite">{logStatus}</footer></div></section>, document.body);
  const externalControl = url === undefined ? null : <a className={`project-menu-external${unavailable || inProgress ? ' disabled' : ''}`} href={url} target="_blank" rel="noreferrer" aria-disabled={unavailable || inProgress || undefined} aria-busy={inProgress || undefined} title={title} onClick={event => {
    // block unavailable navigation
    if (unavailable || inProgress) { event.preventDefault(); return; }
    setMenuOpen(false);
  }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></svg><span>Open</span></a>;
  const splitControl = url === undefined ? null : <button className="project-menu-split" type="button" disabled={!hasBrowserControl || browserUnavailable} aria-pressed={browserOpen} title={splitTitle} onClick={() => {
    // toggle the embedded project view
    onBrowserToggle?.();
    setMenuOpen(false);
  }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 4v16" /></svg><span>{browserOpen ? 'Close' : 'Split'}</span></button>;
  return <>
    <span className={`project-open-group${url === undefined ? ' stack-only' : ''}${hasBrowserControl ? ' has-browser-control' : ''}${hasStackActions ? ' has-stack-actions' : ''}`} ref={anchorRef} role="group" aria-label={url === undefined ? 'Stack controls' : 'Project controls'}>
      {hasStackActions ? <button className="project-stack-toggle project-stack-trigger icon-button" type="button" aria-label={`Stack controls: ${stackStatus}`} aria-expanded={menuOpen} title={`Stack controls · ${stackStatus}`} onClick={() => setMenuOpen(open => !open)}><svg className="project-stack-server-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" /></svg><i className={`project-stack-status-dot status-${stackStatus}`} aria-hidden="true" /></button> : url !== undefined && <><a className={`project-open status-${status}${unavailable ? ' disabled' : ''}${inProgress ? ' busy' : ''}`} href={url} target="_blank" rel="noreferrer" aria-disabled={unavailable || inProgress || undefined} aria-busy={inProgress || undefined} title={title} onClick={openProject}>{inProgress ? <span className="spinner" aria-hidden="true" /> : <i aria-hidden="true" />}{label}</a>{hasBrowserControl && <button className="project-browser-toggle icon-button" type="button" disabled={browserUnavailable} aria-label="Open project in split view" aria-pressed={browserOpen} title={browserUnavailable ? 'Split view unavailable' : 'Split view'} onClick={onBrowserToggle}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 4v16" /></svg></button>}</>}
    </span>
    {menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div className="stack-menu more-menu flyout-menu" ref={flyoutRef} style={style}>{actions.map(action => <button key={action} disabled={inProgress} onClick={() => void run(action)}>{operation === action ? <><span className="spinner" />{stackOperationLabel(action)}…</> : stackActionLabel(action)}</button>)}{hasStackLogs && <><hr className="more-menu-divider" /><button className="stack-log-menu-button" type="button" onClick={() => { setMenuOpen(false); openLogs(); }}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v12H5zM8 10l2 2-2 2M12 14h4" /></svg>Show output</button></>}{url !== undefined && <span className="project-stack-view-actions" role="group" aria-label="Project view controls">{externalControl}{splitControl}</span>}</div></FlyoutPortal>}
    {logDialog}
  </>;
}
