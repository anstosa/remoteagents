import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FlyoutPortal } from './flyout-portal.js';
import { PanelIcon, panelIcons } from './panel-header.js';
import { processActions, stackActionLabel, stackOperationLabel, type StackAction, type StackOperationLog, type StackProcessOutput, type StackProcessState } from './stack-operations.js';
import { useViewportFlyout } from './viewport-flyout.js';

type ProjectStack = { actions?: StackAction[]; running?: boolean; operation?: StackAction; transition?: 'starting'|'migrating'; tunnel?: boolean; processes?: StackProcessState[] };
type ProjectStackStatus = 'working'|'exited'|'partial'|'healthy'|'down'|'running'|'stopped'|'unknown';
// which output the log dialog shows: the last one-shot command's, or a named Stack process's own
type StackLogViewer = { kind: 'command' } | { kind: 'process'; name: string };

// the process output dialog's footer: its state, with the exit code once it has died
const processStatusLabel = (output: StackProcessOutput) => output.state === 'running' ? 'Running' : output.state === 'stopped' ? 'Stopped' : output.exitCode === undefined ? 'Exited' : `Exited (${output.exitCode})`;

// how many of a stack's Stack processes are running
const runningCount = (processes: StackProcessState[]) => processes.filter(process => process.state === 'running').length;

