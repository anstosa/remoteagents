import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';

export type ReviewScope = 'working' | 'pr';
export type ReviewLaunch = { agentId: string; worktreeId: string; scope: ReviewScope };
export type ReviewTourIndicator = { generating: boolean; stale: boolean };
type ReviewChange = { id: string; file: string; originalFile?: string; category: 'implementation' | 'test' | 'doc'; kind: 'hunk' | 'binary' | 'rename' | 'metadata' | 'untracked'; patch: string };
type ReviewStep = { id: string; title: string; explanation: string; changeIds: string[] };
export type ReviewTour = { title: string; overview: string; scope: ReviewScope; base: string; includeTests: boolean; includeDocs: boolean; fingerprint: string; changes: ReviewChange[]; steps: ReviewStep[] };
type ReviewRequest = (url: string, init?: RequestInit) => Promise<Response>;
type StepState = 'unvisited' | 'visited' | 'skipped';
type Job = { id: string; expiresAt: string; retryAfterMs: number };
type Snapshot = { scope: ReviewScope; base: string; includeTests: boolean; includeDocs: boolean; fingerprint: string };
type ViewState = 'loading' | 'tour' | 'summary' | 'empty' | 'error' | 'cancelled';

const maxFeedback = 4_000;
const maxFeedbackTotal = 20_000;
const maxDispatch = 30_000;
const transitionMs = 240;

// validate trusted review changes
function isChange(value: unknown): value is ReviewChange {
  if (value === null || typeof value !== 'object') return false;
  const change = value as ReviewChange;
  return typeof change.id === 'string' && typeof change.file === 'string' && typeof change.patch === 'string'
    && (change.originalFile === undefined || typeof change.originalFile === 'string')
    && ['implementation', 'test', 'doc'].includes(change.category)
    && ['hunk', 'binary', 'rename', 'metadata', 'untracked'].includes(change.kind);
}

// validate generated tour responses
export function isReviewTour(value: unknown): value is ReviewTour {
  // require the public tour envelope
  if (value === null || typeof value !== 'object') return false;
  const tour = value as ReviewTour;
  const structural = typeof tour.title === 'string' && typeof tour.overview === 'string' && typeof tour.base === 'string' && typeof tour.fingerprint === 'string'
    && (tour.scope === 'working' || tour.scope === 'pr') && typeof tour.includeTests === 'boolean' && typeof tour.includeDocs === 'boolean'
    && Array.isArray(tour.changes) && tour.changes.every(isChange) && Array.isArray(tour.steps) && tour.steps.length > 0
    && tour.steps.every(step => step !== null && typeof step === 'object' && typeof step.id === 'string' && typeof step.title === 'string' && typeof step.explanation === 'string' && Array.isArray(step.changeIds) && step.changeIds.every(id => typeof id === 'string'));
  // require a structurally safe artifact
  if (!structural) return false;
  const changeIds = new Set(tour.changes.map(change => change.id));
  const assigned = tour.steps.flatMap(step => step.changeIds);
  // require exact one-time assignments
  return changeIds.size === tour.changes.length && assigned.length === changeIds.size && new Set(assigned).size === assigned.length && assigned.every(id => changeIds.has(id));
}

// validate bounded job descriptors
function isJob(value: unknown): value is Job {
  return value !== null && typeof value === 'object' && typeof (value as Job).id === 'string' && typeof (value as Job).expiresAt === 'string' && typeof (value as Job).retryAfterMs === 'number';
}

// validate public snapshot identities
function isSnapshot(value: unknown): value is Snapshot {
  return value !== null && typeof value === 'object' && ((value as Snapshot).scope === 'working' || (value as Snapshot).scope === 'pr') && typeof (value as Snapshot).base === 'string' && typeof (value as Snapshot).includeTests === 'boolean' && typeof (value as Snapshot).includeDocs === 'boolean' && typeof (value as Snapshot).fingerprint === 'string';
}

