import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FlyoutPortal } from './flyout-portal.js';
import { PanelIcon, panelIcons } from './panel-header.js';
import { processActionLabel, processActions, stackActionLabel, stackOperationLabel, type ProcessNotice, type ProcessNoticeTarget, type StackAction, type StartableNoticeTarget, type StackOperationLog, type StackProcessOutput, type StackProcessState } from './stack-operations.js';
import { useViewportFlyout } from './viewport-flyout.js';

type ProjectStack = { actions?: StackAction[]; running?: boolean; operation?: StackAction; transition?: 'starting'|'migrating'; tunnel?: boolean; processes?: StackProcessState[] };
type ProjectStackStatus = 'working'|'exited'|'partial'|'healthy'|'down'|'running'|'stopped'|'unknown';
// which output the log dialog shows: the last one-shot command's, or a named Stack process's own
type StackLogViewer = { kind: 'command' } | { kind: 'process'; name: string };

// a process's state as the output dialog's footer and its menu section show it, with the exit
// code once it has died
const processStatusLabel = (process: StackProcessState) => process.state === 'running' ? 'Running' : process.state === 'stopped' ? 'Stopped' : process.exitCode === undefined ? 'Exited' : `Exited (${process.exitCode})`;

// run a stack action, holding its progress state at least 750 ms so a quick one never flickers
const withMinimumProgress = async (work: () => Promise<unknown> | unknown) => {
  const startedAt = Date.now();
  try { await work(); }
  finally {
    const remaining = Math.max(0, 750 - (Date.now() - startedAt));
    if (remaining > 0) await new Promise(resolve => window.setTimeout(resolve, remaining));
  }
};

// the mark of a warning Process notice, on the notice and on the stack badge
const WarningIcon = ({ className }: { className: string }) => <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20zM12 10v4M12 17h.01" /></svg>;

// a process's Process notices, each marked with its level and followed by its `controls`, or
// nothing when it has none
function ProcessNotices({ name, notices, controls }: { name: string; notices: ProcessNotice[] | undefined; controls?: (notice: ProcessNotice) => ReactNode }) {
  if (notices === undefined || notices.length === 0) return null;
  return <ul className="stack-process-notices" aria-label={`${name} notices`}>{notices.map((notice, index) => <li key={index} className={`stack-process-notice level-${notice.level}`}>{notice.level === 'warning' ? <WarningIcon className="stack-process-notice-icon" /> : <svg className="stack-process-notice-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01" /></svg>}<span className="stack-process-notice-body">{notice.message}{controls?.(notice)}</span></li>)}</ul>;
}

