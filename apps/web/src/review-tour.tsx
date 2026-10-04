import { createPortal } from 'react-dom';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prefersReducedMotion } from './reduced-motion.js';
import { usePhoneLayout } from './panel-header.js';
import type { ReviewDiffComment, ReviewDiffSide, ReviewDiffSuggestion } from './code-panel/review-diffs.js';
import type { EditorTarget } from './code-panel/editor-jump.js';
import { codeReviewCount, codeReviewErrorMessage, failureCode, isCodeReviewJob, useCodeReviewPoll, useJobElapsed, type CodeReview, type CodeReviewCapability, type CodeReviewJob, type CodeReviewOptions, type CodeReviewOutcome, type GeneralFinding } from './code-review.js';
import { CodeReviewSheet, reviewAgentLabel, type ReviewAgentKind } from './review-start.js';

// The diff renderer pulls in `@pierre/diffs` (~177 kB), so it is loaded on demand — this dialog is in
// the eager dashboard bundle and a static import would drag the library in. Same lazy boundary the
// Code panel uses for the same reason.
const ReviewDiffs = lazy(() => import('./code-panel/review-diffs.js'));

export type ReviewScope = 'working' | 'pr';
// the Worktree and default scope the Review button asks for, before the start sheet's choices
export type ReviewTarget = { agentId: string; worktreeId: string; scope: ReviewScope };
// one tour start: the Comparison (scope, Tests, Docs), the tour's effort and the opt-in Code review
// that runs beside it; a restored tour's launch carries its stored Comparison, and Retry and
// Regenerate start again with the same launch
export type ReviewLaunch = ReviewTarget & { includeTests: boolean; includeDocs: boolean; effort?: string; codeReview?: CodeReviewOptions };
export type ReviewTourIndicator = { generating: boolean; stale: boolean };
type ReviewChange = { id: string; file: string; originalFile?: string; category: 'implementation' | 'test' | 'doc'; kind: 'hunk' | 'binary' | 'rename' | 'metadata' | 'untracked'; patch: string };
type ReviewStep = { id: string; title: string; explanation: string; changeIds: string[] };
export type ReviewTour = { title: string; overview: string; scope: ReviewScope; base: string; includeTests: boolean; includeDocs: boolean; fingerprint: string; changes: ReviewChange[]; steps: ReviewStep[] };
type ReviewRequest = (url: string, init?: RequestInit, observeReachability?: boolean) => Promise<Response>;
type StepState = 'unvisited' | 'visited' | 'skipped';
type Job = { id: string; expiresAt: string; retryAfterMs: number };
type PublicReviewComparison = { scope: ReviewScope; base: string; includeTests: boolean; includeDocs: boolean; fingerprint: string };
type ViewState = 'loading' | 'tour' | 'summary' | 'empty' | 'error' | 'cancelled';
type ReviewFailure = { code?: string; message?: string };
// How the operator triaged one Finding: an anchored one kept as the inline comment `commentId`, a
// general one kept as an editable `note`, or either dismissed. Absent means untriaged, never sent.
type FindingTriage = { state: 'kept'; commentId: string } | { state: 'noted'; note: string } | { state: 'dismissed' };
// a kept general Finding and its note
type GeneralNote = { finding: GeneralFinding; note: string };

const maxFeedback = 4_000;
const maxFeedbackTotal = 20_000;
const maxDispatch = 30_000;
const transitionMs = 240;

// replace a cached generic title until the tour is regenerated
function displayedTourTitle(tour: ReviewTour): string {
  // preserve specific generated titles
  if (tour.title.trim().toLowerCase() !== 'mobile layout') return tour.title;
  return 'Implementation walkthrough';
}

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

// validate public comparison identities
function isPublicReviewComparison(value: unknown): value is PublicReviewComparison {
  return value !== null && typeof value === 'object' && ((value as PublicReviewComparison).scope === 'working' || (value as PublicReviewComparison).scope === 'pr') && typeof (value as PublicReviewComparison).base === 'string' && typeof (value as PublicReviewComparison).includeTests === 'boolean' && typeof (value as PublicReviewComparison).includeDocs === 'boolean' && typeof (value as PublicReviewComparison).fingerprint === 'string';
}

// extract structured and transport failures
function responseFailure(body: Record<string, unknown>): ReviewFailure {
  const failure = body.error;
  // retain standard API messages
  if (typeof failure === 'string') return { message: failure };
  // reject absent or malformed envelopes
  if (failure === null || typeof failure !== 'object') return {};
  const record = failure as { code?: unknown; message?: unknown };
  return { ...(typeof record.code === 'string' ? { code: record.code } : {}), ...(typeof record.message === 'string' ? { message: record.message } : {}) };
}

// identify retryable transport failures
function transientTransportFailure(response: Response, failure: ReviewFailure): boolean {
  // preserve typed terminal failures
  if (failure.code !== undefined) return false;
  return response.status === 502 || response.status === 503 || response.status === 504 || response.status >= 520 && response.status <= 530;
}