// derive the stack status badge
function resolveStackStatus(stack: ProjectStack | undefined, inProgress: boolean): ProjectStackStatus {
  // prioritize active operations
  if (inProgress) return 'working';
  // a Stack process that died on its own, a stack only partly running, or one stopped outranks
  // whatever its tunnel says: a check from before a Stop can still read healthy, and a failing
  // one would read as broken
  if (stack?.processes !== undefined) {
    if (stack.processes.some(process => process.state === 'exited')) return 'exited';
    const live = runningCount(stack.processes);
    if (live === 0) return 'stopped';
    if (live < stack.processes.length) return 'partial';
  }
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

// The project's toolbar controls: the stack button and its menu (which also opens the project in
// a new tab or the browser panel) or, with no stack commands, a link to the project.
// `onOpenTerminal` opens a running Stack process's pane as a Terminal panel, named for the process.
export function ProjectOpen({ url, stack, browserOpen = false, onBrowserToggle, onStackAction, onStackLog, onProcessOutput, onOpenTerminal }: { url?: string; stack?: ProjectStack; browserOpen?: boolean; onBrowserToggle?: () => void; onStackAction?: (action: StackAction) => Promise<unknown> | unknown; onStackLog?: () => Promise<StackOperationLog | undefined>; onProcessOutput?: (name: string) => Promise<StackProcessOutput | undefined>; onOpenTerminal?: (paneId: string, name: string) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [running, setRunning] = useState<StackAction>();
  const [viewer, setViewer] = useState<StackLogViewer>();
  const [log, setLog] = useState<StackOperationLog>();
  const [processOutput, setProcessOutput] = useState<StackProcessOutput>();
  const [logError, setLogError] = useState('');
  const logOutputRef = useRef<HTMLPreElement | null>(null);
  // whether the viewer sits at the bottom of its output, where new output keeps it
  const followOutputRef = useRef(true);
  const stackLogRef = useRef(onStackLog);
  stackLogRef.current = onStackLog;
  const processOutputRef = useRef(onProcessOutput);
  processOutputRef.current = onProcessOutput;
  const { anchorRef, flyoutRef, style } = useViewportFlyout(menuOpen);
  const actions = stack?.actions ?? [];
  const hasStackActions = actions.length > 0 && onStackAction !== undefined;
  // a Stack process's own actions leave no command output; only one-shot actions do
  const hasStackLogs = actions.some(action => stack?.processes === undefined || !processActions.includes(action)) && onStackLog !== undefined;
  const outputProcesses = onProcessOutput === undefined ? [] : (stack?.processes ?? []).map(process => process.name);
  // require only a usable target and handler
  const hasBrowserControl = url !== undefined && onBrowserToggle !== undefined;
  useEffect(() => {
    // poll only while the log viewer is open
    if (viewer === undefined) return;
    let active = true;
    let loading = false;
    // fetch the viewer's output, returning how to show it once the dialog is known to be open
    const read = viewer.kind === 'process'
      ? async () => { const next = await processOutputRef.current?.(viewer.name); return () => setProcessOutput(next); }
      : async () => { const next = await stackLogRef.current?.(); return () => setLog(next); };
    // refresh the retained command output, or the process pane's
    const refresh = async () => {
      // avoid overlapping slow requests
      if (loading) return;
      loading = true;
      try {
        const show = await read();
        // ignore responses after closing
        if (!active) return;
        show();
        setLogError('');
      } catch {
        // retain prior output through transient failures
        if (active) setLogError('Unable to refresh stack output.');
      } finally { loading = false; }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 750);
    return () => { active = false; window.clearInterval(interval); };
  }, [viewer]);
  const processViewer = viewer?.kind === 'process' ? viewer : undefined;
  const shownOutput = processViewer !== undefined ? processOutput?.output : log?.output;
  useEffect(() => {
    // follow new output while the viewer is open, unless the operator scrolled up to read
    if (viewer === undefined || logOutputRef.current === null || !followOutputRef.current) return;
    logOutputRef.current.scrollTop = logOutputRef.current.scrollHeight;
  }, [shownOutput, viewer]);
  useEffect(() => {
    // close the viewer with Escape
    if (viewer === undefined) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setViewer(undefined); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [viewer]);
  // open the latest retained output, starting from nothing so another viewer's text never shows
  const openLogs = (next: StackLogViewer) => { setLogError(''); if (next.kind === 'process') setProcessOutput(undefined); followOutputRef.current = true; setMenuOpen(false); setViewer(next); };
  // a stack still Starting is already up, just not yet healthy, so it can be stopped or
  // restarted; only another Start, or anything during a migration, would overlap
  const allowed = (action: StackAction) => running === undefined && stack?.operation === undefined && (stack?.transition === undefined || (stack.transition === 'starting' && (action === 'stop' || action === 'restart')));
  // launch one stack action
  const run = async (action: StackAction) => {
    // reject overlapping operations and transitions
    if (!allowed(action) || onStackAction === undefined) return;
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
  // describe the server badge state
  const stackStatus = resolveStackStatus(stack, inProgress);
  // a partial stack counts its running processes on the badge
  const processes = stack?.processes ?? [];
  const stackStatusText = stackStatus === 'partial' ? `${runningCount(processes)} of ${processes.length} running` : stackStatus;
  // name each exited process and its code for the tooltip and screen readers
  const exited = processes.filter(process => process.state === 'exited');
  const stackDescription = stackStatus === 'exited' && exited.length > 0 ? exited.map(process => `${process.name} exited${process.exitCode === undefined ? '' : ` (${process.exitCode})`}`).join(', ') : stackStatusText;
  const label = operation !== undefined ? `${stackOperationLabel(operation)}…` : transitionLabel !== undefined ? `${transitionLabel}…` : 'Open';
  const title = operation !== undefined ? `${stackOperationLabel(operation)} stack` : transitionLabel !== undefined ? `${transitionLabel} stack` : `Project is ${status}`;
  // what the log dialog shows for each viewer: its accessible name, heading, text and footer
  const processTitle = `${processOutput?.name ?? processViewer?.name ?? 'Process'} output`;
  const processWaiting = 'Waiting for process output…';
  const commandWaiting = 'Waiting for command output…';
  const logView = processViewer !== undefined
    ? { name: processTitle, title: processTitle, busy: false, text: processOutput?.output || (processOutput === undefined ? processWaiting : processOutput.state === 'stopped' ? 'The process is not running.' : 'The process has not produced output yet.'), status: processOutput === undefined ? processWaiting : processStatusLabel(processOutput) }
    : { name: 'Stack output', title: log === undefined ? 'Stack output' : log.active ? `${stackOperationLabel(log.action)} stack` : `${stackActionLabel(log.action)} output`, busy: log?.active === true, text: log?.output || (log === undefined ? commandWaiting : 'The command has not produced output yet.'), status: log === undefined ? commandWaiting : log.active ? `${stackOperationLabel(log.action)}…` : `Finished ${new Date(log.completedAt ?? log.startedAt).toLocaleTimeString()}` };
  // only a live process pane can be streamed as a Terminal
  const terminalPane = processViewer !== undefined && onOpenTerminal !== undefined && processOutput?.paneId !== undefined ? { paneId: processOutput.paneId, name: processOutput.name } : undefined;
  const openTerminal = terminalPane === undefined ? null : <button type="button" className="stack-log-open-terminal" title={`Open ${terminalPane.name} as a Terminal panel`} onClick={() => { setViewer(undefined); onOpenTerminal?.(terminalPane.paneId, terminalPane.name); }}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM7 9l3 3-3 3M12 15h5" /></svg>Open as Terminal</button>;
  const logIcon = <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v12H5zM8 10l2 2-2 2M12 14h4" /></svg>;
  const splitTitle = browserOpen ? 'Close split view' : 'Open split view';
  const logDialog = viewer !== undefined && createPortal(<section className="dialog stack-log-dialog" role="dialog" aria-modal="true" aria-label={logView.name}><div><header><strong>{logView.title}</strong>{logView.busy && <span className="spinner" aria-hidden="true" />}{openTerminal}<button type="button" aria-label="Close stack output" title="Close" onClick={() => setViewer(undefined)}><PanelIcon path={panelIcons.close} /></button></header>{logError && <p className="stack-log-error" role="alert">{logError}</p>}<pre ref={logOutputRef} tabIndex={0} autoFocus onScroll={event => { const output = event.currentTarget; followOutputRef.current = output.scrollHeight - output.scrollTop - output.clientHeight < 24; }}>{logView.text}</pre><footer aria-live="polite">{logView.status}</footer></div></section>, document.body);
  const externalControl = url === undefined ? null : <a className="project-menu-external" href={url} target="_blank" rel="noreferrer" aria-busy={inProgress || undefined} title={title} onClick={() => {
    // close after external navigation
    setMenuOpen(false);
  }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></svg><span>Open</span></a>;
  const splitControl = !hasBrowserControl ? null : <button className="project-menu-split" type="button" aria-pressed={browserOpen} title={splitTitle} onClick={() => {
    // toggle the embedded project view
    onBrowserToggle?.();
    setMenuOpen(false);
  }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 4v16" /></svg><span>{browserOpen ? 'Close' : 'Split'}</span></button>;
  return <>
    <span className={`project-open-group${url === undefined ? ' stack-only' : ''}${hasStackActions ? ' has-stack-actions' : ''}`} ref={anchorRef} role="group" aria-label={url === undefined ? 'Stack controls' : 'Project controls'}>
      {hasStackActions ? <button className="project-stack-toggle project-stack-trigger toolbar-button" type="button" aria-label={`Stack controls: ${stackDescription}`} data-context-flyout aria-expanded={menuOpen} title={`Stack controls · ${stackDescription}`} onClick={() => setMenuOpen(open => !open)}><span className="flyout-caret" aria-hidden="true" /><svg className="project-stack-server-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" /></svg><span className="toolbar-label">Stack</span><span className="project-stack-status-text">{stackStatusText}</span><i className={`project-stack-status-dot status-${stackStatus}`} aria-hidden="true" /></button> : url !== undefined && <a className={`project-open status-${status}${inProgress ? ' busy' : ''}`} href={url} target="_blank" rel="noreferrer" aria-busy={inProgress || undefined} title={title}>{inProgress ? <span className="spinner" aria-hidden="true" /> : <i aria-hidden="true" />}{label}</a>}
    </span>
    {menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div className="stack-menu more-menu flyout-menu" ref={flyoutRef} style={style}>{actions.map(action => <button key={action} disabled={!allowed(action)} onClick={() => void run(action)}>{operation === action ? <><span className="spinner" />{stackOperationLabel(action)}…</> : stackActionLabel(action)}</button>)}{(outputProcesses.length > 0 || hasStackLogs) && <hr className="more-menu-divider" />}{outputProcesses.map(name => <button key={name} className="stack-log-menu-button" type="button" onClick={() => openLogs({ kind: 'process', name })}>{logIcon}Show {name} output</button>)}{hasStackLogs && <button className="stack-log-menu-button" type="button" onClick={() => openLogs({ kind: 'command' })}>{logIcon}Show last command output</button>}{url !== undefined && <span className="project-stack-view-actions" role="group" aria-label="Project view controls">{externalControl}{splitControl}</span>}</div></FlyoutPortal>}
    {logDialog}
  </>;
}