// translate typed server failures
function errorMessage(code: string | undefined): string {
  // select recoverable user copy
  if (code === 'scope_unavailable') return 'The selected Git comparison is unavailable.';
  if (code === 'conflicted_unavailable') return 'Resolve merge conflicts before generating a tour.';
  if (code === 'too_large') return 'This change is too large for a complete guided tour.';
  if (code === 'timed_out') return 'Tour generation timed out.';
  if (code === 'stale_during_generation') return 'The change moved while the tour was being generated.';
  if (code === 'capability_unavailable') return 'Guided review is unavailable on this server.';
  // explain expired generator credentials
  if (code === 'authentication_required') return 'The server’s Codex login expired. Sign in to Codex on the server, then try again.';
  if (code === 'configured_worktree_required') return 'Guided review requires a configured worktree.';
  if (code === 'generation_rejected') return 'The generated response was not an explanatory tour. Try again.';
  if (code === 'cancelled') return 'Tour generation was cancelled.';
  if (code === 'malformed_result') return 'The generated tour was incomplete. Try again.';
  // explain unclassified process failures
  if (code === 'generation_failed') return 'Codex exited before returning a guided tour. Try again; if it keeps failing, verify the server’s Codex login and network access.';
  return 'The guided tour could not be generated.';
}

// read one response safely
async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json().then(value => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}).catch(() => ({}));
}

// format one consolidated change request
function feedbackDraft(tour: ReviewTour, feedback: Record<string, string>, statuses: Record<string, StepState>, orphanFeedback: string): string {
  const notes = tour.steps.flatMap(step => {
    const note = feedback[step.id]?.trim();
    return note ? [`## ${step.title} (${statuses[step.id] ?? 'unvisited'})\n${note}`] : [];
  });
  return [`Please address the feedback from my guided review of ${tour.scope === 'working' ? 'Working' : 'All PR'} changes against ${tour.base}.`, `Tour: ${tour.title}`, `Snapshot: ${tour.fingerprint.slice(0, 12)}`, ...notes, ...(orphanFeedback.trim() === '' ? [] : [`## Feedback retained from regenerated steps\n${orphanFeedback.trim()}`])].join('\n\n');
}

// classify unified diff lines
const patchLineClass = (line: string) => line.startsWith('@@') ? 'hunk' : line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') ? 'metadata' : line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : 'context';

// render a color-coded patch
function ReviewPatch({ patch }: { patch: string }) {
  const lines = patch.split('\n');
  // preserve every visible patch line
  return <pre>{lines.map((line, index) => <span className={`review-patch-line ${patchLineClass(line)}`} key={`${index}:${line}`}>{line || ' '}</span>)}</pre>;
}