// translate typed and transport failures; `agent` names the tour's agent
function errorMessage(failure: ReviewFailure, status: number, agent: string): string {
  const { code, message } = failure;
  // select recoverable user copy
  if (code === 'scope_unavailable') return 'The selected Git comparison is unavailable.';
  // explain stale agent targets
  if (code === 'target_unavailable') return 'The selected agent changed or closed. Reopen its changed files and try again.';
  // explain stale client contracts
  if (code === 'invalid_request') return 'The tour request was rejected. Refresh the console and try again.';
  if (code === 'conflicted_unavailable') return 'Resolve merge conflicts before generating a tour.';
  if (code === 'too_large') return 'This change is too large for a complete guided tour.';
  if (code === 'timed_out') return 'Tour generation timed out.';
  if (code === 'stale_during_generation') return 'The change moved while the tour was being generated.';
  if (code === 'capability_unavailable') return 'Guided review is unavailable on this server.';
  // explain expired generator credentials
  if (code === 'authentication_required') return `The server’s ${agent} login expired. Sign in to ${agent} on the server, then try again.`;
  if (code === 'configured_worktree_required') return 'Guided review requires a configured worktree.';
  if (code === 'generation_rejected') return 'The generated response was not an explanatory tour. Try again.';
  if (code === 'cancelled') return 'Tour generation was cancelled.';
  if (code === 'malformed_result') return 'The generated tour was incomplete. Try again.';
  // explain unclassified process failures
  if (code === 'generation_failed') return `${agent} exited before returning a guided tour. Try again; if it keeps failing, verify the server’s ${agent} login and network access.`;
  // explain expired browser sessions
  if (status === 401) return 'Your console session expired. Sign in again, then try again.';
  // explain rejected browser authority
  if (status === 403) return 'This browser is no longer authorized to build a tour. Refresh the console and try again.';
  // explain active-client conflicts
  if (status === 423 || message === 'another client is active') return 'Another browser controls this console. Take control, then try again.';
  // explain request throttling
  if (status === 429) return 'Too many tour requests were sent. Wait a moment, then try again.';
  // explain exhausted transport retries
  if (status >= 500) return 'The console connection was interrupted while building the tour. Check the connection, then try again.';
  // explain invalid success envelopes
  if (status >= 200 && status < 300) return 'The server returned an invalid guided tour. Refresh the console and try again.';
  return 'The server rejected the guided tour request. Refresh the console and try again.';
}

// read one response safely
async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json().then(value => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}).catch(() => ({}));
}

// Mirrors commentRangeLabel in review-diffs.tsx as a `file:lines` reference; kept here because that
// module is lazy-loaded with the diff library and this dialog is in the eager bundle.
function commentLocation(file: string, comment: ReviewDiffComment): string {
  if (comment.startSide !== comment.endSide) return `${file} old ${comment.startLine} – new ${comment.endLine}`;
  const lines = comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}-${comment.endLine}`;
  return `${file}:${lines} (${comment.endSide === 'deletions' ? 'old' : 'new'})`;
}

const maxQuotedLines = 8;

// The patch lines a comment covers, with their +/-/space prefixes, so the change request carries the
// code itself — a removed line is not in the working tree for the agent to look up. Walks the hunks
// counting old and new line numbers; capped, keeping the last lines (the comment sits under them).
function quotedLines(patch: string, comment: ReviewDiffComment): string[] {
  const rows: { old?: number; new?: number; text: string }[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const text of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); continue; }
    if (oldLine === 0 && newLine === 0) continue;
    if (text.startsWith('-')) rows.push({ old: oldLine++, text });
    else if (text.startsWith('+')) rows.push({ new: newLine++, text });
    else if (text.startsWith(' ')) rows.push({ old: oldLine++, new: newLine++, text });
  }
  const lineOn = (side: ReviewDiffSide, row: { old?: number; new?: number }) => side === 'deletions' ? row.old : row.new;
  const start = rows.findIndex(row => lineOn(comment.startSide, row) === comment.startLine);
  const end = rows.findIndex(row => lineOn(comment.endSide, row) === comment.endLine);
  if (start < 0 || end < start) return [];
  const covered = rows.slice(start, end + 1).map(row => row.text);
  return covered.length > maxQuotedLines ? ['…', ...covered.slice(-maxQuotedLines)] : covered;
}

// format one inline comment as a located, quoted note
function commentNote(change: ReviewChange, comment: ReviewDiffComment): string {
  const quoted = quotedLines(change.patch, comment);
  const fence = '`'.repeat(Math.max(3, ...quoted.map(line => (line.match(/`+/gu) ?? []).reduce((longest, run) => Math.max(longest, run.length + 1), 0))));
  return [`### ${commentLocation(change.file, comment)}`, ...(quoted.length === 0 ? [] : [`${fence}diff\n${quoted.join('\n')}\n${fence}`]), comment.body.trim()].join('\n');
}

// the characters of feedback recorded so far, against the shared aggregate cap
function feedbackLength(feedback: Record<string, string>, comments: ReviewDiffComment[], orphanFeedback: string, generalNotes: GeneralNote[]): number {
  return Object.values(feedback).reduce((sum, note) => sum + note.length, orphanFeedback.length) + comments.reduce((sum, comment) => sum + comment.body.length, 0) + generalNotes.reduce((sum, { note }) => sum + note.length, 0);
}

// the review's kept general Findings with their notes, in the review's order
function generalNotesOf(review: CodeReview | undefined, triage: Record<string, FindingTriage>): GeneralNote[] {
  return review?.general.flatMap(finding => {
    const entry = triage[finding.id];
    return entry?.state === 'noted' ? [{ finding, note: entry.note }] : [];
  }) ?? [];
}

// A Finding's triage. A kept Finding whose comment was deleted or closed empty is untriaged again.
function findingTriage(triage: Record<string, FindingTriage>, comments: ReviewDiffComment[], id: string): FindingTriage | undefined {
  const entry = triage[id];
  return entry?.state === 'kept' && !comments.some(comment => comment.id === entry.commentId) ? undefined : entry;
}

// "Correctness · Claude · high": the preset, agent and effort that wrote a review's Findings
function findingSource(review: CodeReview): string {
  return [review.preset.label, reviewAgentLabel(review.preset.agent), ...(review.effort === undefined ? [] : [review.effort])].join(' · ');
}