// A notice's Start of the process it names in another Worktree, by `noticeStartKey`: `pending`
// while its request is out, then sent and waiting for the next state to hide the notice, or failed
// with `error`. `id` tells one Start's completion and settle timer from a later Start's.
type NoticeStart = { id: number; pending: boolean; error?: string };
const noticeStartKey = (target: ProcessNoticeTarget) => `${target.worktreeId}\u0000${target.process ?? ''}`;
// how long a sent Start shows "Starting…" when no state hides its notice, before offering Start again
const noticeStartSettleMs = 15_000;

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
// `onProcessAction` starts, stops or restarts one of several Stack processes from its own section.
// A notice naming another Worktree offers Open (`onOpenNoticeTarget`, which switches to it) and,
// for a process there that is not running, Start (`onStartNoticeTarget`, which rejects with the
// reason it failed) while this menu stays open; `worktreeId` is this stack's own Worktree, which a
// notice has no need to Open. `menuRequested` opens the menu once, as a notice's Open asks of the
// Worktree it switches to.
export function ProjectOpen({ url, stack, worktreeId, browserOpen = false, onBrowserToggle, onStackAction, onStackLog, onProcessOutput, onProcessAction, onOpenTerminal, onOpenNoticeTarget, onStartNoticeTarget, menuRequested = false }: { worktreeId?: string; url?: string; stack?: ProjectStack; browserOpen?: boolean; onBrowserToggle?: () => void; onStackAction?: (action: StackAction) => Promise<unknown> | unknown; onStackLog?: () => Promise<StackOperationLog | undefined>; onProcessOutput?: (name: string) => Promise<StackProcessOutput | undefined>; onProcessAction?: (name: string, action: StackAction) => Promise<unknown> | unknown; onOpenTerminal?: (paneId: string, name: string) => void; onOpenNoticeTarget?: (target: ProcessNoticeTarget) => void; onStartNoticeTarget?: (target: StartableNoticeTarget) => Promise<unknown>; menuRequested?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // whether `menuRequested` has had its one opening
  const menuRequestHandled = useRef(false);
  // the Starts sent from notices, by target, and the source of their ids
  const [noticeStarts, setNoticeStarts] = useState<ReadonlyMap<string, NoticeStart>>(() => new Map());
  const noticeStartIds = useRef(0);
  const [running, setRunning] = useState<StackAction>();
  // the one-process action this menu sent, until its request returns
  const [runningProcess, setRunningProcess] = useState<{ name: string; action: StackAction }>();
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
  const hasStackLogs = actions.some(action => stack?.processes === undefined || !(processActions as readonly StackAction[]).includes(action)) && onStackLog !== undefined;
  // several processes each get a menu section; one is the whole stack, so its menu stays compact
  const processSections = (stack?.processes?.length ?? 0) > 1;
  const outputProcesses = onProcessOutput === undefined || processSections ? [] : (stack?.processes ?? []).map(process => process.name);
  // a one-process action in flight, sent from here or (as the dashboard reports it) elsewhere
  const processOperation = runningProcess ?? stack?.processes?.flatMap(process => process.operation === undefined ? [] : [{ name: process.name, action: process.operation }])[0];
  // require only a usable target and handler
  const hasBrowserControl = url !== undefined && onBrowserToggle !== undefined;
  useEffect(() => {
    // open the menu once when asked to, if there is a menu to open
    if (!menuRequested || !hasStackActions || menuRequestHandled.current) return;
    menuRequestHandled.current = true;
    setMenuOpen(true);
  }, [menuRequested, hasStackActions]);
  // the start keys of the targets the showing notices name, joined into one comparable string
  const shownTargetKeys = (stack?.processes ?? []).flatMap(process => process.notices ?? []).flatMap(notice => notice.target === undefined ? [] : [noticeStartKey(notice.target)]).join('\u0001');
  const shownTargetKeysRef = useRef(shownTargetKeys);
  shownTargetKeysRef.current = shownTargetKeys;
  useEffect(() => {
    // forget a finished Start once no notice names its target: the process runs, so the notice
    // hid; one still waiting on its request stays, so its target cannot be started twice
    const shown = new Set(shownTargetKeys.split('\u0001'));
    const kept = ([key, start]: [string, NoticeStart]) => start.pending || shown.has(key);
    setNoticeStarts(current => [...current].every(kept) ? current : new Map([...current].filter(kept)));
  }, [shownTargetKeys]);
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
  const allowed = (action: StackAction) => running === undefined && stack?.operation === undefined && processOperation === undefined && (stack?.transition === undefined || (stack.transition === 'starting' && (action === 'stop' || action === 'restart')));
  // One process's action waits only for any other action in flight, or a migration. Starting a
  // stopped process while the stack is still Starting overlaps nothing; a running one has nothing
  // to start, and a stopped one nothing to stop.
  const processAllowed = (process: StackProcessState, action: StackAction) => running === undefined && stack?.operation === undefined && processOperation === undefined && stack?.transition !== 'migrating'
    && !(action === 'start' && process.state === 'running') && !(action === 'stop' && process.state === 'stopped');
  // launch one process's action, leaving the menu open on the result
  const runProcess = async (process: StackProcessState, action: StackAction) => {
    if (!processAllowed(process, action) || onProcessAction === undefined) return;
    setRunningProcess({ name: process.name, action });
    try { await withMinimumProgress(() => onProcessAction(process.name, action)); }
    finally { setRunningProcess(undefined); }
  };
  // start a notice's process in its own Worktree, leaving this menu open: the notice shows
  // "Starting…" until the next state hides it, or the error when the Start fails
  const startNoticeTarget = async (target: StartableNoticeTarget) => {
    const key = noticeStartKey(target);
    if (onStartNoticeTarget === undefined || (noticeStarts.has(key) && noticeStarts.get(key)?.error === undefined)) return;
    const id = ++noticeStartIds.current;
    // a completion only updates the Start it belongs to, never a later one
    const settle = (next?: NoticeStart) => setNoticeStarts(current => {
      if (current.get(key)?.id !== id) return current;
      const updated = new Map(current);
      if (next === undefined) updated.delete(key); else updated.set(key, next);
      return updated;
    });
    setNoticeStarts(current => new Map(current).set(key, { id, pending: true }));
    try {
      await withMinimumProgress(() => onStartNoticeTarget(target));
      // a notice already hidden is done with; one still showing waits for the next state
      if (!shownTargetKeysRef.current.split('\u0001').includes(key)) return settle();
      settle({ id, pending: false });
      window.setTimeout(() => settle(), noticeStartSettleMs);
    } catch (error) {
      settle({ id, pending: false, error: error instanceof Error && error.message !== '' ? error.message : `Unable to start ${target.process}.` });
    }
  };
  // a notice's Open and Start, or "Starting…" in their place while its Start is under way
  const noticeControls = (notice: ProcessNotice) => {
    const target = notice.target;
    if (target === undefined) return null;
    // only a declared process has a state, and a notice about a running one does not show
    const process = onStartNoticeTarget === undefined || target.state === undefined ? undefined : target.process;
    // this stack's own Worktree is already open
    const openable = onOpenNoticeTarget !== undefined && target.worktreeId !== worktreeId;
    if (!openable && process === undefined) return null;
    const start = process === undefined ? undefined : noticeStarts.get(noticeStartKey(target));
    return <span className="stack-process-notice-actions">
      {process !== undefined && start !== undefined && start.error === undefined
        ? <span className="stack-process-notice-progress" role="status"><span className="spinner" aria-hidden="true" /><span>Starting <code>{process}</code>…</span></span>
        : <>
          {openable && <button type="button" title={`Open ${target.label} and its stack controls`} onClick={() => onOpenNoticeTarget?.(target)}>Open {target.label}</button>}
          {process !== undefined && <button type="button" aria-label={`Start ${process} in ${target.label}`} title={`Start ${process} in ${target.label}`} onClick={() => void startNoticeTarget({ ...target, process })}>Start {process}</button>}
        </>}
      {start?.error !== undefined && <span className="stack-process-notice-error" role="alert">Start failed: {start.error}</span>}
    </span>;
  };
  // launch one stack action
  const run = async (action: StackAction) => {
    // reject overlapping operations and transitions
    if (!allowed(action) || onStackAction === undefined) return;
    setRunning(action);
    try { await withMinimumProgress(() => onStackAction(action)); }
    finally {
      setRunning(undefined);
      setMenuOpen(false);
    }
  };
  // omit the control only when there is neither a project target nor stack actions
  if (url === undefined && !hasStackActions) return null;
  // a single process has no section, so an action on it alone (from MCP) shows as the stack's
  const operation = running ?? stack?.operation ?? (processSections ? undefined : processOperation?.action);
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
  // a warning notice marks the badge on top of whatever state it shows, and its tooltip lists them
  const warnings = processes.flatMap(process => (process.notices ?? []).filter(notice => notice.level === 'warning').map(notice => notice.message));
  const stackLabel = warnings.length === 0 ? stackDescription : `${stackDescription}, warning: ${warnings.join('; ')}`;
  const stackTitle = `Stack controls · ${stackDescription}${warnings.map(message => `\n⚠ ${message}`).join('')}`;
  // a lone process has no section, so its notices sit in the compact menu
  const loneProcess = processSections ? undefined : stack?.processes?.[0];
  const loneNotices = loneProcess?.notices === undefined || loneProcess.notices.length === 0 ? null : <><hr className="more-menu-divider" /><ProcessNotices name={loneProcess.name} notices={loneProcess.notices} controls={noticeControls} /></>;
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
  // one section per process: its state (or the action in flight on it), its own actions and its output
  const processSectionList = processSections && (stack?.processes ?? []).map(process => {
    const inFlight = processOperation?.name === process.name ? processOperation.action : undefined;
    return <div key={process.name} className="stack-process" role="group" aria-label={`${process.name} process`} aria-busy={inFlight !== undefined || undefined}>
      <div className="stack-process-heading"><i className={`stack-process-dot state-${process.state}`} aria-hidden="true" /><span className="stack-process-name">{process.name}</span><span className="stack-process-state">{inFlight === undefined ? processStatusLabel(process) : <><span className="spinner" aria-hidden="true" />{stackOperationLabel(inFlight)}…</>}</span></div>
      <ProcessNotices name={process.name} notices={process.notices} controls={noticeControls} />
      {onProcessAction !== undefined && <div className="stack-process-actions">{processActions.map(action => <button key={action} type="button" disabled={!processAllowed(process, action)} aria-label={`${processActionLabel(action)} ${process.name}`} onClick={() => void runProcess(process, action)}>{processActionLabel(action)}</button>)}</div>}
      {onProcessOutput !== undefined && <button className="stack-log-menu-button" type="button" onClick={() => openLogs({ kind: 'process', name: process.name })}>{logIcon}Show {process.name} output</button>}
    </div>;
  });
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
      {hasStackActions ? <button className="project-stack-toggle project-stack-trigger toolbar-button" type="button" aria-label={`Stack controls: ${stackLabel}`} data-context-flyout aria-expanded={menuOpen} title={stackTitle} onClick={() => setMenuOpen(open => !open)}><span className="flyout-caret" aria-hidden="true" /><svg className="project-stack-server-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" /></svg><span className="toolbar-label">Stack</span><span className="project-stack-status-text">{stackStatusText}</span><i className={`project-stack-status-dot status-${stackStatus}`} aria-hidden="true" />{warnings.length > 0 && <WarningIcon className="project-stack-warning" />}</button> : url !== undefined && <a className={`project-open status-${status}${inProgress ? ' busy' : ''}`} href={url} target="_blank" rel="noreferrer" aria-busy={inProgress || undefined} title={title}>{inProgress ? <span className="spinner" aria-hidden="true" /> : <i aria-hidden="true" />}{label}</a>}
    </span>
    {menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div className={`stack-menu more-menu flyout-menu${processSections ? ' has-process-sections' : ''}`} ref={flyoutRef} style={style}>{actions.map(action => <button key={action} disabled={!allowed(action)} onClick={() => void run(action)}>{operation === action ? <><span className="spinner" />{stackOperationLabel(action)}…</> : stackActionLabel(action)}</button>)}{processSectionList && <><hr className="more-menu-divider" />{processSectionList}</>}{loneNotices}{(outputProcesses.length > 0 || hasStackLogs) && <hr className="more-menu-divider" />}{outputProcesses.map(name => <button key={name} className="stack-log-menu-button" type="button" onClick={() => openLogs({ kind: 'process', name })}>{logIcon}Show {name} output</button>)}{hasStackLogs && <button className="stack-log-menu-button" type="button" onClick={() => openLogs({ kind: 'command' })}>{logIcon}Show last command output</button>}{url !== undefined && <span className="project-stack-view-actions" role="group" aria-label="Project view controls">{externalControl}{splitControl}</span>}</div></FlyoutPortal>}
    {logDialog}
  </>;
}