// render and manage one guided review
export function ReviewTourDialog({ launch, request, minimized, initialTour, onMinimize, onDismiss, onIndicatorChange, onReady }: { launch: ReviewLaunch; request: ReviewRequest; minimized: boolean; initialTour?: ReviewTour; onMinimize: () => void; onDismiss: () => Promise<boolean>; onIndicatorChange: (indicator: ReviewTourIndicator) => void; onReady: (tour: ReviewTour) => void }) {
  const [includeTests, setIncludeTests] = useState(initialTour?.includeTests ?? false);
  const [includeDocs, setIncludeDocs] = useState(initialTour?.includeDocs ?? false);
  const [state, setState] = useState<ViewState>(initialTour === undefined ? 'loading' : 'tour');
  const [tour, setTour] = useState<ReviewTour | undefined>(initialTour);
  const [job, setJob] = useState<Job>();
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(0);
  const [statuses, setStatuses] = useState<Record<string, StepState>>(initialTour === undefined ? {} : { [initialTour.steps[0]!.id]: 'visited' });
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [orphanFeedback, setOrphanFeedback] = useState('');
  const [dispatch, setDispatch] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [sent, setSent] = useState(false);
  const [stale, setStale] = useState(false);
  const [retry, setRetry] = useState(0);
  const [closing, setClosing] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState('');
  const generation = useRef(0);
  const dialog = useRef<HTMLDivElement | null>(null);
  const dispatchError = useRef<HTMLParagraphElement | null>(null);
  const minimizeTimer = useRef<number | undefined>(undefined);
  const onReadyRef = useRef(onReady);

  // retain the latest notification callback
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  // focus the review surface when restored
  useEffect(() => { if (!minimized) dialog.current?.focus(); }, [minimized]);

  // reset the exit state while cached
  useEffect(() => { if (minimized) setClosing(false); }, [minimized]);

  // release pending transition timers
  useEffect(() => () => {
    // clear an active minimize delay
    if (minimizeTimer.current !== undefined) window.clearTimeout(minimizeTimer.current);
  }, []);

  // publish the minimized button state
  useEffect(() => { onIndicatorChange({ generating: state === 'loading', stale }); }, [state, stale, onIndicatorChange]);

  // focus recoverable dispatch failures after render
  useEffect(() => {
    // wait for the summary error element
    if (state !== 'summary' || error === '') return;
    const frame = window.requestAnimationFrame(() => dispatchError.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [state, error]);

  // generate for the fixed scope and current filters
  useEffect(() => {
    const restored = initialTour !== undefined && retry === 0 && includeTests === initialTour.includeTests && includeDocs === initialTour.includeDocs;
    // display the restored artifact before any requested regeneration
    if (restored) {
      setTour(initialTour);
      setStatuses({ [initialTour.steps[0]!.id]: 'visited' });
      setCurrent(currentStep => Math.min(currentStep, initialTour.steps.length - 1));
      setState('tour');
      setError('');
      setStale(false);
      return;
    }
    let closed = false;
    let timer: number | undefined;
    let createdJob: Job | undefined;
    const run = ++generation.current;
    setState('loading');
    setError('');
    setTour(undefined);
    setJob(undefined);
    setStale(false);
    setSent(false);
    // poll one bounded job
    const poll = async (next: Job) => {
      const response = await request(`/api/review-tour/jobs/${encodeURIComponent(next.id)}`);
      const body = await responseBody(response);
      // ignore replaced generations
      if (closed || generation.current !== run) return;
      // keep polling pending work
      if (response.status === 202 && body.status === 'pending') {
        timer = window.setTimeout(() => void poll(next), Math.max(250, Math.min(5_000, next.retryAfterMs)));
        return;
      }
      // publish a validated tour
      if (response.ok && body.status === 'ready' && isReviewTour(body.tour) && body.tour.scope === launch.scope && body.tour.includeTests === includeTests && body.tour.includeDocs === includeDocs) {
        const ready = body.tour;
        const nextStepIds = new Set(ready.steps.map(candidate => candidate.id));
        const orphaned = tour?.steps.flatMap(candidate => {
          const note = feedback[candidate.id]?.trim();
          return note !== undefined && note !== '' && !nextStepIds.has(candidate.id) ? [`${candidate.title}: ${note}`] : [];
        }) ?? [];
        // preserve feedback detached by regeneration
        if (orphaned.length > 0) setOrphanFeedback(current => [current.trim(), ...orphaned].filter(Boolean).join('\n\n'));
        setFeedback(current => Object.fromEntries(Object.entries(current).filter(([id]) => nextStepIds.has(id))));
        setTour(ready);
        setStatuses({ [ready.steps[0]!.id]: 'visited' });
        setCurrent(0);
        setState('tour');
        onReadyRef.current(ready);
        return;
      }
      // publish an empty selection
      if (response.ok && body.status === 'empty') { setState('empty'); return; }
      const failure = body.error as { code?: unknown } | undefined;
      setError(errorMessage(typeof failure?.code === 'string' ? failure.code : undefined));
      setState(response.status === 410 ? 'cancelled' : 'error');
    };
    // create one generation job
    const start = async () => {
      const response = await request(`/api/agents/${encodeURIComponent(launch.agentId)}/review-tour/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: launch.scope, includeTests, includeDocs }) });
      const body = await responseBody(response);
      const pending = body.job;
      // reap jobs created after local closure
      if (closed || generation.current !== run) {
        if (response.status === 202 && body.status === 'pending' && isJob(pending)) void request(`/api/review-tour/jobs/${encodeURIComponent(pending.id)}`, { method: 'DELETE' });
        return;
      }
      // publish an empty selection
      if (response.ok && body.status === 'empty') { setState('empty'); return; }
      // require a bounded job descriptor
      if (response.status === 202 && body.status === 'pending' && isJob(pending)) {
        createdJob = pending;
        setJob(pending);
        await poll(pending);
        return;
      }
      const failure = body.error as { code?: unknown } | undefined;
      setError(errorMessage(typeof failure?.code === 'string' ? failure.code : undefined));
      setState('error');
    };
    void start();
    // cancel obsolete generation jobs
    return () => {
      closed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (createdJob !== undefined) void request(`/api/review-tour/jobs/${encodeURIComponent(createdJob.id)}`, { method: 'DELETE' });
    };
  }, [launch.agentId, launch.scope, includeTests, includeDocs, retry, request, initialTour]);

  // poll snapshot freshness while reviewing
  useEffect(() => {
    // wait for a usable tour
    if (tour === undefined || state === 'loading') return;
    let stopped = false;
    const check = async () => {
      const query = new URLSearchParams({ scope: launch.scope, includeTests: String(includeTests), includeDocs: String(includeDocs) });
      const response = await request(`/api/agents/${encodeURIComponent(launch.agentId)}/review-tour/fingerprint?${query}`);
      const body = await responseBody(response);
      const snapshot = body.snapshot;
      const currentSnapshot = response.ok && isSnapshot(snapshot) && snapshot.scope === launch.scope && snapshot.includeTests === includeTests && snapshot.includeDocs === includeDocs && snapshot.fingerprint === tour.fingerprint;
      // fail closed on freshness
      if (!stopped && !currentSnapshot) setStale(true);
    };
    void check();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void check(); }, 5_000);
    const focus = () => { void check(); };
    window.addEventListener('focus', focus);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [tour, state, launch.agentId, launch.scope, includeTests, includeDocs, request]);

  const step = tour?.steps[current];
  const stepFeedback = step === undefined ? '' : feedback[step.id] ?? '';
  const changes = useMemo(() => step === undefined || tour === undefined ? [] : step.changeIds.map(id => tour.changes.find(change => change.id === id)).filter((change): change is ReviewChange => change !== undefined), [step, tour]);
  const feedbackTotal = Object.values(feedback).reduce((sum, value) => sum + value.length, orphanFeedback.length);
  const complete = tour !== undefined && tour.steps.every(candidate => statuses[candidate.id] === 'visited' || statuses[candidate.id] === 'skipped');

  // enforce the aggregate feedback boundary
  const updateFeedback = (stepId: string, value: string) => {
    setFeedback(currentFeedback => {
      const nextTotal = Object.entries(currentFeedback).reduce((sum, [id, note]) => sum + (id === stepId ? 0 : note.length), orphanFeedback.length) + value.length;
      return nextTotal <= maxFeedbackTotal ? { ...currentFeedback, [stepId]: value } : currentFeedback;
    });
  };

  // edit retained regeneration feedback within the aggregate cap
  const updateOrphanFeedback = (value: string) => {
    const activeTotal = Object.values(feedback).reduce((sum, note) => sum + note.length, 0);
    // always allow reductions from an over-limit retained label
    if (activeTotal + value.length <= maxFeedbackTotal || value.length < orphanFeedback.length) setOrphanFeedback(value);
  };

  // confirm the bound snapshot before completion or dispatch
  const snapshotCurrent = async (): Promise<boolean> => {
    // require a generated artifact
    if (tour === undefined) return false;
    const query = new URLSearchParams({ scope: launch.scope, includeTests: String(includeTests), includeDocs: String(includeDocs) });
    const response = await request(`/api/agents/${encodeURIComponent(launch.agentId)}/review-tour/fingerprint?${query}`);
    const body = await responseBody(response);
    const snapshot = body.snapshot;
    const currentSnapshot = response.ok && isSnapshot(snapshot) && snapshot.scope === launch.scope && snapshot.includeTests === includeTests && snapshot.includeDocs === includeDocs && snapshot.fingerprint === tour.fingerprint;
    // freeze stale or unverifiable tours
    if (!currentSnapshot) setStale(true);
    return currentSnapshot;
  };

  // move to the previous step
  const back = () => { setCurrent(index => Math.max(0, index - 1)); setState('tour'); };
  // visit and advance one step
  const next = () => {
    // require a current step
    if (step === undefined || tour === undefined) return;
    setStatuses(currentStatuses => ({ ...currentStatuses, [step.id]: 'visited', ...(tour.steps[current + 1] === undefined ? {} : { [tour.steps[current + 1]!.id]: currentStatuses[tour.steps[current + 1]!.id] ?? 'visited' }) }));
    setCurrent(index => Math.min(tour.steps.length - 1, index + 1));
  };
  // skip and advance one step
  const skip = () => {
    // require a current step
    if (step === undefined || tour === undefined) return;
    setStatuses(currentStatuses => ({ ...currentStatuses, [step.id]: 'skipped', ...(tour.steps[current + 1] === undefined ? {} : { [tour.steps[current + 1]!.id]: currentStatuses[tour.steps[current + 1]!.id] ?? 'visited' }) }));
    setCurrent(index => Math.min(tour.steps.length - 1, index + 1));
  };
  // open the editable completion summary
  const summarize = async () => {
    // block stale or incomplete reviews
    if (!complete || stale || tour === undefined || feedbackTotal > maxFeedbackTotal) return;
    // reject changed snapshots at the transition
    if (!await snapshotCurrent()) return;
    setDispatch(feedbackDraft(tour, feedback, statuses, orphanFeedback));
    setState('summary');
  };
  // dispatch one consolidated request
  const send = async () => {
    // validate the shared prompt boundary
    if (dispatching || dispatch.trim() === '' || dispatch.length > maxDispatch) return;
    setDispatching(true);
    // reject changed snapshots before mutation dispatch
    if (!await snapshotCurrent()) { setDispatching(false); setState('tour'); return; }
    const response = await request(`/api/agents/${encodeURIComponent(launch.agentId)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: dispatch, attachments: [] }) });
    setDispatching(false);
    // preserve the draft on failure
    if (!response.ok) {
      setError(response.status === 400 ? 'Shorten the change request before sending.' : 'The change request could not be sent.');
      return;
    }
    setError('');
    setSent(true);
  };
  // retain the current review after its exit transition
  const minimize = () => {
    // ignore repeated minimize requests
    if (closing) return;
    setClosing(true);
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : transitionMs;
    minimizeTimer.current = window.setTimeout(() => {
      minimizeTimer.current = undefined;
      onMinimize();
    }, delay);
  };
  // dismiss one stale durable review
  const dismiss = async () => {
    // prevent duplicate removal requests
    if (dismissing) return;
    setDismissing(true);
    setDismissError('');
    const dismissed = await onDismiss().catch(() => false);
    // preserve the review when removal fails
    if (!dismissed) { setDismissError('The cached review could not be dismissed.'); setDismissing(false); }
  };
  // contain keyboard focus inside the modal
  const dialogKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // minimize without dispatch
    if (event.key === 'Escape' && !dispatching) { minimize(); return; }
    // retain ordinary keys
    if (event.key !== 'Tab' || dialog.current === null) return;
    const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')).filter(control => control.offsetParent !== null);
    // retain focus when no controls exist
    if (controls.length === 0) { event.preventDefault(); dialog.current.focus(); return; }
    const active = document.activeElement;
    const index = controls.indexOf(active as HTMLElement);
    const next = event.shiftKey ? index <= 0 ? controls.length - 1 : index - 1 : index < 0 || index === controls.length - 1 ? 0 : index + 1;
    event.preventDefault();
    controls[next]!.focus();
  };

  const scopeLabel = launch.scope === 'working' ? 'Working' : 'All PR';
  // keep generation and freshness polling mounted while minimized
  if (minimized) return null;
  const content = <div className={`review-tour-backdrop${closing ? ' closing' : ''}`}><div ref={dialog} className="review-tour" role="dialog" aria-modal="true" aria-labelledby="review-tour-title" tabIndex={-1} onKeyDown={dialogKey}>
    <header className="review-tour-header"><div><small>{scopeLabel} guided review</small><h2 id="review-tour-title">{tour?.title ?? 'Generating change tour'}</h2>{tour && <p>{tour.overview}</p>}</div><button type="button" aria-label="Minimize guided review" title="Minimize" onClick={minimize}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg></button></header>
    <div className="review-tour-content">
    {tour && stale && <div className="review-tour-stale" role="alert"><strong>Changes updated</strong><span>This cached review is out of date.</span>{dismissError && <span>{dismissError}</span>}<button type="button" disabled={dismissing} onClick={() => void dismiss()}>{dismissing ? 'Dismissing…' : 'Dismiss'}</button><button type="button" disabled={dismissing} onClick={() => { setStale(false); setRetry(value => value + 1); setState('loading'); }}>Regenerate</button></div>}
    {state === 'loading' && <div className="review-tour-message" role="status"><span className="spinner" /><strong>Building the narrated tour…</strong><p>The AI is organizing the selected implementation changes into logical steps.</p><button type="button" onClick={() => { generation.current += 1; if (job !== undefined) void request(`/api/review-tour/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }); setState('cancelled'); }}>Cancel</button></div>}
    {state === 'empty' && <div className="review-tour-message" role="status"><strong>No included changes</strong><p>Implementation changes are empty for this scope. Enable Tests or Docs if those are the only changed files.</p></div>}
    {(state === 'error' || state === 'cancelled') && <div className="review-tour-message error" role="alert"><strong>{state === 'cancelled' ? 'Tour cancelled' : 'Unable to build tour'}</strong><p>{error || 'Generate again when you are ready.'}</p><button type="button" onClick={() => { setRetry(value => value + 1); setState('loading'); }}>Try again</button></div>}
    {tour && state === 'tour' && step && <><div className="review-tour-progress"><span>Step {current + 1} of {tour.steps.length}</span><span>{Object.values(statuses).filter(value => value === 'visited').length} visited · {Object.values(statuses).filter(value => value === 'skipped').length} skipped</span></div><main className="review-tour-step"><section className="review-tour-narration"><small>Logical change</small><h3>{step.title}</h3><p>{step.explanation}</p><label>Feedback for this change<textarea value={stepFeedback} maxLength={maxFeedback} onChange={event => updateFeedback(step.id, event.target.value)} />{stepFeedback.length >= maxFeedback && <span role="status">{maxFeedback.toLocaleString()} character limit reached</span>}</label>{orphanFeedback !== '' && <label>Feedback from regenerated steps<textarea value={orphanFeedback} maxLength={maxFeedbackTotal} onChange={event => updateOrphanFeedback(event.target.value)} />{orphanFeedback.length >= maxFeedbackTotal && <span role="status">{maxFeedbackTotal.toLocaleString()} retained feedback character limit reached</span>}</label>}</section><section className="review-tour-diffs" aria-label="Relevant changes">{changes.map(change => <article key={change.id}><header><strong>{change.originalFile === undefined ? change.file : `${change.originalFile} → ${change.file}`}</strong><small>{change.kind}</small></header><ReviewPatch patch={change.patch} /></article>)}</section></main><footer className="review-tour-actions"><button type="button" disabled={current === 0} onClick={back}>Back</button><button type="button" onClick={skip}>Skip</button><span>{feedbackTotal >= maxFeedbackTotal ? `${maxFeedbackTotal.toLocaleString()} total feedback character limit reached` : null}</span>{complete ? <button type="button" disabled={stale || feedbackTotal > maxFeedbackTotal} onClick={() => void summarize()}>Review summary</button> : <button type="button" onClick={next}>Next</button>}</footer></>}
    {tour && state === 'summary' && <main className="review-tour-summary"><h3>Review complete</h3><ul>{tour.steps.map(candidate => <li key={candidate.id}><span className={statuses[candidate.id]}>{statuses[candidate.id]}</span><strong>{candidate.title}</strong></li>)}</ul>{orphanFeedback !== '' && <p>Feedback from regenerated steps is retained in the consolidated change request.</p>}{feedbackTotal === 0 ? <p>No feedback was recorded. You can finish without sending anything.</p> : <label>Consolidated change request<textarea value={dispatch} maxLength={maxDispatch} onChange={event => setDispatch(event.target.value)} />{dispatch.length >= maxDispatch && <span role="status">{maxDispatch.toLocaleString()} character limit reached</span>}</label>}{error && <p ref={dispatchError} className="review-tour-error" role="alert" tabIndex={-1}>{error}</p>}{sent && <p className="review-tour-sent" role="status">Change request sent to the implementation agent.</p>}<footer className="review-tour-actions"><button type="button" onClick={() => setState('tour')}>Back to tour</button><span />{feedbackTotal > 0 && !sent && <button type="button" disabled={dispatching || dispatch.trim() === '' || dispatch.length > maxDispatch} onClick={() => void send()}>{dispatching ? 'Sending…' : 'Send change request'}</button>}<button type="button" onClick={minimize}>Finish</button></footer></main>}
    </div>
    <div className="review-tour-filters" role="group" aria-label="Tour content"><span>{tour?.base ? `Compared with ${tour.base}` : scopeLabel}</span><label><input type="checkbox" checked={includeTests} onChange={event => setIncludeTests(event.target.checked)} />Tests</label><label><input type="checkbox" checked={includeDocs} onChange={event => setIncludeDocs(event.target.checked)} />Docs</label></div>
  </div></div>;
  return createPortal(content, document.body);
}