// format one consolidated change request
function feedbackDraft(tour: ReviewTour, feedback: Record<string, string>, comments: ReviewDiffComment[], statuses: Record<string, StepState>, orphanFeedback: string, generalNotes: GeneralNote[]): string {
  // kept general Findings lead, each under the file it names
  const general = generalNotes.flatMap(({ finding, note }) => note.trim() === '' ? [] : [finding.file === undefined ? note.trim() : `### ${finding.file}\n${note.trim()}`]);
  const notes = tour.steps.flatMap(step => {
    const note = feedback[step.id]?.trim();
    // a step's inline comments follow its changes in tour order, then top to bottom
    const inline = step.changeIds.flatMap(changeId => {
      const change = tour.changes.find(candidate => candidate.id === changeId);
      if (change === undefined) return [];
      return comments.filter(comment => comment.changeId === changeId && comment.body.trim() !== '').sort((a, b) => a.endLine - b.endLine).map(comment => commentNote(change, comment));
    });
    return note || inline.length > 0 ? [[`## ${step.title} (${statuses[step.id] ?? 'unvisited'})`, ...(note ? [note] : []), ...inline].join('\n\n')] : [];
  });
  return [`Please address the feedback from my guided review of ${tour.scope === 'working' ? 'Working' : 'All PR'} changes against ${tour.base}.`, `Tour: ${displayedTourTitle(tour)}`, `Comparison: ${tour.fingerprint.slice(0, 12)}`, ...(general.length === 0 ? [] : [['## General', ...general].join('\n\n')]), ...notes, ...(orphanFeedback.trim() === '' ? [] : [`## Feedback retained from regenerated steps\n${orphanFeedback.trim()}`])].join('\n\n');
}

// render and manage one guided review
// `onOpenInEditor`, given only with an `editor` configured, jumps from a diff to that line in it.
// A restored tour passes its stored Code review (`initialCodeReview`) or the job still running it
// (`initialCodeReviewJob`); `codeReviewCapability` lists the presets "Add AI review" offers, and
// `tourAgent` names the agent that narrates the tour in its failures.
export function ReviewTourDialog({ launch, request, minimized, initialTour, tourAgent, initialCodeReview, initialCodeReviewJob, codeReviewCapability, onMinimize, onDismiss, onIndicatorChange, onReady, onOpenInEditor }: { launch: ReviewLaunch; request: ReviewRequest; minimized: boolean; initialTour?: ReviewTour; tourAgent?: ReviewAgentKind; initialCodeReview?: CodeReview; initialCodeReviewJob?: CodeReviewJob; codeReviewCapability?: CodeReviewCapability; onMinimize: () => void; onDismiss: () => Promise<boolean>; onIndicatorChange: (indicator: ReviewTourIndicator) => void; onReady: (tour: ReviewTour) => void; onOpenInEditor?: (target: EditorTarget) => void }) {
  // the Comparison is fixed for the dialog's lifetime: changing it means starting again
  const { includeTests, includeDocs } = launch;
  const [state, setState] = useState<ViewState>(initialTour === undefined ? 'loading' : 'tour');
  const [tour, setTour] = useState<ReviewTour | undefined>(initialTour);
  const [job, setJob] = useState<Job>();
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(0);
  const [statuses, setStatuses] = useState<Record<string, StepState>>(initialTour === undefined ? {} : { [initialTour.steps[0]!.id]: 'visited' });
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<ReviewDiffComment[]>([]);
  const [openCommentIds, setOpenCommentIds] = useState<ReadonlySet<string>>(new Set());
  // on a phone the step's narration and feedback sit in a drawer, opened from a bar above the diff
  const phone = usePhoneLayout();
  const [notesOpen, setNotesOpen] = useState(false);
  const notesBar = useRef<HTMLButtonElement | null>(null);
  const notesDrawer = useRef<HTMLElement | null>(null);
  const [orphanFeedback, setOrphanFeedback] = useState('');
  const [dispatch, setDispatch] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [sent, setSent] = useState(false);
  const [stale, setStale] = useState(false);
  const [retry, setRetry] = useState(0);
  const [closing, setClosing] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState('');
  // The AI Code review beside the tour: the job running it, the completed review (its Findings are
  // what the diffs show), or why it failed. `codeReviewOptions` is what Retry runs again.
  const [codeReviewJob, setCodeReviewJob] = useState<CodeReviewJob | undefined>(initialCodeReviewJob);
  const [codeReview, setCodeReview] = useState<CodeReview | undefined>(initialCodeReview);
  const [codeReviewError, setCodeReviewError] = useState('');
  const [codeReviewOptions, setCodeReviewOptions] = useState<CodeReviewOptions | undefined>(launch.codeReview);
  const [addingCodeReview, setAddingCodeReview] = useState(false);
  const [retryingCodeReview, setRetryingCodeReview] = useState(false);
  const codeReviewElapsed = useJobElapsed(codeReviewJob);
  // the triage of each Finding by id, and whether the last Keep was refused at the aggregate cap
  const [triage, setTriage] = useState<Record<string, FindingTriage>>({});
  const [limitNotice, setLimitNotice] = useState(false);
  // the general note just kept, focused once it renders
  const [focusedNote, setFocusedNote] = useState<string>();
  const agentName = reviewAgentLabel(tourAgent);
  const generation = useRef(0);
  const dialog = useRef<HTMLDivElement | null>(null);
  const dispatchError = useRef<HTMLParagraphElement | null>(null);
  const minimizeTimer = useRef<number | undefined>(undefined);
  const onReadyRef = useRef(onReady);

  // retain the latest notification callback
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  // move focus into the step notes drawer as it opens
  useEffect(() => { if (phone && notesOpen) notesDrawer.current?.focus(); }, [phone, notesOpen]);

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

  // generate for the launch's fixed Comparison
  useEffect(() => {
    const restored = initialTour !== undefined && retry === 0;
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
    let transientStartFailures = 0;
    const startDeadline = Date.now() + 30_000;
    const startRequestId = crypto.randomUUID();
    const run = ++generation.current;
    let createdReviewJob: CodeReviewJob | undefined;
    let tourSettled = false;
    setState('loading');
    setError('');
    setTour(undefined);
    setJob(undefined);
    setStale(false);
    setSent(false);
    // a new start supersedes any Code review; one requested with this launch comes back with the job
    setCodeReviewJob(undefined);
    setCodeReview(undefined);
    setCodeReviewError('');
    setCodeReviewOptions(launch.codeReview);
    // poll one bounded job
    const poll = async (next: Job) => {
      // stop obsolete polls before transport
      if (closed || generation.current !== run) return;
      const response = await request(`/api/review-tour/jobs/${encodeURIComponent(next.id)}`, undefined, false);
      const body = await responseBody(response);
      const failure = responseFailure(body);
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
        const nextChangeIds = new Set(ready.changes.map(candidate => candidate.id));
        const orphaned = tour?.steps.flatMap(candidate => {
          const note = feedback[candidate.id]?.trim();
          return note !== undefined && note !== '' && !nextStepIds.has(candidate.id) ? [`${candidate.title}: ${note}`] : [];
        }) ?? [];
        // an inline comment follows its Change (ids are content digests), so only a reworked hunk detaches it
        const orphanedComments = comments.flatMap(comment => {
          const change = tour?.changes.find(candidate => candidate.id === comment.changeId);
          return !nextChangeIds.has(comment.changeId) && change !== undefined && comment.body.trim() !== '' ? [`${commentLocation(change.file, comment)}: ${comment.body.trim()}`] : [];
        });
        // preserve feedback detached by regeneration
        if (orphaned.length + orphanedComments.length > 0) setOrphanFeedback(current => [current.trim(), ...orphaned, ...orphanedComments].filter(Boolean).join('\n\n'));
        setFeedback(current => Object.fromEntries(Object.entries(current).filter(([id]) => nextStepIds.has(id))));
        setComments(current => current.filter(comment => nextChangeIds.has(comment.changeId)));
        setTour(ready);
        setStatuses({ [ready.steps[0]!.id]: 'visited' });
        setCurrent(0);
        setState('tour');
        tourSettled = true;
        onReadyRef.current(ready);
        return;
      }
      // publish an empty selection
      if (response.ok && body.status === 'empty') { setState('empty'); return; }
      // retry transient polls for the job lifetime
      if (transientTransportFailure(response, failure) && Date.now() < Date.parse(next.expiresAt)) {
        timer = window.setTimeout(() => void poll(next), Math.max(250, Math.min(5_000, next.retryAfterMs)));
        return;
      }
      setError(errorMessage(failure, response.status, agentName));
      setState(response.status === 410 ? 'cancelled' : 'error');
    };
    // create one generation job
    const start = async () => {
      // stop obsolete retries before transport
      if (closed || generation.current !== run) return;
      const response = await request(`/api/agents/${encodeURIComponent(launch.agentId)}/review-tour/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': startRequestId }, body: JSON.stringify({ scope: launch.scope, includeTests, includeDocs, ...(launch.effort === undefined ? {} : { effort: launch.effort }), ...(launch.codeReview === undefined ? {} : { codeReview: launch.codeReview }) }) }, false);
      const body = await responseBody(response);
      const pending = body.job;
      const reviewJob = body.codeReview !== null && typeof body.codeReview === 'object' ? (body.codeReview as { job?: unknown }).job : undefined;
      const failure = responseFailure(body);
      // reap jobs created after local closure
      if (closed || generation.current !== run) {
        if (response.status === 202 && body.status === 'pending' && isJob(pending)) void request(`/api/review-tour/jobs/${encodeURIComponent(pending.id)}`, { method: 'DELETE' }, false);
        if (response.status === 202 && isCodeReviewJob(reviewJob)) void request(`/api/code-review/jobs/${encodeURIComponent(reviewJob.id)}`, { method: 'DELETE' }, false);
        return;
      }
      // publish an empty selection
      if (response.ok && body.status === 'empty') { setState('empty'); return; }
      // require a bounded job descriptor
      if (response.status === 202 && body.status === 'pending' && isJob(pending)) {
        createdJob = pending;
        setJob(pending);
        // follow the Code review that started from the same Comparison
        if (isCodeReviewJob(reviewJob)) { createdReviewJob = reviewJob; setCodeReviewJob(reviewJob); }
        await poll(pending);
        return;
      }
      // retry transient starts within one bounded window
      if (transientTransportFailure(response, failure) && Date.now() < startDeadline) {
        transientStartFailures += 1;
        const retryDelay = Math.min(5_000, 500 * 2 ** Math.min(transientStartFailures - 1, 4));
        timer = window.setTimeout(() => void start(), retryDelay);
        return;
      }
      setError(errorMessage(failure, response.status, agentName));
      setState('error');
    };
    void start();
    // cancel obsolete generation jobs, and a Code review whose tour never arrived
    return () => {
      closed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (createdJob !== undefined) void request(`/api/review-tour/jobs/${encodeURIComponent(createdJob.id)}`, { method: 'DELETE' }, false);
      if (createdReviewJob !== undefined && !tourSettled) void request(`/api/code-review/jobs/${encodeURIComponent(createdReviewJob.id)}`, { method: 'DELETE' }, false);
    };
  }, [launch, includeTests, includeDocs, retry, request, initialTour]);

  // poll comparison freshness while reviewing
  useEffect(() => {
    // wait for a usable tour
    if (tour === undefined || state === 'loading') return;
    let stopped = false;
    const check = async () => {
      const query = new URLSearchParams({ scope: launch.scope, includeTests: String(includeTests), includeDocs: String(includeDocs) });
      const response = await request(`/api/agents/${encodeURIComponent(launch.agentId)}/review-tour/fingerprint?${query}`, undefined, false);
      const body = await responseBody(response);
      const comparison = body.comparison;
      const currentComparison = response.ok && isPublicReviewComparison(comparison) && comparison.scope === launch.scope && comparison.includeTests === includeTests && comparison.includeDocs === includeDocs && comparison.fingerprint === tour.fingerprint;
      // fail closed on freshness
      if (!stopped && !currentComparison) setStale(true);
    };
    void check();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void check(); }, 5_000);
    const focus = () => { void check(); };
    window.addEventListener('focus', focus);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [tour, state, launch.agentId, launch.scope, includeTests, includeDocs, request]);

  // settle the running Code review into its Findings or its failure
  const codeReviewSettled = useCallback((outcome: CodeReviewOutcome) => {
    setCodeReviewJob(undefined);
    if ('review' in outcome) { setCodeReview(outcome.review); setCodeReviewError(''); }
    else if ('error' in outcome) setCodeReviewError(outcome.error);
  }, []);
  useCodeReviewPoll(request, codeReviewJob, codeReviewSettled);

  // a replacing Code review keeps the triage of the Findings it still holds
  useEffect(() => {
    if (codeReview === undefined) return;
    const ids = new Set([...codeReview.findings, ...codeReview.general].map(finding => finding.id));
    setTriage(current => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
  }, [codeReview]);

  // cancel a running Code review with the tour it belongs to
  const cancelCodeReview = () => {
    if (codeReviewJob !== undefined) void request(`/api/code-review/jobs/${encodeURIComponent(codeReviewJob.id)}`, { method: 'DELETE' }, false);
    setCodeReviewJob(undefined);
  };

  // Start a Code review of the ready tour's Comparison ("Add AI review" or Retry). Resolves to the
  // reason it did not start; a Comparison that moved since the tour marks the tour stale.
  const startCodeReview = async (options: CodeReviewOptions): Promise<string | undefined> => {
    // require a current tour to anchor the Findings on
    if (tour === undefined) return 'The tour is not ready.';
    const response = await request(`/api/agents/${encodeURIComponent(launch.agentId)}/code-review/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: launch.scope, includeTests, includeDocs, fingerprint: tour.fingerprint, ...options }) }, false);
    const body = await responseBody(response);
    // follow the started job
    if (response.status === 202 && isCodeReviewJob(body.job)) {
      setCodeReviewOptions(options);
      setCodeReview(undefined);
      setCodeReviewError('');
      setCodeReviewJob(body.job);
      return undefined;
    }
    const code = failureCode(body);
    if (code === 'stale_during_generation') setStale(true);
    return codeReviewErrorMessage(code, response.status);
  };
  // run a failed Code review again with its options, or choose them again when they are unknown
  const retryCodeReview = async () => {
    if (codeReviewOptions === undefined) { setAddingCodeReview(true); return; }
    setRetryingCodeReview(true);
    const failure = await startCodeReview(codeReviewOptions);
    setRetryingCodeReview(false);
    if (failure !== undefined) setCodeReviewError(failure);
  };
  // close the Add AI review sheet, returning focus to the review
  const closeCodeReviewSheet = () => { setAddingCodeReview(false); dialog.current?.focus(); };

  const step = tour?.steps[current];
  const stepFeedback = step === undefined ? '' : feedback[step.id] ?? '';
  const changes = useMemo(() => step === undefined || tour === undefined ? [] : step.changeIds.map(id => tour.changes.find(change => change.id === id)).filter((change): change is ReviewChange => change !== undefined), [step, tour]);
  const generalNotes = generalNotesOf(codeReview, triage);
  const feedbackTotal = feedbackLength(feedback, comments, orphanFeedback, generalNotes);
  const complete = tour !== undefined && tour.steps.every(candidate => statuses[candidate.id] === 'visited' || statuses[candidate.id] === 'skipped');
  // the step's Findings that are not kept, as suggested comments in its diffs
  const suggestions = useMemo((): ReviewDiffSuggestion[] => {
    if (codeReview === undefined || step === undefined) return [];
    const source = findingSource(codeReview);
    return codeReview.findings.flatMap(finding => {
      const state = findingTriage(triage, comments, finding.id)?.state;
      return step.changeIds.includes(finding.changeId) && state !== 'kept' ? [{ id: finding.id, changeId: finding.changeId, side: finding.side, startLine: finding.startLine, endLine: finding.endLine, severity: finding.severity, title: finding.title, body: finding.body, source, dismissed: state === 'dismissed' }] : [];
    });
  }, [codeReview, step, triage, comments]);

  // a refused Keep's limit notice lasts until the feedback total moves
  useEffect(() => setLimitNotice(false), [feedbackTotal]);
  // move focus into a newly kept general note
  useEffect(() => {
    if (focusedNote === undefined) return;
    dialog.current?.querySelector<HTMLTextAreaElement>(`textarea[data-note="${CSS.escape(focusedNote)}"]`)?.focus();
    setFocusedNote(undefined);
  }, [focusedNote]);
  // the untriaged Findings each step holds: its Changes' anchored Findings, plus the general ones on
  // the first step, where they are listed
  const untriagedGeneral = codeReview?.general.filter(finding => findingTriage(triage, comments, finding.id) === undefined).length ?? 0;
  const untriagedByStep = useMemo(() => new Map(tour?.steps.map((candidate, index) => [candidate.id, (codeReview?.findings.filter(finding => candidate.changeIds.includes(finding.changeId) && findingTriage(triage, comments, finding.id) === undefined).length ?? 0) + (index === 0 ? untriagedGeneral : 0)]) ?? []), [tour, codeReview, triage, comments, untriagedGeneral]);
  const stepUntriaged = step === undefined ? 0 : untriagedByStep.get(step.id) ?? 0;
  const untriagedTotal = [...untriagedByStep.values()].reduce((sum, count) => sum + count, 0);

  // enforce the aggregate feedback boundary
  const updateFeedback = (stepId: string, value: string) => {
    const nextFeedback = { ...feedback, [stepId]: value };
    if (feedbackLength(nextFeedback, comments, orphanFeedback, generalNotes) <= maxFeedbackTotal) setFeedback(nextFeedback);
  };

  // edit retained regeneration feedback within the aggregate cap
  const updateOrphanFeedback = (value: string) => {
    // always allow reductions from an over-limit retained label
    if (feedbackLength(feedback, comments, value, generalNotes) <= maxFeedbackTotal || value.length < orphanFeedback.length) setOrphanFeedback(value);
  };

  // add, edit, and remove inline comments, holding edits to the aggregate cap
  const addComment = useCallback((comment: ReviewDiffComment) => {
    setComments(current => [...current, comment]);
    setOpenCommentIds(current => new Set(current).add(comment.id));
  }, []);
  const openComment = (id: string) => setOpenCommentIds(current => new Set(current).add(id));
  // close a comment's editor, discarding the comment if it was left empty
  const closeComment = (id: string) => {
    setOpenCommentIds(current => { const next = new Set(current); next.delete(id); return next; });
    setComments(current => current.filter(comment => comment.id !== id || comment.body.trim() !== ''));
  };
  const updateComment = (id: string, body: string) => {
    const nextComments = comments.map(comment => comment.id === id ? { ...comment, body } : comment);
    if (feedbackLength(feedback, nextComments, orphanFeedback, generalNotes) <= maxFeedbackTotal) setComments(nextComments);
  };
  const deleteComment = (id: string) => {
    setOpenCommentIds(current => { const next = new Set(current); next.delete(id); return next; });
    setComments(current => current.filter(comment => comment.id !== id));
  };
  // Keep a Finding: an ordinary inline comment on its lines, pre-filled with its title and body and
  // open for rewording. Refused, with the limit notice, when it would pass the aggregate cap.
  const keepFinding = (id: string) => {
    const finding = codeReview?.findings.find(candidate => candidate.id === id);
    if (finding === undefined) return;
    const comment: ReviewDiffComment = { id: crypto.randomUUID(), changeId: finding.changeId, startSide: finding.side, startLine: finding.startLine, endSide: finding.side, endLine: finding.endLine, body: [finding.title.trim(), finding.body.trim()].filter(Boolean).join('\n\n').slice(0, maxFeedback) };
    const nextComments = [...comments, comment];
    if (feedbackLength(feedback, nextComments, orphanFeedback, generalNotes) > maxFeedbackTotal) { setLimitNotice(true); return; }
    setComments(nextComments);
    setOpenCommentIds(current => new Set(current).add(comment.id));
    setTriage(current => ({ ...current, [id]: { state: 'kept', commentId: comment.id } }));
  };
  // Apply a triage change. On the summary the change request is rebuilt, since general notes are part
  // of it.
  const retriage = (nextTriage: Record<string, FindingTriage>) => {
    setTriage(nextTriage);
    if (state === 'summary' && tour !== undefined) setDispatch(feedbackDraft(tour, feedback, comments, statuses, orphanFeedback, generalNotesOf(codeReview, nextTriage)));
  };
  // dismiss a Finding to a one-line row, or restore it to untriaged
  const dismissFinding = (id: string) => retriage({ ...triage, [id]: { state: 'dismissed' } });
  const restoreFinding = (id: string) => retriage(Object.fromEntries(Object.entries(triage).filter(([candidate]) => candidate !== id)));
  // Keep a general Finding as an editable note pre-filled with its title and body, within the cap.
  const keepGeneralFinding = (id: string) => {
    const finding = codeReview?.general.find(candidate => candidate.id === id);
    if (finding === undefined) return;
    const nextTriage: Record<string, FindingTriage> = { ...triage, [id]: { state: 'noted', note: [finding.title.trim(), finding.body.trim()].filter(Boolean).join('\n\n').slice(0, maxFeedback) } };
    if (feedbackLength(feedback, comments, orphanFeedback, generalNotesOf(codeReview, nextTriage)) > maxFeedbackTotal) { setLimitNotice(true); return; }
    retriage(nextTriage);
    setFocusedNote(id);
  };
  // edit a general note within the aggregate cap, always allowing it to shrink
  const updateGeneralNote = (id: string, note: string) => {
    const previous = triage[id];
    const nextTriage: Record<string, FindingTriage> = { ...triage, [id]: { state: 'noted', note } };
    if (feedbackLength(feedback, comments, orphanFeedback, generalNotesOf(codeReview, nextTriage)) <= maxFeedbackTotal || (previous?.state === 'noted' && note.length < previous.note.length)) retriage(nextTriage);
  };
  // close the step notes drawer, handing focus back to the bar that opened it
  const closeNotes = () => { setNotesOpen(false); notesBar.current?.focus(); };

  // confirm the bound comparison before completion or dispatch
  const comparisonCurrent = async (): Promise<boolean> => {
    // require a generated artifact
    if (tour === undefined) return false;
    const query = new URLSearchParams({ scope: launch.scope, includeTests: String(includeTests), includeDocs: String(includeDocs) });
    const response = await request(`/api/agents/${encodeURIComponent(launch.agentId)}/review-tour/fingerprint?${query}`, undefined, false);
    const body = await responseBody(response);
    const comparison = body.comparison;
    const currentComparison = response.ok && isPublicReviewComparison(comparison) && comparison.scope === launch.scope && comparison.includeTests === includeTests && comparison.includeDocs === includeDocs && comparison.fingerprint === tour.fingerprint;
    // freeze stale or unverifiable tours
    if (!currentComparison) setStale(true);
    return currentComparison;
  };

  // Jump from the summary to the first step holding an untriaged Finding. When that is only the
  // general Findings, a phone opens the notes drawer they are listed in.
  const reviewUntriaged = () => {
    const index = tour?.steps.findIndex(candidate => (untriagedByStep.get(candidate.id) ?? 0) > 0) ?? -1;
    if (tour === undefined || index < 0) return;
    setCurrent(index);
    setState('tour');
    if (phone && index === 0 && (untriagedByStep.get(tour.steps[0]!.id) ?? 0) === untriagedGeneral) setNotesOpen(true);
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
    // reject changed Comparisons at the transition
    if (!await comparisonCurrent()) return;
    setDispatch(feedbackDraft(tour, feedback, comments, statuses, orphanFeedback, generalNotes));
    setState('summary');
  };
  // dispatch one consolidated request
  const send = async () => {
    // validate the shared prompt boundary
    if (dispatching || dispatch.trim() === '' || dispatch.length > maxDispatch) return;
    setDispatching(true);
    // reject changed Comparisons before mutation dispatch
    if (!await comparisonCurrent()) { setDispatching(false); setState('tour'); return; }
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
    const delay = prefersReducedMotion() ? 0 : transitionMs;
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
    cancelCodeReview();
    const dismissed = await onDismiss().catch(() => false);
    // preserve the review when removal fails
    if (!dismissed) { setDismissError('The cached review could not be dismissed.'); setDismissing(false); }
  };
  // contain keyboard focus inside the modal
  const dialogKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Escape dismisses the topmost thing: the phone notes drawer, then the step's open comment
    // editors (an empty one is discarded), and only then the review itself
    if (event.key === 'Escape' && !dispatching) {
      if (state === 'tour' && phone && notesOpen) { closeNotes(); return; }
      const stepChangeIds = new Set(step?.changeIds);
      const openInStep = state === 'tour' ? comments.filter(comment => openCommentIds.has(comment.id) && stepChangeIds.has(comment.changeId)) : [];
      if (openInStep.length > 0) {
        for (const comment of openInStep) closeComment(comment.id);
        // the focused editor unmounts; keep keyboard focus in the dialog
        dialog.current?.focus();
        return;
      }
      minimize();
      return;
    }
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
  // the launch's Comparison, read-only: changing it means starting again from the Review button
  const comparisonLabel = [scopeLabel, includeTests ? 'tests included' : 'tests excluded', includeDocs ? 'docs included' : 'docs excluded', ...(tour?.base ? [`vs ${tour.base}`] : [])].join(' · ');
  // The general Findings, on the first step and the summary: an untriaged one offers Keep and Dismiss,
  // a kept one is an editable note, and a dismissed one a row that restores it.
  const generalFindings = codeReview !== undefined && codeReview.general.length > 0 && <section className="review-tour-general" aria-label="General findings"><small>General findings</small>{codeReview.general.map(finding => {
    const entry = triage[finding.id];
    if (entry?.state === 'dismissed') return <div key={finding.id} className="review-tour-suggestion dismissed" role="group" aria-label={`Dismissed suggestion: ${finding.title}`}><span>Dismissed · {finding.title}</span><button type="button" onClick={() => restoreFinding(finding.id)}>Restore</button></div>;
    if (entry?.state === 'noted') return <div key={finding.id} className="review-tour-general-note"><label>General note{finding.file === undefined ? '' : ` · ${finding.file}`}<textarea data-note={finding.id} aria-label={`General note: ${finding.title}`} value={entry.note} maxLength={maxFeedback} onChange={event => updateGeneralNote(finding.id, event.target.value)} /></label><div><button type="button" onClick={() => restoreFinding(finding.id)}>Remove</button></div></div>;
    return <div key={finding.id} className="review-tour-suggestion" role="group" aria-label={`Suggested comment: ${finding.title}`}><div className="review-tour-suggestion-title"><span className={`review-tour-severity ${finding.severity}`}>{finding.severity}</span><strong>{finding.title}</strong></div>{finding.body.trim() !== '' && <p>{finding.body}</p>}<small>{[...(finding.file === undefined ? [] : [finding.file]), findingSource(codeReview)].join(' · ')}</small><div><button type="button" onClick={() => dismissFinding(finding.id)}>Dismiss</button><button type="button" onClick={() => keepGeneralFinding(finding.id)}>Keep</button></div></div>;
  })}</section>;
  // the step's narration and feedback: a left column on desktop, the notes drawer on a phone; the
  // first step leads with the general Findings
  const narration = step && <>{current === 0 && generalFindings}<small>Logical change</small><h3>{step.title}</h3><p>{step.explanation}</p><label>Feedback for this change<textarea value={stepFeedback} maxLength={maxFeedback} onChange={event => updateFeedback(step.id, event.target.value)} />{stepFeedback.length >= maxFeedback && <span role="status">{maxFeedback.toLocaleString()} character limit reached</span>}</label>{orphanFeedback !== '' && <label>Feedback from regenerated steps<textarea value={orphanFeedback} maxLength={maxFeedbackTotal} onChange={event => updateOrphanFeedback(event.target.value)} />{orphanFeedback.length >= maxFeedbackTotal && <span role="status">{maxFeedbackTotal.toLocaleString()} retained feedback character limit reached</span>}</label>}</>;
  // The Code review's state in the header: running with its time, its Findings count, a failure with
  // Retry, or "Add AI review" for a current tour with none.
  const codeReviewChip = codeReviewJob !== undefined
    ? <span className="review-tour-ai running" role="status"><span className="spinner" aria-hidden="true" />AI review running · {codeReviewElapsed}</span>
    : codeReview !== undefined
      ? <span className="review-tour-ai ready" role="status" title={`${codeReview.preset.label} review by ${reviewAgentLabel(codeReview.preset.agent)}`}>AI review · {codeReviewCount(codeReview)}</span>
      : codeReviewError !== ''
        ? <span className="review-tour-ai failed" role="alert"><span title={codeReviewError}>AI review failed</span><span className="review-tour-ai-reason">{codeReviewError}</span><button type="button" disabled={retryingCodeReview || stale || tour === undefined} onClick={() => void retryCodeReview()}>Retry</button></span>
        : tour !== undefined && !stale && (state === 'tour' || state === 'summary') && codeReviewCapability !== undefined
          ? <span className="review-tour-ai add"><button type="button" onClick={() => setAddingCodeReview(true)}>Add AI review</button></span>
          : null;
  const codeReviewSheet = addingCodeReview && codeReviewCapability !== undefined ? <CodeReviewSheet codeReview={codeReviewCapability} onStart={async options => { const failure = await startCodeReview(options); if (failure === undefined) closeCodeReviewSheet(); return failure; }} onCancel={closeCodeReviewSheet} /> : null;
  // keep generation and freshness polling mounted while minimized
  if (minimized) return null;
  const content = <div className={`review-tour-backdrop${closing ? ' closing' : ''}`}><div ref={dialog} className="review-tour" role="dialog" aria-modal="true" aria-labelledby="review-tour-title" tabIndex={-1} onKeyDown={dialogKey}>
    <header className="review-tour-header"><div><small>{scopeLabel} guided review</small><h2 id="review-tour-title">{tour ? displayedTourTitle(tour) : 'Generating change tour'}</h2>{tour && <p>{tour.overview}</p>}</div>{codeReviewChip}<button type="button" aria-label="Minimize guided review" title="Minimize" onClick={minimize}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg></button></header>
    <div className="review-tour-content">
    {tour && stale && <div className="review-tour-stale" role="alert"><strong>Changes updated</strong><span>This cached review is out of date.</span>{dismissError && <span>{dismissError}</span>}<button type="button" disabled={dismissing} onClick={() => void dismiss()}>{dismissing ? 'Dismissing…' : 'Dismiss'}</button><button type="button" disabled={dismissing} onClick={() => { setStale(false); setRetry(value => value + 1); setState('loading'); }}>Regenerate</button></div>}
    {state === 'loading' && <div className="review-tour-message" role="status"><span className="spinner" /><strong>Building the narrated tour…</strong><p>The AI is organizing the selected implementation changes into logical steps.</p><button type="button" onClick={() => { generation.current += 1; if (job !== undefined) void request(`/api/review-tour/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }, false); cancelCodeReview(); setState('cancelled'); }}>Cancel</button></div>}
    {state === 'empty' && <div className="review-tour-message" role="status"><strong>No included changes</strong><p>Implementation changes are empty for this scope. Start again with Tests or Docs included if those are the only changed files.</p></div>}
    {(state === 'error' || state === 'cancelled') && <div className="review-tour-message error" role="alert"><strong>{state === 'cancelled' ? 'Tour cancelled' : 'Unable to build tour'}</strong><p>{error || 'Generate again when you are ready.'}</p><button type="button" onClick={() => { setRetry(value => value + 1); setState('loading'); }}>Try again</button></div>}
    {tour && state === 'tour' && step && <><div className="review-tour-progress"><span>Step {current + 1} of {tour.steps.length}{stepUntriaged > 0 && <span className="review-tour-finding-count" title="AI review findings not yet kept or dismissed">{stepUntriaged} {stepUntriaged === 1 ? 'finding' : 'findings'}</span>}</span><span>{Object.values(statuses).filter(value => value === 'visited').length} visited · {Object.values(statuses).filter(value => value === 'skipped').length} skipped</span></div><main className="review-tour-step">{phone
      ? <><button ref={notesBar} type="button" className="review-tour-notes-bar" aria-label="Show step notes" aria-expanded={notesOpen} onClick={() => setNotesOpen(true)}><span><strong>{step.title}</strong><span>{step.explanation}</span></span>{current === 0 && untriagedGeneral > 0 ? <small className="has-feedback">{untriagedGeneral} general</small> : <small className={stepFeedback.trim() === '' ? undefined : 'has-feedback'}>{stepFeedback.trim() === '' ? 'Notes' : 'Feedback'}</small>}</button>
        {notesOpen && <><button type="button" className="review-tour-notes-backdrop" aria-label="Close step notes" onClick={closeNotes} /><section ref={notesDrawer} className="review-tour-narration review-tour-notes-drawer" role="dialog" aria-label="Step notes" tabIndex={-1}><div className="review-tour-notes-head"><span>Step notes</span><button type="button" aria-label="Close step notes" title="Close" onClick={closeNotes}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>{narration}</section></>}</>
      : <section className="review-tour-narration">{narration}</section>}<section className="review-tour-diffs" aria-label="Relevant changes"><Suspense fallback={<p className="review-tour-diff-loading" role="status">Loading diff…</p>}><ReviewDiffs changes={changes} comments={comments} openCommentIds={openCommentIds} onCommentAdd={addComment} onCommentChange={updateComment} onCommentOpen={openComment} onCommentClose={closeComment} onCommentDelete={deleteComment} suggestions={suggestions} onSuggestionKeep={keepFinding} onSuggestionDismiss={dismissFinding} onSuggestionRestore={restoreFinding} {...(onOpenInEditor === undefined ? {} : { onOpenInEditor })} /></Suspense></section></main><footer className="review-tour-actions"><button type="button" disabled={current === 0} onClick={back}>Back</button><button type="button" onClick={skip}>Skip</button><span>{feedbackTotal >= maxFeedbackTotal || limitNotice ? `${maxFeedbackTotal.toLocaleString()} total feedback character limit reached` : null}</span>{complete ? <button type="button" disabled={stale || feedbackTotal > maxFeedbackTotal} onClick={() => void summarize()}>Review summary</button> : <button type="button" onClick={next}>Next</button>}</footer></>}
    {tour && state === 'summary' && <main className="review-tour-summary"><h3>Review complete</h3><ul>{tour.steps.map(candidate => <li key={candidate.id}><span className={statuses[candidate.id]}>{statuses[candidate.id]}</span><strong>{candidate.title}</strong>{(untriagedByStep.get(candidate.id) ?? 0) > 0 && <small className="review-tour-finding-count" title="AI review findings not yet kept or dismissed">{untriagedByStep.get(candidate.id)}</small>}</li>)}</ul>{untriagedTotal > 0 && <div className="review-tour-untriaged" role="status"><span><strong>{untriagedTotal} {untriagedTotal === 1 ? 'finding' : 'findings'} not reviewed</strong> Untriaged findings are not sent.</span><button type="button" onClick={reviewUntriaged}>Review findings</button></div>}{generalFindings}{orphanFeedback !== '' && <p>Feedback from regenerated steps is retained in the consolidated change request.</p>}{feedbackTotal === 0 ? <p>No feedback was recorded. You can finish without sending anything.</p> : <label>Consolidated change request<textarea value={dispatch} maxLength={maxDispatch} onChange={event => setDispatch(event.target.value)} />{dispatch.length >= maxDispatch && <span role="status">{maxDispatch.toLocaleString()} character limit reached</span>}</label>}{error && <p ref={dispatchError} className="review-tour-error" role="alert" tabIndex={-1}>{error}</p>}{sent && <p className="review-tour-sent" role="status">Change request sent to the implementation agent.</p>}<footer className="review-tour-actions"><button type="button" onClick={() => setState('tour')}>Back to tour</button><span>{limitNotice ? `${maxFeedbackTotal.toLocaleString()} total feedback character limit reached` : null}</span>{feedbackTotal > 0 && !sent && <button type="button" disabled={dispatching || dispatch.trim() === '' || dispatch.length > maxDispatch} onClick={() => void send()}>{dispatching ? 'Sending…' : 'Send change request'}</button>}<button type="button" onClick={minimize}>Finish</button></footer></main>}
    </div>
    <p className="review-tour-comparison">{comparisonLabel}</p>
    {codeReviewSheet}
  </div></div>;
  return createPortal(content, document.body);
}
