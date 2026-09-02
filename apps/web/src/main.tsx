import { Component, createContext, type Dispatch, type ReactNode, type SetStateAction, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { BoundedTextCache, nextLiveSnapshot } from './client-cache.js';
import { createAnimationFrameTextBatcher, pollWhileVisible } from './client-scheduling.js';
import { createOutputLinkOverlays, outputUrlMatchesHost } from './output-links.js';
import { containOutputScroll } from './output-scroll.js';
import { preserveOutputLongPressSelection } from './output-touch.js';
import { FlyoutPortal } from './flyout-portal.js';
import { NoteMarkdown } from './note-markdown.js';
import { ProjectOpen } from './project-open.js';
import { PullRequestCard, PullRequestIndicators, PullRequestStatusIcon, type PullRequestSummary } from './pull-request-card.js';
import { isStackOperationLog, type StackAction, type StackOperationLog } from './stack-operations.js';
import { SyntaxHighlightedCode } from './syntax-highlight.js';
import { isPromptKeyboardTarget, useShiftArrowTabCycling } from './tab-navigation.js';
import { UpstreamRebaseBanner, type GitUpstreamSummary } from './upstream-rebase.js';
import { useViewportFlyout } from './viewport-flyout.js';
import { isReviewTour, ReviewTourDialog, type ReviewLaunch, type ReviewScope, type ReviewTour, type ReviewTourIndicator } from './review-tour.js';
import { VoiceDialog, type VoiceWorktree } from './voice/voice-dialog.js';
import './styles.css';

// the fields the web reads off the server's inline-question payload; the server
// also carries targetPaneId for its own keystroke targeting, which the web ignores
type InlineQuestion = { id: string; text: string; choices: string[]; source: 'structured' | 'parsed' };
type Stack = { actions: StackAction[]; running?: boolean; transition?: 'starting'|'migrating'; operation?: StackAction; tunnel?: boolean };
type PullRequestChoice = { number: number; title: string; branch: string; draft: boolean; url: string } & Pick<PullRequestSummary, 'checks' | 'issues'>;
type PullRequestWorktree = { worktreeId: string; worktreeName: string; agentId?: string };
type SwitchablePullRequest = PullRequestChoice & { checkedOut: boolean; openIn?: PullRequestWorktree };
type PullRequestSwitchAvailability = { enabled: boolean; pullRequests: SwitchablePullRequest[]; otherPullRequests: SwitchablePullRequest[] };
type DashboardTarget = { worktreeId: string; agentId?: string };
type PromptAction = { label: string; prompt: string };
type GitStatusChange = { code: string; path: string; originalPath?: string; additions?: number; deletions?: number; category?: 'implementation'|'test'|'doc' };
type GitStatusSummary = { files: number; staged: number; unstaged: number; untracked: number; conflicted: number; changes?: GitStatusChange[] };
type GitComparisonSummary = { base: string; files: number; changes?: GitStatusChange[] };
type NewTaskAvailability = { enabled: boolean; reason?: string };
type OperationFeedback = { id: number; tone: 'pending'|'success'|'error'; message: string; detail: string; worktreeId?: string };
type CleanupTarget = { id: string; kind: 'orphan-worker'|'stale-agent'|'hud-pane'|'hud-process'; label: string; detail: string };
type AgentKind = 'codex' | 'claude' | 'pi' | 'opencode';
type AttentionState = 'working' | 'finished' | 'question';
type Agent = { id: string; sessionId: string; workspace: string; branch?: string; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; gitUpstream?: GitUpstreamSummary; title: string; kind?: AgentKind; attention?: AttentionState; sandboxed?: boolean; conversationId?: string; displayLabel?: string; worktreeId?: string; worktreeLabel?: string; worktreeOrder?: number; newTaskConfigured?: boolean; push?: PromptAction; projectUrl?: string; pullRequest?: PullRequestSummary; question?: InlineQuestion; stack?: Stack; unread?: boolean; queuedPromptCount: number };
type Worktree = { id: string; label: string; path: string; branch?: string; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; gitUpstream?: GitUpstreamSummary; available: boolean; pinned: boolean; sleeping?: boolean; order: number; projectUrl?: string; pullRequest?: PullRequestSummary; stack?: Stack };
type ReviewTourCapability = { available: true } | { available: false; reason: 'generator_unavailable'|'unsupported_cli'|'configuration_invalid'|'authentication_required' };
type StoredReviewSummary = { worktreeId: string; branch: string; savedAt: string; title: string; scope: ReviewScope; includeTests: boolean; includeDocs: boolean; fingerprint: string };
type ReviewButtonState = ReviewTourIndicator & { onOpen: () => void };
type Dashboard = { generation?: number; serverStartedAt?: number; agents: Agent[]; worktrees: Worktree[]; cleanupPending?: number; reviewTour?: ReviewTourCapability; reviews?: StoredReviewSummary[] };
// validate durable review dashboard summaries
const isStoredReviewSummary = (value: unknown): value is StoredReviewSummary => value !== null && typeof value === 'object'
  && typeof (value as StoredReviewSummary).worktreeId === 'string'
  && typeof (value as StoredReviewSummary).branch === 'string'
  && typeof (value as StoredReviewSummary).savedAt === 'string'
  && typeof (value as StoredReviewSummary).title === 'string'
  && ((value as StoredReviewSummary).scope === 'working' || (value as StoredReviewSummary).scope === 'pr')
  && typeof (value as StoredReviewSummary).includeTests === 'boolean'
  && typeof (value as StoredReviewSummary).includeDocs === 'boolean'
  && typeof (value as StoredReviewSummary).fingerprint === 'string';
const isDashboard = (value: unknown): value is Dashboard => {
  if (value === null || typeof value !== 'object') return false;
  const dashboard = value as { serverStartedAt?: unknown; agents?: unknown; worktrees?: unknown; cleanupPending?: unknown; reviews?: unknown };
  return (dashboard.serverStartedAt === undefined || typeof dashboard.serverStartedAt === 'number' && Number.isSafeInteger(dashboard.serverStartedAt) && dashboard.serverStartedAt >= 0)
    && Array.isArray(dashboard.agents)
    && Array.isArray(dashboard.worktrees)
    && (dashboard.cleanupPending === undefined || Number.isInteger(dashboard.cleanupPending) && (dashboard.cleanupPending as number) >= 0)
    && (dashboard.reviews === undefined || Array.isArray(dashboard.reviews) && dashboard.reviews.every(isStoredReviewSummary));
};
const isDashboardFrame = (value: unknown): value is { v: 1; type: 'dashboard'; dashboard: Dashboard } => value !== null && typeof value === 'object' && (value as { v?: unknown }).v === 1 && (value as { type?: unknown }).type === 'dashboard' && isDashboard((value as { dashboard?: unknown }).dashboard);
const isCleanupTarget = (value: unknown): value is CleanupTarget => value !== null && typeof value === 'object'
  && typeof (value as CleanupTarget).id === 'string'
  && ['orphan-worker', 'stale-agent', 'hud-pane', 'hud-process'].includes((value as CleanupTarget).kind)
  && typeof (value as CleanupTarget).label === 'string'
  && typeof (value as CleanupTarget).detail === 'string';
type AgentState = 'working' | 'prompt-done' | 'action-required' | 'closed' | 'sleeping';
type DashboardOperation = 'launching'|'restarting'|'clearing'|'deactivating'|'sleeping'|'waking'|'new-task';
type DashboardItem = { key: string; label: string; state: AgentState; order: number; unread: boolean; operation?: DashboardOperation; agent?: Agent; worktree?: Worktree };
// describe one tab-bar update action
type UpdateControl = { label: string; action: string; onClick: () => void };
type CompleteLogMetadata = { state: 'complete'; latestAgentMessage: string | null; latestAssistantMessage: string | null; latestAssistantMessageOverflows: boolean };
type LogFrame = { type: 'append' | 'reset'; text?: string; older?: boolean; newer?: boolean; metadata?: CompleteLogMetadata; question?: InlineQuestion; lastPrompt?: string; latestAgentMessage?: string; latestAssistantMessage?: string; latestAssistantMessageOverflows?: boolean };
type ChoiceOption = { label: string; number: number; answerIndex: number };
type ChoiceQuestion = { text: string; choices: ChoiceOption[]; id: string; source: 'structured' | 'parsed' };
type SavedPromptAttachment = { name: string; size?: number; data?: string };
type SavedPrompt = { id: string; text: string; attachments?: SavedPromptAttachment[] };
type QueuedPrompt = { id: string; text: string; createdAt: string; attachments?: Array<{ name: string; size: number }> };
type PromptHistoryEntry = { id: string; text: string; createdAt: string; answer?: string; answeredAt?: string };
const isSavedPrompt = (value: unknown): value is SavedPrompt => {
  if (value === null || typeof value !== 'object' || typeof (value as SavedPrompt).id !== 'string' || typeof (value as SavedPrompt).text !== 'string') return false;
  const attachments = (value as SavedPrompt).attachments;
  return attachments === undefined || Array.isArray(attachments) && attachments.every(attachment => attachment !== null && typeof attachment === 'object'
    && typeof attachment.name === 'string'
    && (attachment.size === undefined || Number.isInteger(attachment.size) && attachment.size >= 0)
    && (attachment.data === undefined || typeof attachment.data === 'string'));
};
// validate prompt history responses
const isPromptHistoryEntry = (value: unknown): value is PromptHistoryEntry => value !== null
  && typeof value === 'object'
  && typeof (value as PromptHistoryEntry).id === 'string'
  && typeof (value as PromptHistoryEntry).text === 'string'
  && typeof (value as PromptHistoryEntry).createdAt === 'string'
  && ((value as PromptHistoryEntry).answer === undefined || typeof (value as PromptHistoryEntry).answer === 'string')
  && ((value as PromptHistoryEntry).answeredAt === undefined || typeof (value as PromptHistoryEntry).answeredAt === 'string');
const isQueuedPrompt = (value: unknown): value is QueuedPrompt => value !== null
  && typeof value === 'object'
  && typeof (value as QueuedPrompt).id === 'string'
  && typeof (value as QueuedPrompt).text === 'string'
  && typeof (value as QueuedPrompt).createdAt === 'string'
  && ((value as QueuedPrompt).attachments === undefined || Array.isArray((value as QueuedPrompt).attachments) && (value as QueuedPrompt).attachments!.every(attachment => attachment !== null && typeof attachment === 'object' && typeof attachment.name === 'string' && Number.isInteger(attachment.size) && attachment.size >= 0));
type WorktreeNote = { id: string; text: string; title?: string };
type CodexBookmark = { id: string; threadId: string; title: string; createdAt: string };
// validate one bookmark response
const isCodexBookmark = (value: unknown): value is CodexBookmark => value !== null
  && typeof value === 'object'
  && typeof (value as CodexBookmark).id === 'string'
  && typeof (value as CodexBookmark).threadId === 'string'
  && typeof (value as CodexBookmark).title === 'string'
  && typeof (value as CodexBookmark).createdAt === 'string';
type AssistantFile = { path: string; size: number };
type AssistantPreviewImage = { mediaType: 'image/gif'|'image/jpeg'|'image/png'|'image/webp'; base64: string };
type AssistantFilePreview = AssistantFile & { truncated: boolean } & ({ binary: true; image?: AssistantPreviewImage } | { binary: false; content: string });
type FilePreviewState = 'loading'|'ready'|'error';
type InstanceIcon = 'terminal'|'potato'|'heart';
type RemoteServer = { name: string; url: string; icon?: InstanceIcon };
type ServerInfo = { name: string; url: string; icon?: InstanceIcon; remotes: RemoteServer[] };
type InstanceAttention = 'idle'|'working'|'question'|'completed'|'unavailable';
type InstanceStatus = RemoteServer & { attention: InstanceAttention };
type SessionInfo = { csrfToken: string; active: boolean; deviceName?: string; controllingDeviceName?: string; server?: ServerInfo };
type CodexLimitWindow = { usedPercent: number; windowDurationMins?: number; resetsAt?: number };
type CodexAccount = { id: string; label: string; active: boolean; email?: string; planType?: string; primary?: CodexLimitWindow; secondary?: CodexLimitWindow; resetCount?: number; error?: string };
type CodexAccountRestart = { worktreeId: string; status: 'restarted'|'skipped'|'failed'; error?: string };
type CodexAccountResetOutcome = 'reset'|'nothingToReset'|'noCredit'|'alreadyRedeemed';
type CodexAccountLogin = { loginId: string; verificationUrl: string; userCode: string };
type CodexAccountLoginStatus = { status: 'pending'|'succeeded'|'failed'; account?: CodexAccount; error?: string };
// The prompt box's `$skill`/`/slash` catalog is served per Agent by the server
// from the addressed Agent's Adapter (ADR 0002); the web no longer hard-codes it.
type PromptCommand = { value: string; description?: string };
type CommandToken = { start: number; end: number; prefix: '$'|'/'; query: string };
const validCommandValue = /^[$/][^\s]+$/u;
const monoFontFamily = '"JetBrainsMono Nerd Font", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const commandTokenAt = (value: string, cursor: number): CommandToken | undefined => {
  const before = value.slice(0, cursor);
  const match = /(?:^|\s)([$/])([^\s]*)$/u.exec(before);
  if (!match) return undefined;
  const prefix = match[1];
  if (prefix !== '$' && prefix !== '/') return undefined;
  const token = `${prefix}${match[2]}`;
  const suffix = /^\S*/u.exec(value.slice(cursor))?.[0] ?? '';
  return { start: cursor - token.length, end: cursor + suffix.length, prefix, query: `${match[2]}${suffix}` };
};

// Attention is resolved server-side (ADR 0001/0002); the web reads it and never regexes a title.
const actionRequired = (agent: Agent) => agent.attention === 'question';
const agentState = (agent: Agent): AgentState => agent.attention === 'question' ? 'action-required' : agent.attention === 'working' ? 'working' : 'prompt-done';
const agentLabel = (agent: Agent) => (agent.worktreeLabel ?? agent.displayLabel ?? (actionRequired(agent) ? agent.title.replace(/(?:\[\s*.\s*\]\s*)?action required\s*\|?\s*/i, '🚨 ') : agent.title)) || agent.workspace;
// keep server-owned update advisors inside their modal surface
const isEmbeddedUpdateAdvisor = (agent: Pick<Agent, 'displayLabel' | 'worktreeId'>): boolean => agent.worktreeId === undefined && /^Update Advisor (?:(?:Starting v[34]|v[234]) )?[0-9a-f]{7}$/u.test(agent.displayLabel ?? '');
// list other open worktrees once
const otherOpenWorktrees = (agents: Agent[], activeWorktreeId: string | undefined): VoiceWorktree[] => {
  const worktrees = new Map<string, VoiceWorktree>();
  // collect live worktree sessions
  for (const agent of agents) {
    // skip scratch sessions and the active worktree
    if (agent.worktreeId === undefined || agent.worktreeId === activeWorktreeId) continue;
    worktrees.set(agent.worktreeId, { id: agent.worktreeId, label: agent.worktreeLabel?.trim() || agent.worktreeId });
  }
  return [...worktrees.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
};
type SpeechRecognitionResult = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type SpeechRecognitionInstance = { continuous: boolean; interimResults: boolean; lang: string; start: () => void; abort: () => void; onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechRecognitionResult> }) => void) | null; onend: (() => void) | null; onerror: ((event: { error?: string }) => void) | null };
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

const logSnapshots = new BoundedTextCache(64, 64 * 1024);
const lastPrompts = new Map<string, string>();
const latestAssistantMessages = new Map<string, string>();
// the inline question the server parsed from each viewed pane's latest metadata frame
const latestQuestions = new Map<string, InlineQuestion>();
const overflowingLatestAssistantMessages = new Set<string>();
const promptDrafts = new Map<string, string>();
const promptDraftListeners = new Map<string, Set<() => void>>();
const promptDraftKey = (id: string) => `remote-agent-console:prompt-draft:${id}`;
const readPromptDraft = (id: string) => {
  try { return localStorage.getItem(promptDraftKey(id)) ?? ''; }
  catch { return ''; }
};
const savePromptDraft = (id: string, value: string) => {
  try {
    if (value) localStorage.setItem(promptDraftKey(id), value);
    else localStorage.removeItem(promptDraftKey(id));
  } catch { /* Private browsing or storage quota must not block prompting. */ }
};
const getPromptDraft = (id: string) => {
  if (!promptDrafts.has(id)) promptDrafts.set(id, readPromptDraft(id));
  return promptDrafts.get(id) ?? '';
};
const subscribeToPromptDraft = (id: string, listener: () => void) => {
  const listeners = promptDraftListeners.get(id) ?? new Set();
  listeners.add(listener);
  promptDraftListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) promptDraftListeners.delete(id);
  };
};
const setPromptDraft = (id: string, next: SetStateAction<string>) => {
  const current = getPromptDraft(id);
  const value = typeof next === 'function' ? next(current) : next;
  if (value === current) return;
  promptDrafts.set(id, value);
  savePromptDraft(id, value);
  promptDraftListeners.get(id)?.forEach(listener => listener());
};
const usePromptDraft = (id: string): [string, Dispatch<SetStateAction<string>>] => [
  useSyncExternalStore(listener => subscribeToPromptDraft(id, listener), () => getPromptDraft(id), () => ''),
  next => setPromptDraft(id, next)
];
const terminalInputs = new Map<string, (value: string) => void>();
const exitTerminalInput = new Map<string, () => void>();
const logHistoryRequests = new Map<string, (direction: -1 | 0 | 1) => void>();
const answeredQuestionActions = new Map<string, (question: ChoiceQuestion) => void>();
// the id of a just-answered question, kept per agent so its optimistic dismissal survives a remount
const dismissedQuestionIds = new Map<string, string>();
const mobileModifiers = new Map<string, { alt: boolean; ctrl: boolean; shift: boolean }>();
type WorktreeNoteView = { noteId: string; expanded: boolean };
const retainedWorktreeNoteViews = new Map<string, WorktreeNoteView>();
const worktreeNoteViewKey = (worktreeId: string) => `rac.note-view:${worktreeId}`;
const getWorktreeNoteView = (worktreeId: string) => {
  const retained = retainedWorktreeNoteViews.get(worktreeId);
  if (retained !== undefined) return retained;
  try {
    const stored = JSON.parse(localStorage.getItem(worktreeNoteViewKey(worktreeId)) ?? 'null') as Partial<WorktreeNoteView> | null;
    if (stored !== null && typeof stored.noteId === 'string' && typeof stored.expanded === 'boolean') {
      const view = { noteId: stored.noteId, expanded: stored.expanded };
      retainedWorktreeNoteViews.set(worktreeId, view);
      return view;
    }
  } catch { /* browser storage is optional */ }
  return undefined;
};
const setWorktreeNoteView = (worktreeId: string, view: WorktreeNoteView) => {
  retainedWorktreeNoteViews.set(worktreeId, view);
  try { localStorage.setItem(worktreeNoteViewKey(worktreeId), JSON.stringify(view)); }
  catch { /* browser storage is optional */ }
};
const clearWorktreeNoteView = (worktreeId: string) => {
  retainedWorktreeNoteViews.delete(worktreeId);
  try { localStorage.removeItem(worktreeNoteViewKey(worktreeId)); }
  catch { /* browser storage is optional */ }
};
const pendingOperations = new Set<string>();
const pendingOperationListeners = new Map<string, Set<() => void>>();
const pendingNewTaskSources = new Map<string, string>();
// retain launch handoffs by worktree
type PendingWorktreeLaunch = { operationKey: string; sourceAgentId?: string; agentId?: string; confirmationTimer?: number };
const pendingWorktreeLaunches = new Map<string, PendingWorktreeLaunch>();
const worktreeLaunchConfirmationMs = 30_000;
const pullRequestSwitchCache = new Map<string, PullRequestSwitchAvailability>();
const newTaskOperationKey = (worktreeId: string) => `new-task:${worktreeId}`;
const launchOperationKey = (worktreeId: string) => `worktree-launch:${worktreeId}`;
const deactivateOperationKey = (worktreeId: string) => `deactivate:${worktreeId}`;
// track restart transitions by worktree
const restartOperationKey = (worktreeId: string) => `restart:${worktreeId}`;
// track clear transitions by agent
const clearOperationKey = (agentId: string) => `clear:${agentId}`;
// track sleep transitions by worktree
const sleepOperationKey = (worktreeId: string) => `sleep:${worktreeId}`;
// track wake transitions by worktree
const wakeOperationKey = (worktreeId: string) => `wake:${worktreeId}`;
// select one active agent transition
const agentPendingOperation = (agent: Agent): DashboardOperation | undefined => {
  const scope = agent.worktreeId ?? agent.id;
  // prioritize new-task replacement
  if (pendingOperations.has(newTaskOperationKey(scope))) return 'new-task';
  // preserve restart handoff state
  if (pendingOperations.has(restartOperationKey(scope))) return 'restarting';
  // expose conversation clearing
  if (pendingOperations.has(clearOperationKey(agent.id))) return 'clearing';
  // expose permanent shutdown
  if (pendingOperations.has(deactivateOperationKey(scope))) return 'deactivating';
  // expose retained sleep state
  if (pendingOperations.has(sleepOperationKey(scope))) return 'sleeping';
  return undefined;
};
// select one inactive worktree transition
const worktreePendingOperation = (worktree: Worktree): DashboardOperation | undefined => {
  // prioritize new-task replacement
  if (pendingOperations.has(newTaskOperationKey(worktree.id))) return 'new-task';
  // preserve restart handoff state
  if (pendingOperations.has(restartOperationKey(worktree.id))) return 'restarting';
  // expose sleeping-tab shutdown
  if (pendingOperations.has(deactivateOperationKey(worktree.id))) return 'deactivating';
  // expose wake transitions
  if (pendingOperations.has(wakeOperationKey(worktree.id))) return 'waking';
  // expose fresh launches
  if (pendingOperations.has(launchOperationKey(worktree.id))) return 'launching';
  // expose retained sleep state
  if (pendingOperations.has(sleepOperationKey(worktree.id))) return 'sleeping';
  return undefined;
};
const dashboardOperationLabels: Record<DashboardOperation, string> = { launching: 'Starting agent', restarting: 'Restarting', clearing: 'Clearing', deactivating: 'Turning off', sleeping: 'Going to sleep', waking: 'Waking up', 'new-task': 'Starting new task' };
// label one optional dashboard transition
const dashboardOperationLabel = (operation: DashboardOperation | undefined) => operation === undefined ? undefined : dashboardOperationLabels[operation];
// select one launch transition key
const worktreeLaunchOperationKey = (worktree: Pick<Worktree, 'id' | 'sleeping'>) => worktree.sleeping === true ? wakeOperationKey(worktree.id) : launchOperationKey(worktree.id);
const defaultPushAction: PromptAction = { label: 'Commit/Push', prompt: 'review, commit, and push' };
const subscribeToPendingOperation = (key: string, listener: () => void) => {
  const listeners = pendingOperationListeners.get(key) ?? new Set();
  listeners.add(listener);
  pendingOperationListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) pendingOperationListeners.delete(key);
  };
};
const setPendingOperation = (key: string, pending: boolean) => {
  if (pending === pendingOperations.has(key)) return;
  if (pending) pendingOperations.add(key);
  else pendingOperations.delete(key);
  pendingOperationListeners.get(key)?.forEach(listener => listener());
};
const beginPendingOperation = (key: string) => {
  if (pendingOperations.has(key)) return false;
  setPendingOperation(key, true);
  return true;
};
const usePendingOperation = (key: string) => useSyncExternalStore(
  listener => subscribeToPendingOperation(key, listener),
  () => pendingOperations.has(key),
  () => false
);
// read one complete metadata envelope
const completeLogMetadata = (frame: LogFrame): CompleteLogMetadata | undefined => {
  const metadata: unknown = frame.metadata;
  // validate the explicit transport contract
  if (metadata !== null && typeof metadata === 'object'
    && (metadata as CompleteLogMetadata).state === 'complete'
    && (typeof (metadata as CompleteLogMetadata).latestAgentMessage === 'string' || (metadata as CompleteLogMetadata).latestAgentMessage === null)
    && (typeof (metadata as CompleteLogMetadata).latestAssistantMessage === 'string' || (metadata as CompleteLogMetadata).latestAssistantMessage === null)
    && typeof (metadata as CompleteLogMetadata).latestAssistantMessageOverflows === 'boolean') return metadata as CompleteLogMetadata;
  // retain legacy populated frames during upgrades
  if (frame.latestAgentMessage !== undefined || frame.latestAssistantMessage !== undefined) return {
    state: 'complete',
    latestAgentMessage: frame.latestAgentMessage ?? null,
    latestAssistantMessage: frame.latestAssistantMessage ?? null,
    latestAssistantMessageOverflows: frame.latestAssistantMessageOverflows === true
  };
  return undefined;
};
// cache one log transport frame
const cacheLogFrame = (id: string, frame: LogFrame) => {
  const text = frame.text ?? '';
  const metadata = completeLogMetadata(frame);
  // apply authoritative empty resets
  if (frame.type === 'reset' && (text || metadata !== undefined)) logSnapshots.set(id, text);
  else if (text) logSnapshots.append(id, text);
  if (frame.lastPrompt !== undefined) lastPrompts.set(id, frame.lastPrompt);
  // the inline question rides every frame; cache (or clear) it for tab bootstrap
  if (frame.question === undefined) latestQuestions.delete(id);
  else latestQuestions.set(id, frame.question);
  // preserve complete metadata across cheap viewport frames
  if (metadata === undefined) return;
  if (metadata.latestAssistantMessage === null) latestAssistantMessages.delete(id);
  else latestAssistantMessages.set(id, metadata.latestAssistantMessage);
  if (metadata.latestAssistantMessageOverflows) overflowingLatestAssistantMessages.add(id);
  else overflowingLatestAssistantMessages.delete(id);
};

// preserve one structured choice number
const choiceFromLabel = (label: string, answerIndex: number): ChoiceOption => {
  const numbered = /^(\d+)[.)]\s+(.+)$/u.exec(label);
  return numbered === null
    ? { label, number: answerIndex + 1, answerIndex }
    : { label: numbered[2]!, number: Number(numbered[1]), answerIndex };
};

// project one server inline question into the renderable choice model. The
// server parses numbered lists and reads OMX files now, so the web no longer
// parses pane text; it only maps the labels to numbered choices.
const choiceQuestionFromInline = (question: InlineQuestion): ChoiceQuestion => ({ id: question.id, text: question.text, choices: question.choices.map(choiceFromLabel), source: question.source });

let csrf = '';
const currentUiVersion = (() => {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return script === null ? undefined : new URL(script.src).pathname;
})();
type ConsoleConnectionListener = (reachable: boolean) => void;
const consoleConnectionListeners = new Set<ConsoleConnectionListener>();
const unavailableStatuses = new Set([502, 503, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
let consoleReachable = true;
const setConsoleReachable = (reachable: boolean) => {
  if (reachable === consoleReachable) return;
  consoleReachable = reachable;
  consoleConnectionListeners.forEach(listener => listener(reachable));
};
const subscribeToConsoleConnection = (listener: ConsoleConnectionListener) => {
  consoleConnectionListeners.add(listener);
  return () => {
    consoleConnectionListeners.delete(listener);
  };
};
const consoleFetch = async (url: string, init: RequestInit = {}) => {
  try {
    const response = await fetch(url, init);
    setConsoleReachable(!unavailableStatuses.has(response.status));
    return response;
  } catch (error) {
    // A caller-owned timeout or cancellation only says that operation took too
    // long. It does not mean the console or tunnel is unreachable.
    if (!init.signal?.aborted) setConsoleReachable(false);
    throw error;
  }
};
const request = async (url: string, init: RequestInit = {}, observeReachability = true) => {
  const headers = new Headers(init.headers);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  try {
    const options = { ...init, credentials: 'same-origin' as const, headers };
    return await (observeReachability ? consoleFetch(url, options) : fetch(url, options));
  } catch {
    return new Response(JSON.stringify({ error: 'Console unavailable' }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'content-type': 'application/json' }
    });
  }
};
// load the newest retained stack output
const stackLog = async (worktreeId: string): Promise<StackOperationLog | undefined> => {
  const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/commands/log`);
  // allow stacks that have not run yet
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error('stack log unavailable');
  const payload: unknown = await response.json();
  // reject malformed log payloads
  if (!isStackOperationLog(payload)) throw new Error('invalid stack log');
  return payload;
};
function usePromptHistory(agentId: string) {
  const [history, setHistory] = useState<PromptHistoryEntry[]>([]);
  const refresh = useCallback(async () => {
    const response = await request(`/api/agents/${encodeURIComponent(agentId)}/prompt-history`);
    if (!response.ok) return;
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { prompts?: unknown }).prompts)) return;
    const prompts = (payload as { prompts: unknown[] }).prompts.filter(isPromptHistoryEntry);
    if (prompts.length === (payload as { prompts: unknown[] }).prompts.length) setHistory(prompts);
  }, [agentId]);
  useEffect(() => { setHistory([]); void refresh(); }, [refresh]);
  return { history, refresh };
}
const maxAttachmentMegabytes = 25;
const maxAttachmentBytes = maxAttachmentMegabytes * 1024 * 1024;
const maxAttachments = 10;
const mergeSpeechSegments = (current: string, next: string) => {
  const left = current.trim().split(/\s+/u).filter(Boolean);
  const right = next.trim().split(/\s+/u).filter(Boolean);
  const comparable = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  let overlap = Math.min(left.length, right.length);
  while (overlap > 0 && !left.slice(-overlap).every((word, index) => comparable(word) === comparable(right[index]!))) overlap -= 1;
  return [...left, ...right.slice(overlap)].join(' ');
};
const fitPromptInput = (input: HTMLTextAreaElement) => {
  const style = getComputedStyle(input);
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
  const borderHeight = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
  const minHeight = Number.parseFloat(style.minHeight) || 0;
  input.style.minHeight = '0';
  input.style.height = '0';
  const contentHeight = input.scrollHeight;
  input.style.removeProperty('min-height');
  input.style.height = `${Math.max(minHeight, contentHeight + lineHeight + borderHeight)}px`;
};
const encodeAttachment = async (file: File): Promise<{ name: string; data: string }> => await new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error('Unable to read attachment'));
  reader.onload = () => {
    const result = reader.result;
    if (typeof result !== 'string') return reject(new Error('Unable to read attachment'));
    const separator = result.indexOf(',');
    if (separator < 0) return reject(new Error('Unable to read attachment'));
    resolve({ name: file.name, data: result.slice(separator + 1) });
  };
  reader.readAsDataURL(file);
});
const decodeAttachment = (attachment: SavedPromptAttachment): File => {
  if (typeof attachment.data !== 'string') throw new Error('Saved attachment data is unavailable');
  const raw = atob(attachment.data);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return new File([bytes], attachment.name);
};

const agentNotificationTag = (agent: Pick<Agent, 'id' | 'worktreeId'>) => agent.worktreeId === undefined ? `agent-status-${agent.id}` : `worktree-status-${agent.worktreeId}`;
const reviewNotificationTag = (worktreeId: string) => `review-ready-${worktreeId}`;
const pageFocused = () => document.visibilityState === 'visible' && document.hasFocus();
const notificationSoundPaths = { finished: '/notification-success.wav', question: '/notification-warning.wav' } as const;
const recentNotificationSounds = new Map<string, number>();

// play one distinct agent alert chime
const playNotificationSound = async (kind: 'question' | 'finished' | 'system', tag: string): Promise<boolean> => {
  // leave system alerts unchanged
  if (kind === 'system') return false;
  const now = Date.now();
  const previous = recentNotificationSounds.get(tag);
  // suppress duplicate polling and push alerts
  if (previous !== undefined && now - previous < 3_000) return true;
  recentNotificationSounds.set(tag, now);
  window.setTimeout(() => recentNotificationSounds.delete(tag), 3_000);
  try {
    const sound = new Audio(notificationSoundPaths[kind]);
    sound.volume = kind === 'question' ? 0.48 : 0.42;
    await sound.play();
    return true;
  } catch {
    recentNotificationSounds.delete(tag);
    return false;
  }
};

// show alerts with durable worktree metadata
const showNotification = async (kind: 'question' | 'finished' | 'system', title: string, body: string, tag: string, url = '/', worktreeId?: string) => {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const customSoundPlayed = await playNotificationSound(kind, tag);
  const options = { body, tag, icon: '/favicon.svg', badge: '/notification-badge.png', requireInteraction: kind === 'question', silent: customSoundPlayed, data: { url, kind, worktreeId } };
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, options);
    return;
  }
  new Notification(title, options);
};

const dismissNotification = async (tag: string) => {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    (await registration.getNotifications({ tag })).forEach(notification => notification.close());
  } catch { /* Notification access must not interfere with tab navigation. */ }
};

const dismissAgentNotifications = (agent: Pick<Agent, 'id' | 'worktreeId'>) => {
  const tags = new Set([agentNotificationTag(agent), `agent-status-${agent.id}`]);
  for (const tag of tags) void dismissNotification(tag);
  void request(`/api/agents/${encodeURIComponent(agent.id)}/notifications/dismiss`, { method: 'POST' });
};

const copyText = async (value: string) => {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
};
const selectionCopyFlashMs = 600;
const voiceHoldDelayMs = 450;

const ServerContext = createContext<ServerInfo | undefined>(undefined);
const ServerStatusContext = createContext<Readonly<Record<string, InstanceAttention>>>({});
const VoiceTriggerContext = createContext<{ open: () => void; active: boolean; visible: boolean } | undefined>(undefined);
type ServerUpdateState = 'queued' | 'running' | 'complete' | 'failed';
type ServerUpdateAvailability = { available: boolean };
type ServerUpdateCommit = { sha: string; subject: string; author: string; authoredAt: string };
type ServerUpdateAdvisoryReason = { kind: 'config' | 'compose' | 'runtime' | 'dependency' | 'state' | 'other'; paths: string[] };
type ServerUpdatePreview = { available: boolean; rebuildRetryAvailable: boolean; baseSha: string; targetSha: string; fastForwardable: boolean; commitCount: number; commits: ServerUpdateCommit[]; commitsTruncated: boolean; filesTruncated: boolean; advisory: { required: boolean; reasons: ServerUpdateAdvisoryReason[] } };
type ClientSettings = {
  deviceName: string;
  serverName: string;
  serverUrl: string;
  renameClient: (name: string) => Promise<string | undefined>;
  renameServer: (name: string) => Promise<string | undefined>;
  codexAccounts: () => Promise<{ accounts?: CodexAccount[]; error?: string }>;
  switchCodexAccount: (id: string) => Promise<{ account?: CodexAccount; restarts?: CodexAccountRestart[]; error?: string }>;
  resetCodexAccount: (id: string) => Promise<{ outcome?: CodexAccountResetOutcome; account?: CodexAccount; error?: string }>;
  startCodexAccountLogin: (repairAccountId?: string) => Promise<{ login?: CodexAccountLogin; error?: string }>;
  codexAccountLoginStatus: (id: string) => Promise<CodexAccountLoginStatus | undefined>;
  cancelCodexAccountLogin: (id: string) => Promise<void>;
};
const ClientSettingsContext = createContext<ClientSettings | undefined>(undefined);
// format one server host
const serverHostLabel = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
// validate one upstream availability response
const isServerUpdateAvailability = (value: unknown): value is ServerUpdateAvailability => value !== null && typeof value === 'object' && typeof (value as ServerUpdateAvailability).available === 'boolean';
// validate one bounded upstream commit
const isServerUpdateCommit = (value: unknown): value is ServerUpdateCommit => value !== null
  && typeof value === 'object'
  && /^[0-9a-f]{40}$/u.test((value as ServerUpdateCommit).sha)
  && typeof (value as ServerUpdateCommit).subject === 'string'
  && typeof (value as ServerUpdateCommit).author === 'string'
  && typeof (value as ServerUpdateCommit).authoredAt === 'string';
// validate one advisory reason
const isServerUpdateAdvisoryReason = (value: unknown): value is ServerUpdateAdvisoryReason => value !== null
  && typeof value === 'object'
  && ['config', 'compose', 'runtime', 'dependency', 'state', 'other'].includes((value as ServerUpdateAdvisoryReason).kind)
  && Array.isArray((value as ServerUpdateAdvisoryReason).paths)
  && (value as ServerUpdateAdvisoryReason).paths.every(path => typeof path === 'string');
// validate one exact update preview
const isServerUpdatePreview = (value: unknown): value is ServerUpdatePreview => {
  // require one object envelope
  if (value === null || typeof value !== 'object') return false;
  const preview = value as ServerUpdatePreview;
  const advisory = preview.advisory;
  return typeof preview.available === 'boolean'
    && typeof preview.rebuildRetryAvailable === 'boolean'
    && /^[0-9a-f]{40}$/u.test(preview.baseSha)
    && /^[0-9a-f]{40}$/u.test(preview.targetSha)
    && typeof preview.fastForwardable === 'boolean'
    && Number.isSafeInteger(preview.commitCount)
    && Array.isArray(preview.commits)
    && preview.commits.every(isServerUpdateCommit)
    && typeof preview.commitsTruncated === 'boolean'
    && typeof preview.filesTruncated === 'boolean'
    && advisory !== null
    && typeof advisory === 'object'
    && typeof advisory.required === 'boolean'
    && Array.isArray(advisory.reasons)
    && advisory.reasons.every(isServerUpdateAdvisoryReason);
};
// validate one configured icon name
const isInstanceIcon = (value: unknown): value is InstanceIcon => value === 'terminal' || value === 'potato' || value === 'heart';
// validate one server switch target
const isRemoteServer = (value: unknown): value is RemoteServer => value !== null && typeof value === 'object'
  && typeof (value as RemoteServer).name === 'string'
  && typeof (value as RemoteServer).url === 'string'
  && ((value as RemoteServer).icon === undefined || isInstanceIcon((value as RemoteServer).icon));
// validate public server metadata
const isServerInfo = (value: unknown): value is ServerInfo => isRemoteServer(value)
  && Array.isArray((value as ServerInfo).remotes)
  && (value as ServerInfo).remotes.every(isRemoteServer);
// validate one instance attention value
const isInstanceAttention = (value: unknown): value is InstanceAttention => value === 'idle' || value === 'working' || value === 'question' || value === 'completed' || value === 'unavailable';
// validate one aggregated instance status
const isInstanceStatus = (value: unknown): value is InstanceStatus => value !== null
  && typeof value === 'object'
  && isRemoteServer(value)
  && isInstanceAttention((value as InstanceStatus).attention);
// validate one published instance snapshot
const serverStatusesFrom = (value: unknown): { attention: Record<string, InstanceAttention>; servers: InstanceStatus[] } | undefined => {
  // require the aggregate response envelope
  if (value === null || typeof value !== 'object' || !Array.isArray((value as { servers?: unknown }).servers)) return undefined;
  const servers = (value as { servers: unknown[] }).servers;
  // reject partial or malformed lists
  if (!servers.every(isInstanceStatus)) return undefined;
  const published = servers as InstanceStatus[];
  return { attention: Object.fromEntries(published.map(status => [status.url, status.attention])), servers: published };
};
// compare sanitized status maps without rerendering unchanged state
const sameServerStatuses = (left: Readonly<Record<string, InstanceAttention>>, right: Readonly<Record<string, InstanceAttention>>): boolean => {
  const leftEntries = Object.entries(left);
  // require the same keys and attention values
  return leftEntries.length === Object.keys(right).length && leftEntries.every(([url, attention]) => right[url] === attention);
};
// provide backward-compatible identity while older servers update
const fallbackServerInfo = (): ServerInfo => ({ name: 'Remote Agents', url: location.origin, remotes: [] });
// resolve bundled server artwork
const serverIconPath = (icon: InstanceIcon | undefined): string => `/instance-icons/${icon ?? 'terminal'}.svg`;
// describe one server attention marker
const instanceAttentionLabel = (attention: InstanceAttention): string | undefined => {
  // map only visible attention states
  switch (attention) {
    case 'idle': return 'Idle';
    case 'question': return 'Active question';
    case 'working': return 'Working';
    case 'completed': return 'Completed notification';
    case 'unavailable': return 'Server unavailable';
    default: return undefined;
  }
};

// validate one optional unsigned integer
const isOptionalUnsignedInteger = (value: unknown): boolean => value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
// validate one provider limit window
const isCodexLimitWindow = (value: unknown): value is CodexLimitWindow => value !== null
  && typeof value === 'object'
  && Number.isFinite((value as CodexLimitWindow).usedPercent)
  && (value as CodexLimitWindow).usedPercent >= 0
  && (value as CodexLimitWindow).usedPercent <= 100
  && isOptionalUnsignedInteger((value as CodexLimitWindow).windowDurationMins)
  && isOptionalUnsignedInteger((value as CodexLimitWindow).resetsAt);
// validate one safe account summary
const isCodexAccount = (value: unknown): value is CodexAccount => value !== null
  && typeof value === 'object'
  && typeof (value as CodexAccount).id === 'string'
  && typeof (value as CodexAccount).label === 'string'
  && typeof (value as CodexAccount).active === 'boolean'
  && ((value as CodexAccount).email === undefined || typeof (value as CodexAccount).email === 'string')
  && ((value as CodexAccount).planType === undefined || typeof (value as CodexAccount).planType === 'string')
  && ((value as CodexAccount).primary === undefined || isCodexLimitWindow((value as CodexAccount).primary))
  && ((value as CodexAccount).secondary === undefined || isCodexLimitWindow((value as CodexAccount).secondary))
  && isOptionalUnsignedInteger((value as CodexAccount).resetCount)
  && ((value as CodexAccount).error === undefined || typeof (value as CodexAccount).error === 'string');
// validate one reset-credit outcome
const isCodexAccountResetOutcome = (value: unknown): value is CodexAccountResetOutcome => value === 'reset' || value === 'nothingToReset' || value === 'noCredit' || value === 'alreadyRedeemed';
// validate one account restart result
const isCodexAccountRestart = (value: unknown): value is CodexAccountRestart => value !== null
  && typeof value === 'object'
  && typeof (value as CodexAccountRestart).worktreeId === 'string'
  && ['restarted', 'skipped', 'failed'].includes((value as CodexAccountRestart).status)
  && ((value as CodexAccountRestart).error === undefined || typeof (value as CodexAccountRestart).error === 'string');
// validate one device-code login response
const isCodexAccountLogin = (value: unknown): value is CodexAccountLogin => {
  // require the exact public fields
  if (value === null || typeof value !== 'object' || typeof (value as CodexAccountLogin).loginId !== 'string' || typeof (value as CodexAccountLogin).userCode !== 'string' || typeof (value as CodexAccountLogin).verificationUrl !== 'string') return false;
  try {
    return new URL((value as CodexAccountLogin).verificationUrl).protocol === 'https:';
  } catch {
    return false;
  }
};
// label one provider plan
const codexPlanLabel = (plan: string | undefined): string | undefined => plan === undefined ? undefined : plan.replaceAll('_', ' ').replace(/\b\w/gu, letter => letter.toUpperCase());
// select one account email label
const codexAccountEmail = (account: Pick<CodexAccount, 'email' | 'label'>): string => account.email ?? (account.label.includes('@') ? account.label : 'Email unavailable');
// label one limit duration
const codexLimitDuration = (minutes: number | undefined): string => {
  // prefer whole days
  if (minutes !== undefined && minutes >= 1_440 && minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  // prefer whole hours
  if (minutes !== undefined && minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes === undefined ? 'Limit' : `${minutes}m`;
};
// format one live reset countdown
const codexResetCountdown = (timestamp: number | undefined, now: number): string | undefined => {
  // omit unavailable reset times
  if (timestamp === undefined) return undefined;
  const totalSeconds = Math.max(0, Math.ceil(timestamp - now / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor(totalSeconds % 86_400 / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
};
// render one account limit meter
function CodexLimitUsage({ window, now }: { window: CodexLimitWindow; now: number }) {
  const duration = codexLimitDuration(window.windowDurationMins);
  const countdown = codexResetCountdown(window.resetsAt, now);
  return <span className={`chatgpt-limit${window.usedPercent >= 100 ? ' at-limit' : ''}`}><span className="chatgpt-limit-heading"><small>{duration} limit</small><small>{window.usedPercent}% consumed</small></span><progress aria-label={`${duration} ChatGPT limit consumed`} max={100} value={window.usedPercent}>{window.usedPercent}%</progress>{countdown !== undefined && <small className="chatgpt-limit-reset">Resets in {countdown}</small>}</span>;
}

const updateAdvisoryLabels: Record<ServerUpdateAdvisoryReason['kind'], string> = { config: 'Configuration', compose: 'Compose', runtime: 'Host runtime', dependency: 'Dependencies', state: 'Persisted state', other: 'Other changes' };
// format one commit timestamp
const updateCommitDate = (value: string): string => {
  const date = new Date(value);
  // preserve malformed server values visibly
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};
// encode one terminal input frame
const encodeTerminalInput = (value: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const emptyPromptHistory: PromptHistoryEntry[] = [];
// keep embedded output history stable
const refreshEmbeddedHistory = async (): Promise<void> => {};

// render one isolated full advisor output
function EmbeddedAgentOutput({ id, onMetadata }: { id: string; onMetadata: (response: string | undefined, question: ChoiceQuestion | undefined) => void }) {
  const onMetadataRef = useRef(onMetadata);
  const responseRef = useRef<string | undefined>(undefined);
  const questionRef = useRef<ChoiceQuestion | undefined>(undefined);
  onMetadataRef.current = onMetadata;
  // publish one complete response
  const publishResponse = useCallback((response: string | undefined) => {
    responseRef.current = response;
    onMetadataRef.current(response, questionRef.current);
  }, []);
  // publish one inferred question
  const publishQuestion = useCallback((question: ChoiceQuestion | undefined) => {
    questionRef.current = question;
    onMetadataRef.current(responseRef.current, question);
  }, []);
  return <div className="update-advisor-output" aria-label="Update advisor output"><Log id={id} history={emptyPromptHistory} refreshHistory={refreshEmbeddedHistory} onQuestion={publishQuestion} onMetadata={publishResponse} embedded /><MobileTerminalKeys id={id} /></div>;
}

// review and launch one exact server update
function ServerUpdateDialog({ open, minimized, onMinimize, onClose }: { open: boolean; minimized: boolean; onMinimize: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<ServerUpdatePreview>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updateId, setUpdateId] = useState<string>();
  const [updateState, setUpdateState] = useState<ServerUpdateState>();
  const [updateSubmitting, setUpdateSubmitting] = useState(false);
  const [advisorId, setAdvisorId] = useState<string>();
  const [advisorState, setAdvisorState] = useState<AgentState>();
  const [advisorQuestion, setAdvisorQuestion] = useState<ChoiceQuestion>();
  const [inferredQuestion, setInferredQuestion] = useState<ChoiceQuestion>();
  const [advisorResponse, setAdvisorResponse] = useState<string>();
  const [advisorResponsePending, setAdvisorResponsePending] = useState(false);
  const advisorResponseBaseline = useRef<string | undefined>(undefined);
  const [advisorError, setAdvisorError] = useState('');
  const [advisorAcknowledged, setAdvisorAcknowledged] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackPending, setFeedbackPending] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const visibleQuestion = advisorQuestion ?? inferredQuestion;
  const updating = updateSubmitting || updateState === 'queued' || updateState === 'running';
  // focus the update surface when restored
  useEffect(() => { if (open && !minimized) dialog.current?.focus(); }, [minimized, open]);
  // load one fresh preview and advisor
  useEffect(() => {
    // stop hidden preview work
    if (!open) return;
    let active = true;
    setPreview(undefined);
    setLoading(true);
    setError('');
    setUpdateId(undefined);
    setUpdateState(undefined);
    setUpdateSubmitting(false);
    setAdvisorId(undefined);
    setAdvisorState(undefined);
    setAdvisorQuestion(undefined);
    setInferredQuestion(undefined);
    setAdvisorResponse(undefined);
    setAdvisorResponsePending(false);
    advisorResponseBaseline.current = undefined;
    setAdvisorError('');
    setAdvisorAcknowledged(false);
    setFeedback('');
    setFeedbackMessage('');
    // resolve the exact current range
    const load = async () => {
      const response = await request('/api/server/update-preview');
      const payload: unknown = await response.json().catch(() => undefined);
      // retain a visible preview failure
      if (!response.ok || !isServerUpdatePreview(payload)) {
        if (active) {
          setLoading(false);
          setError('Unable to load the pending update.');
        }
        return;
      }
      if (!active) return;
      setPreview(payload);
      setLoading(false);
      // launch advice only for conservatively flagged ranges
      if (!payload.available || !payload.advisory.required) return;
      const advisorResponse = await request('/api/server/update-advisor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetSha: payload.targetSha }) });
      const advisorPayload = await advisorResponse.json().catch(() => undefined) as { agentId?: unknown; error?: unknown } | undefined;
      // retain advisor launch failures without losing the commit review
      if (!active) return;
      if (!advisorResponse.ok || typeof advisorPayload?.agentId !== 'string') {
        setAdvisorError(typeof advisorPayload?.error === 'string' ? advisorPayload.error : 'Unable to start the update advisor.');
        return;
      }
      setAdvisorId(advisorPayload.agentId);
    };
    void load();
    return () => { active = false; };
  }, [open]);
  // follow advisor state and structured questions
  useEffect(() => {
    // require one launched advisor
    if (!open || advisorId === undefined) return;
    let active = true;
    const refresh = async () => {
      const response = await request('/api/dashboard', undefined, false);
      const payload: unknown = await response.json().catch(() => undefined);
      // retain the last good advisor state
      if (!active || !response.ok || !isDashboard(payload)) return;
      const agent = payload.agents.find(candidate => candidate.id === advisorId);
      // report vanished advisor sessions
      if (agent === undefined) {
        setAdvisorError('The update advisor is no longer available.');
        return;
      }
      setAdvisorState(agentState(agent));
      setAdvisorQuestion(advisorResponsePending || agent.question === undefined ? undefined : choiceQuestionFromInline(agent.question));
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [advisorId, advisorResponsePending, open]);
  // follow one update across the expected restart
  useEffect(() => {
    // require one active operation
    if (!open || updateId === undefined || updateState === 'complete' || updateState === 'failed') return;
    let active = true;
    const poll = async () => {
      const response = await request(`/api/server/update/${encodeURIComponent(updateId)}`);
      // tolerate the rebuild outage
      if (!active || !response.ok) return;
      const payload = await response.json().catch(() => undefined) as { state?: unknown } | undefined;
      // accept one canonical lifecycle state
      if (payload?.state === 'queued' || payload?.state === 'running' || payload?.state === 'complete' || payload?.state === 'failed') setUpdateState(payload.state);
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [open, updateId, updateState]);
  // answer one advisor choice
  const answerAdvisor = async (answerIndex: number) => {
    // require one current question
    if (advisorId === undefined || visibleQuestion === undefined || feedbackPending) return;
    setFeedbackPending(true);
    setFeedbackMessage('');
    // every inline question — structured or parsed — answers through one endpoint
    const response = await request(`/api/agents/${encodeURIComponent(advisorId)}/question`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: visibleQuestion.id, index: answerIndex }) });
    setFeedbackPending(false);
    // retain rejected answers
    if (!response.ok) {
      setFeedbackMessage('Unable to answer the advisor question.');
      return;
    }
    // require review of the advisor's next response
    advisorResponseBaseline.current = advisorResponse;
    setAdvisorResponsePending(true);
    setAdvisorAcknowledged(false);
    setAdvisorQuestion(undefined);
    setInferredQuestion(undefined);
  };
  // send direct terminal input for free-form question feedback
  const sendAdvisorInput = async (value: string): Promise<boolean> => {
    // require one advisor target
    if (advisorId === undefined) return false;
    const ticketResponse = await request(`/api/agents/${encodeURIComponent(advisorId)}/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'input' }) });
    // require one input ticket
    if (!ticketResponse.ok) return false;
    const ticketPayload = await ticketResponse.json().catch(() => undefined) as { ticket?: unknown } | undefined;
    // reject malformed tickets
    if (typeof ticketPayload?.ticket !== 'string') return false;
    return await new Promise(resolve => {
      const socket = new WebSocket(`${location.origin.replace(/^http/u, 'ws')}/ws/input/${encodeURIComponent(advisorId)}`, ['rac', ticketPayload.ticket as string]);
      let settled = false;
      let sent = false;
      // settle one transport outcome
      const finish = (result: boolean) => {
        // ignore duplicate socket events
        if (settled) return;
        settled = true;
        socket.close();
        resolve(result);
      };
      socket.onopen = () => {
        sent = true;
        socket.send(JSON.stringify({ v: 1, type: 'input', data: encodeTerminalInput(`${value}\r`) }));
        window.setTimeout(() => finish(true), 100);
      };
      socket.onerror = () => finish(false);
      socket.onclose = () => finish(sent);
      window.setTimeout(() => finish(false), 5_000);
    });
  };
  // submit one advisor follow-up
  const submitFeedback = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = feedback.trim();
    // prevent empty or duplicate feedback
    if (!value || advisorId === undefined || feedbackPending || advisorResponsePending || advisorResponse === undefined) return;
    setFeedbackPending(true);
    setFeedbackMessage('');
    const directInput = advisorState === 'action-required' && visibleQuestion === undefined;
    const sent = directInput
      ? await sendAdvisorInput(value)
      : (await request(`/api/agents/${encodeURIComponent(advisorId)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: value, attachments: [] }) })).ok;
    setFeedbackPending(false);
    // retain failed feedback
    if (!sent) {
      setFeedbackMessage('Unable to send feedback to the advisor.');
      return;
    }
    // require review of the advisor's follow-up response
    advisorResponseBaseline.current = advisorResponse;
    setAdvisorResponsePending(true);
    setAdvisorAcknowledged(false);
    setFeedback('');
    setFeedbackMessage(directInput ? 'Feedback sent.' : 'Feedback queued.');
  };
  // start one pinned host update
  const startUpdate = async () => {
    // require one current preview
    if (preview === undefined || updating) return;
    setError('');
    setUpdateSubmitting(true);
    const response = await request('/api/server/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedTargetSha: preview.targetSha, advisoryAcknowledged: advisorAcknowledged }) });
    const payload = await response.json().catch(() => undefined) as { id?: unknown; state?: unknown; error?: unknown } | undefined;
    // retain launch or stale-preview failures
    if (!response.ok || typeof payload?.id !== 'string') {
      setUpdateSubmitting(false);
      setError(typeof payload?.error === 'string' ? payload.error : 'Unable to start the server update.');
      return;
    }
    setUpdateId(payload.id);
    setUpdateState(payload.state === 'running' ? 'running' : 'queued');
    setUpdateSubmitting(false);
  };
  // close the modal and stop its dedicated advisor
  const closeDialog = () => {
    // preserve the advisor throughout an active host update
    if (updating) return;
    const targetSha = preview?.targetSha;
    onClose();
    // serialize server cleanup behind any in-flight advisor launch
    if (targetSha !== undefined) void request('/api/server/update-advisor', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetSha }) });
  };
  // contain keyboard focus inside the modal
  const dialogKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // minimize active updates on escape
    if (event.key === 'Escape') { updating ? onMinimize() : closeDialog(); return; }
    // retain ordinary keys
    if (event.key !== 'Tab' || dialog.current === null) return;
    const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')).filter(control => control.offsetParent !== null);
    // retain focus when no controls exist
    if (controls.length === 0) { event.preventDefault(); dialog.current.focus(); return; }
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? controls.indexOf(active) : -1;
    let next = index + 1;
    // wrap backward focus
    if (event.shiftKey) next = index <= 0 ? controls.length - 1 : index - 1;
    // wrap forward focus
    else if (index < 0 || index === controls.length - 1) next = 0;
    event.preventDefault();
    controls.at(next)?.focus();
  };
  // keep update polling alive while hidden
  if (!open || minimized) return null;
  const adviceReady = advisorResponse !== undefined && !advisorResponsePending && advisorState === 'prompt-done' && visibleQuestion === undefined;
  const updateBlocked = preview === undefined || !preview.available && !preview.rebuildRetryAvailable || !preview.fastForwardable || updating || updateState === 'complete' || preview.advisory.required && (!adviceReady || !advisorAcknowledged);
  let body: ReactNode;
  // render preview loading
  if (loading) {
    body = <div className="update-review-loading" role="status"><span className="spinner" />Fetching commits from origin/main…</div>;
  // render preview failure
  } else if (preview === undefined) {
    body = <div className="update-review-loading error" role="alert">{error || 'Update preview unavailable.'}</div>;
  // render a durable rebuild retry
  } else if (preview.rebuildRetryAvailable) {
    body = <div className="update-review-loading"><strong>Host rebuild needs another attempt.</strong><span>Git reached {preview.targetSha.slice(0, 7)}, but the last Compose rebuild failed.</span></div>;
  // render current state
  } else if (!preview.available) {
    body = <div className="update-review-loading"><strong>Server is current.</strong><span>No upstream commits are waiting.</span></div>;
  // render the exact pending range
  } else {
    body = <div className="update-review-body"><section className="update-review-summary"><div><small>{preview.baseSha.slice(0, 7)}</small><span aria-hidden="true">→</span><strong>{preview.targetSha.slice(0, 7)}</strong></div><span>{preview.commitCount} new {preview.commitCount === 1 ? 'commit' : 'commits'}{preview.commitsTruncated ? ` · showing ${preview.commits.length}` : ''}</span></section>{!preview.fastForwardable && <p className="update-review-warning" role="alert">Local main cannot be fast-forwarded to this update. Resolve the checkout manually before updating.</p>}<ol className="update-commit-list" aria-label="Pending commits">{preview.commits.map(commit => <li key={commit.sha}><code>{commit.sha.slice(0, 7)}</code><span><strong>{commit.subject}</strong><small>{commit.author} · {updateCommitDate(commit.authoredAt)}</small></span></li>)}</ol>{preview.advisory.required && <section className="update-advisor"><header><div><small>UPDATE ADVISOR</small><h3>Host changes need review</h3></div><span className={`update-advisor-state ${advisorState ?? 'starting'}`}>{advisorState === 'working' ? 'Reviewing' : advisorState === 'action-required' ? 'Needs input' : advisorState === 'prompt-done' ? 'Ready' : 'Starting'}</span></header><p>The changed paths below may require host-local actions. The advisor inspects the exact commit range without modifying it.</p><div className="update-advisory-reasons">{preview.advisory.reasons.map(reason => <div key={reason.kind}><strong>{updateAdvisoryLabels[reason.kind]}</strong>{reason.paths.length === 0 ? <span>Manual Git reconciliation required</span> : reason.paths.map(path => <code key={path}>{path}</code>)}</div>)}</div>{preview.filesTruncated && <small className="update-review-warning">Changed-path review was truncated; the advisor will inspect the complete Git range.</small>}{advisorError ? <div className="update-advisor-error" role="alert">{advisorError}</div> : advisorId === undefined ? <div className="update-advisor-launching" role="status"><span className="spinner" />Starting a dedicated advisor…</div> : <><EmbeddedAgentOutput id={advisorId} onMetadata={(response, question) => { /* ignore metadata from the turn before current feedback */ setAdvisorResponse(response); if (advisorResponsePending && (response === undefined || response === advisorResponseBaseline.current)) return; if (advisorResponsePending) setAdvisorResponsePending(false); setInferredQuestion(question); }} />{visibleQuestion !== undefined && <div className="update-advisor-question"><strong>{visibleQuestion.text}</strong><div>{visibleQuestion.choices.map(choice => <button type="button" key={`${choice.answerIndex}-${choice.label}`} disabled={feedbackPending} onClick={() => void answerAdvisor(choice.answerIndex)}><b>{choice.number}</b><span>{choice.label}</span></button>)}</div></div>}<form className="update-advisor-feedback" onSubmit={event => void submitFeedback(event)}><label>Approval or feedback<textarea value={feedback} maxLength={32_000} disabled={advisorResponsePending || advisorResponse === undefined} placeholder={advisorResponsePending ? 'Waiting for the advisor response…' : advisorState === 'action-required' && visibleQuestion === undefined ? 'Reply to the advisor…' : 'Queue a follow-up for the advisor…'} onFocus={() => { /* leave terminal input */ if (advisorId !== undefined) exitTerminalInput.get(advisorId)?.(); }} onChange={event => setFeedback(event.target.value)} /></label><button type="submit" disabled={feedbackPending || advisorResponsePending || advisorResponse === undefined || !feedback.trim()}>{feedbackPending ? <><span className="spinner" />Sending…</> : 'Send'}</button></form>{feedbackMessage && <small className="update-advisor-feedback-status" role="status">{feedbackMessage}</small>}{adviceReady && <label className="update-advisor-acknowledgement"><input type="checkbox" checked={advisorAcknowledged} onChange={event => setAdvisorAcknowledged(event.target.checked)} /><span>I reviewed the advisor guidance for this exact update.</span></label>}</>}</section>}</div>;
  }
  const progress = updateState === undefined ? null : <div className={`update-review-progress ${updateState}`} role="status">{updateState === 'failed' ? <span>Update failed. Check the server update log.</span> : updateState === 'complete' ? <><strong>Update complete.</strong><button type="button" onClick={() => location.reload()}>Reload</button></> : <><span className="spinner" /><span>{updateState === 'queued' ? 'Waiting for the host…' : 'Pulling the reviewed revision, rebuilding, and restarting…'}</span></>}</div>;
  return createPortal(<div ref={dialog} className="dialog server-update-dialog" role="dialog" aria-modal="true" aria-labelledby="server-update-review-title" tabIndex={-1} onKeyDown={dialogKey}><div><header><div><small>SERVER UPDATE</small><h2 id="server-update-review-title">Review update</h2></div><span className="server-update-controls"><button type="button" aria-label="Minimize server update" title="Minimize" onClick={onMinimize}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg></button><button type="button" aria-label="Close server update" title="Close" disabled={updating} onClick={closeDialog}>×</button></span></header>{body}{error && preview !== undefined && <p className="update-review-error" role="alert">{error}</p>}{progress}<footer><span>{preview?.advisory.required && !advisorAcknowledged ? 'Advisor acknowledgement required' : preview?.fastForwardable === false ? 'Manual Git reconciliation required' : preview?.rebuildRetryAvailable ? 'Retry the failed host rebuild.' : 'The update will rebuild this host only.'}</span><button type="button" disabled={updateBlocked} onClick={() => void startUpdate()}>{updating ? <><span className="spinner" />Updating…</> : preview?.rebuildRetryAvailable ? 'Retry rebuild' : 'Update'}</button></footer></div></div>, document.body);
}

// render the client settings flyout
function ClientSettingsMenu({ settings }: { settings: ClientSettings }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'client' | 'server' | 'account-login'>();
  const [name, setName] = useState(settings.deviceName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [accounts, setAccounts] = useState<CodexAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [switchingAccountId, setSwitchingAccountId] = useState<string>();
  const [resettingAccountId, setResettingAccountId] = useState<string>();
  const [accountMessage, setAccountMessage] = useState('');
  const [accountClock, setAccountClock] = useState(() => Date.now());
  const [accountLogin, setAccountLogin] = useState<CodexAccountLogin>();
  const [accountLoginTarget, setAccountLoginTarget] = useState<{ email: string }>();
  const [accountLoginState, setAccountLoginState] = useState<'pending' | 'failed'>('pending');
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  const accountLoginRequest = useRef(0);
  const { anchorRef, flyoutRef, style } = useViewportFlyout(open);
  // query every configured account when opened
  useEffect(() => {
    // skip hidden menus
    if (!open) return;
    let active = true;
    setAccountsLoading(true);
    void settings.codexAccounts().then(result => {
      // ignore closed-menu responses
      if (!active) return;
      setAccountsLoading(false);
      // retain the last good list on failure
      if (result.accounts === undefined) {
        setAccountMessage(result.error ?? 'Unable to load ChatGPT accounts.');
        return;
      }
      setAccounts(result.accounts);
    });
    return () => { active = false; };
  }, [open, settings]);
  // update visible reset countdowns every second
  useEffect(() => {
    // stop the clock while the menu is hidden
    if (!open) return;
    setAccountClock(Date.now());
    const interval = window.setInterval(() => setAccountClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [open]);
  // start editing the current client name
  const beginRename = (target: 'client' | 'server') => {
    setName(target === 'client' ? settings.deviceName : settings.serverName);
    setError('');
    setOpen(false);
    setDialog(target);
  };
  // switch the global Codex account
  const switchAccount = async (account: CodexAccount) => {
    // ignore active or duplicate selections
    if (account.active || switchingAccountId !== undefined || resettingAccountId !== undefined) return;
    setSwitchingAccountId(account.id);
    setAccountMessage('');
    const result = await settings.switchCodexAccount(account.id);
    setSwitchingAccountId(undefined);
    // keep the current account after failure
    if (result.account === undefined) {
      setAccountMessage(result.error ?? 'Unable to switch ChatGPT accounts.');
      return;
    }
    const switchedAccount = result.account;
    setAccounts(current => current.map(candidate => candidate.id === switchedAccount.id ? { ...candidate, ...switchedAccount, active: true } : { ...candidate, active: false }));
    const restarted = result.restarts?.filter(item => item.status === 'restarted').length ?? 0;
    const failed = result.restarts?.filter(item => item.status === 'failed').length ?? 0;
    setAccountMessage(`Switched to ${codexAccountEmail(account)}. Restarted ${restarted} idle ${restarted === 1 ? 'worktree' : 'worktrees'}${failed === 0 ? '.' : `; ${failed} failed.`}`);
  };
  // redeem one available reset credit
  const useAccountReset = async (account: CodexAccount) => {
    const atLimit = account.primary?.usedPercent === 100 || account.secondary?.usedPercent === 100;
    // require an eligible idle account action
    if (!atLimit || !account.resetCount || switchingAccountId !== undefined || resettingAccountId !== undefined) return;
    setResettingAccountId(account.id);
    setAccountMessage('');
    const result = await settings.resetCodexAccount(account.id);
    // retain current usage after transport failures
    if (result.outcome === undefined) {
      setResettingAccountId(undefined);
      setAccountMessage(result.error ?? 'Unable to use the ChatGPT reset.');
      return;
    }
    // publish a refreshed provider snapshot when available
    if (result.account !== undefined) {
      const refreshedAccount = result.account;
      setAccounts(current => current.map(candidate => candidate.id === refreshedAccount.id ? { ...candidate, ...refreshedAccount } : candidate));
    } else {
      const refreshed = await settings.codexAccounts();
      // replace stale usage after a successful provider action
      if (refreshed.accounts !== undefined) setAccounts(refreshed.accounts);
    }
    setResettingAccountId(undefined);
    // report the provider outcome without inventing success
    const email = codexAccountEmail(account);
    if (result.outcome === 'reset') setAccountMessage(`Used one reset for ${email}.`);
    else if (result.outcome === 'nothingToReset') setAccountMessage(`${email} no longer has a limit available to reset.`);
    else if (result.outcome === 'noCredit') setAccountMessage(`${email} has no resets available.`);
    else setAccountMessage(`The reset for ${email} was already used.`);
  };
  // start one device-code login
  const beginAccountLogin = async (account?: CodexAccount) => {
    const requestId = accountLoginRequest.current + 1;
    accountLoginRequest.current = requestId;
    setOpen(false);
    setDialog('account-login');
    setAccountLogin(undefined);
    setAccountLoginTarget(account === undefined ? undefined : { email: codexAccountEmail(account) });
    setAccountLoginState('pending');
    setDeviceCodeCopied(false);
    setError('');
    const result = await settings.startCodexAccountLogin(account?.id);
    // cancel logins created after the dialog closes or another request starts
    if (accountLoginRequest.current !== requestId) {
      // stop the late server session
      if (result.login !== undefined) await settings.cancelCodexAccountLogin(result.login.loginId);
      return;
    }
    // retain a visible failure
    if (result.login === undefined) {
      setAccountLoginState('failed');
      setError(result.error ?? 'Unable to start ChatGPT login.');
      return;
    }
    setAccountLogin(result.login);
  };
  // copy the current device code
  const copyDeviceCode = async () => {
    // require one ready login
    if (accountLogin === undefined) return;
    try {
      await copyText(accountLogin.userCode);
      setDeviceCodeCopied(true);
    } catch {
      setDeviceCodeCopied(false);
    }
  };
  // close the active popup
  const closeDialog = () => {
    // keep pending writes stable
    if (pending) return;
    // stop abandoned and in-flight device logins
    if (dialog === 'account-login' && accountLoginState === 'pending') {
      accountLoginRequest.current += 1;
      // cancel a started server session
      if (accountLogin !== undefined) void settings.cancelCodexAccountLogin(accountLogin.loginId);
    }
    setDialog(undefined);
    setError('');
  };
  // save one client or server name
  const submitRename = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // prevent duplicate writes
    if (pending || (dialog !== 'client' && dialog !== 'server')) return;
    const normalized = name.trim();
    // keep invalid names local
    if (!normalized) {
      setError(`Enter a ${dialog} name.`);
      return;
    }
    setPending(true);
    setError('');
    const failure = dialog === 'client' ? await settings.renameClient(normalized) : await settings.renameServer(normalized);
    setPending(false);
    // retain the editor after a failed rename
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    setDialog(undefined);
  };
  // poll one device-code login
  useEffect(() => {
    // require an active login
    if (dialog !== 'account-login' || accountLogin === undefined || accountLoginState !== 'pending') return;
    let active = true;
    const poll = async () => {
      const status = await settings.codexAccountLoginStatus(accountLogin.loginId);
      // ignore transient or stale reads
      if (!active || status === undefined || status.status === 'pending') return;
      // show provider failures in place
      if (status.status === 'failed') {
        setAccountLoginState('failed');
        setError(status.error ?? 'ChatGPT login failed.');
        return;
      }
      // publish the completed account before the list refresh
      if (status.account !== undefined) {
        const completedAccount = status.account;
        setAccounts(current => [...current.filter(account => account.id !== completedAccount.id), completedAccount]);
      }
      const refreshed = await settings.codexAccounts();
      // publish the newly configured account list
      if (active && refreshed.accounts !== undefined) setAccounts(refreshed.accounts);
      // close the login dialog into a visible success state
      if (active) {
        setDialog(undefined);
        setAccountLogin(undefined);
        setOpen(true);
        setAccountMessage(accountLoginTarget === undefined ? `${status.account === undefined ? 'ChatGPT account' : codexAccountEmail(status.account)} added.` : `Re-login complete for ${accountLoginTarget.email}.`);
      }
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, 1_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [accountLogin, accountLoginState, accountLoginTarget, dialog, settings]);
  // render each configured account
  const accountRows = accounts.map(account => {
    const plan = codexPlanLabel(account.planType);
    const details = [account.primary, account.secondary].filter((window): window is CodexLimitWindow => window !== undefined);
    const email = codexAccountEmail(account);
    const inlinePlan = plan === undefined ? '' : ` (${plan})`;
    const atLimit = details.some(window => window.usedPercent === 100);
    const busy = accountsLoading || switchingAccountId !== undefined || resettingAccountId !== undefined;
    return <div key={account.id} className="chatgpt-account-option"><button className="chatgpt-account-select" type="button" role="menuitemradio" aria-checked={account.active} disabled={account.active || busy} onClick={() => void switchAccount(account)}><span className="chatgpt-account-check" aria-hidden="true">{switchingAccountId === account.id ? <span className="spinner" /> : account.active ? '✓' : ''}</span><span className="chatgpt-account-copy"><strong>{email}{inlinePlan}</strong>{details.map((window, index) => <CodexLimitUsage key={`${account.id}:${index}`} window={window} now={accountClock} />)}{account.resetCount !== undefined && account.resetCount > 0 && <small>{account.resetCount} {account.resetCount === 1 ? 'reset' : 'resets'} available</small>}{account.error !== undefined && <small className="chatgpt-account-error">{account.error}</small>}</span></button>{atLimit && account.resetCount !== undefined && account.resetCount > 0 && <button className="chatgpt-account-reset" type="button" role="menuitem" aria-label={`Use reset for ${email}`} disabled={busy} onClick={() => void useAccountReset(account)}>{resettingAccountId === account.id ? <><span className="spinner" />Using reset…</> : 'Use reset'}</button>}{account.error !== undefined && <button className="chatgpt-account-relogin" type="button" role="menuitem" aria-label={`Re-login to ${email}`} disabled={busy} onClick={() => void beginAccountLogin(account)}>Re-login</button>}</div>;
  });
  // render current client and server identities
  const settingsCards = <div className="client-settings-overview" role="presentation"><div className="client-settings-card" role="group" aria-label="Client"><header><small>CLIENT</small><span className="client-settings-card-actions"><button type="button" role="menuitem" aria-label="Rename Client" onClick={() => beginRename('client')}>Rename</button></span></header><strong>{settings.deviceName}</strong></div><div className="client-settings-card" role="group" aria-label="Server"><header><small>SERVER</small><span className="client-settings-card-actions"><button type="button" role="menuitem" aria-label="Rename Server" onClick={() => beginRename('server')}>Rename</button></span></header><strong>{settings.serverName}</strong><span>{serverHostLabel(settings.serverUrl)}</span></div></div>;
  const flyout = !open ? null : <FlyoutPortal onDismiss={() => setOpen(false)}><div ref={flyoutRef} className="client-settings-menu more-menu flyout-menu" style={style} role="menu" aria-label="Global settings" aria-busy={accountsLoading || switchingAccountId !== undefined || resettingAccountId !== undefined}>{settingsCards}<hr className="more-menu-divider" />{accountsLoading && accounts.length === 0 ? <button className="chatgpt-account-loading" type="button" role="menuitem" disabled><span className="spinner" />Loading ChatGPT accounts…</button> : accountRows}{accountMessage && <span className="chatgpt-account-message" role="status">{accountMessage}</span>}<button className="chatgpt-account-add" type="button" role="menuitem" disabled={accountsLoading || switchingAccountId !== undefined || resettingAccountId !== undefined} onClick={() => void beginAccountLogin()}>+ Add account</button></div></FlyoutPortal>;
  const renameTarget = dialog === 'client' || dialog === 'server' ? dialog : undefined;
  const renameDialog = renameTarget === undefined ? null : createPortal(<div className="dialog client-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-rename-title" onKeyDown={event => { /* close on escape */ if (event.key === 'Escape') closeDialog(); }}><div><header><div><small>GLOBAL SETTINGS</small><h2 id="settings-rename-title">Rename {renameTarget === 'client' ? 'Client' : 'Server'}</h2></div><button type="button" aria-label={`Close rename ${renameTarget}`} disabled={pending} onClick={closeDialog}>×</button></header><form onSubmit={event => void submitRename(event)}><label>{renameTarget === 'client' ? 'Client' : 'Server'} name<input autoFocus type="text" value={name} maxLength={renameTarget === 'client' ? 64 : 80} autoComplete="nickname" onChange={event => setName(event.target.value)} /></label>{error && <span className="auth-error" role="alert">{error}</span>}<footer><button type="button" disabled={pending} onClick={closeDialog}>Cancel</button><button type="submit" disabled={pending || !name.trim()}>{pending ? <><span className="spinner" />Renaming…</> : 'Save'}</button></footer></form></div></div>, document.body);
  let accountLoginContent: ReactNode;
  // render a failed login
  if (accountLoginState === 'failed') {
    accountLoginContent = <span className="auth-error">{error || 'ChatGPT login failed.'}</span>;
  // render an active device-code login
  } else if (accountLogin !== undefined) {
    accountLoginContent = <><span>{accountLoginTarget === undefined ? 'Open ChatGPT to add this account.' : `Open ChatGPT to repair ${accountLoginTarget.email}.`}</span><a href={accountLogin.verificationUrl} target="_blank" rel="noreferrer">Open activation page ↗</a><span className="chatgpt-device-code-wrap"><small>DEVICE CODE</small><button className="chatgpt-device-code" type="button" title="Copy login code" onClick={() => void copyDeviceCode()}>{accountLogin.userCode}</button><small className={deviceCodeCopied ? 'copied' : undefined} aria-live="polite">{deviceCodeCopied ? 'Copied!' : 'Click the code to copy it'}</small></span><small>Waiting for authorization…</small></>;
  // render login startup
  } else {
    accountLoginContent = <><span className="spinner" /><span>Starting secure ChatGPT login…</span></>;
  }
  const accountLoginDialog = dialog !== 'account-login' ? null : createPortal(<div className="dialog client-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="account-login-title"><div><header><div><small>GLOBAL SETTINGS</small><h2 id="account-login-title">{accountLoginTarget === undefined ? 'Add ChatGPT account' : 'Re-login to ChatGPT'}</h2></div><button type="button" aria-label="Close account login" onClick={closeDialog}>×</button></header><div className={`chatgpt-account-login ${accountLoginState}`} role="status">{accountLoginContent}</div><footer className="chatgpt-account-login-actions"><button type="button" onClick={closeDialog}>Cancel</button></footer></div></div>, document.body);
  // toggle the menu as a fresh user action
  const toggleSettings = () => {
    // clear stale operation messages on a new open
    if (!open) setAccountMessage('');
    setOpen(current => !current);
    setError('');
  };
  return <span ref={anchorRef} className="server-switcher-settings-wrap"><button type="button" className="server-switcher-button server-switcher-settings" aria-label="Global settings" aria-haspopup="menu" aria-expanded={open} onClick={toggleSettings}>⋮</button>{flyout}{renameDialog}{accountLoginDialog}</span>;
}

// render native links for remote server handoff
function ServerSwitcher({ className = '' }: { className?: string }) {
  const server = useContext(ServerContext) ?? fallbackServerInfo();
  const statuses = useContext(ServerStatusContext);
  const voice = useContext(VoiceTriggerContext);
  const clientSettings = useContext(ClientSettingsContext);
  const targets = [{ name: server.name, url: server.url, icon: server.icon }, ...server.remotes];
  // render the current server first
  const serverTargets = targets.map(target => {
    const attention = statuses[target.url] ?? 'idle';
    const attentionLabel = instanceAttentionLabel(attention);
    // share one target body
    const content = <><img src={serverIconPath(target.icon)} alt="" /><span>{target.name}</span><i className={`server-switcher-attention ${attention}`} aria-hidden="true" title={attentionLabel} /></>;
    // keep the active instance stable
    if (target.url === server.url) return <button key={target.url} type="button" className={`server-switcher-button attention-${attention}`} aria-current="page" aria-label={`${target.name}${attentionLabel === undefined ? '' : ` — ${attentionLabel}`}`}>{content}</button>;
    // expose an OS-capturable HTTPS link
    return <a key={target.url} href={target.url} className={`server-switcher-button attention-${attention}`} aria-label={`${target.name}${attentionLabel === undefined ? '' : ` — ${attentionLabel}`}`}>{content}</a>;
  });
  const voiceLabel = voice?.active ? voice.visible ? 'Ongoing Davo call' : 'Show ongoing Davo call' : 'Call Davo';
  return <div className={`server-switcher${className ? ` ${className}` : ''}`} role="group" aria-label="Davo and Remote Agents servers">{voice && <button type="button" className={`server-switcher-button server-switcher-voice${voice.active ? ' active' : ''}`} aria-label={voiceLabel} aria-pressed={voice.visible} onClick={voice.open}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.08 9.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.33 1.84.56 2.8.69A2 2 0 0 1 22 16.92Z" /></svg><span>{voice.active ? 'Ongoing' : 'Call Davo'}</span></button>}{serverTargets}{clientSettings && <ClientSettingsMenu settings={clientSettings} />}</div>;
}

function Login({ done, initialError }: { done: (session: SessionInfo) => void; initialError?: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!response.ok) return setError('Invalid credentials');
    const session = await response.json() as SessionInfo;
    csrf = session.csrfToken;
    setPassword('');
    done(session);
  };
  return <main className="auth-screen"><div className="auth-glow" /><form className="auth-card" onSubmit={login}><div className="auth-mark" aria-hidden="true"><span>&gt;_</span></div><div className="auth-heading"><ServerSwitcher className="auth-server-switcher" /><p>REMOTE // AGENTS</p><h1>Console access</h1></div><label className="sr-only">Username<input type="text" name="username" autoComplete="username" tabIndex={-1} /></label><label>Password<input autoFocus type="password" name="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="auth-submit">Authenticate <span aria-hidden="true">↗</span></button></form></main>;
}

function LoadingScreen({ label = 'Restoring secure session' }: { label?: string }) {
  return <main className="auth-screen loading-screen" aria-live="polite"><div className="auth-glow" /><div className="loading-console"><div className="loading-line"><span className="spinner" />{label}</div><div className="loading-bars" aria-hidden="true"><i /><i /><i /><i /><i /></div></div></main>;
}

function ReconnectingOverlay() {
  return <div className="reconnecting-overlay" role="alert" aria-label="Reconnecting to console"><div className="auth-glow" /><div className="loading-console"><div className="loading-line"><span className="spinner" />Reconnecting to console</div><div className="loading-bars" aria-hidden="true"><i /><i /><i /><i /><i /></div></div></div>;
}

function ControlScreen({ session, claimed }: { session: SessionInfo; claimed: (next: SessionInfo) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const needsName = session.deviceName === undefined;
  const namingOnly = session.active && needsName;
  const takeControl = async () => {
    if (pending || (needsName && !deviceName.trim())) return;
    setPending(true); setError('');
    try {
      const response = await request('/api/auth/take-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(needsName ? { deviceName } : {}) });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Unable to take control. Try again.');
      }
      claimed(await response.json() as SessionInfo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to take control. Try again.');
      setPending(false);
    }
  };
  const controller = session.controllingDeviceName ?? 'Another device';
  return <main className="auth-screen loading-screen" aria-live="polite"><div className="auth-glow" /><section className="loading-console console-recovery"><ServerSwitcher className="auth-server-switcher" /><strong className={namingOnly ? undefined : 'control-owner'}>{namingOnly ? 'Name this device.' : `${controller} is active`}</strong>{namingOnly && <span>Give this device a name before continuing.</span>}{needsName && <label>Device name<input autoFocus type="text" value={deviceName} maxLength={64} autoComplete="nickname" placeholder="e.g. Kitchen iPad" onChange={event => setDeviceName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && deviceName.trim()) void takeControl(); }} /></label>}{error && <span className="auth-error" role="alert">{error}</span>}<button type="button" disabled={pending || (needsName && !deviceName.trim())} onClick={() => void takeControl()}>{pending ? <><span className="spinner" />{namingOnly ? 'Saving name' : 'Taking control'}</> : namingOnly ? 'Save device name' : 'Take control'}</button><NotificationControl /></section></main>;
}

class ConsoleBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="auth-screen loading-screen" role="alert"><div className="auth-glow" /><section className="loading-console console-recovery"><strong>Console needs to reconnect</strong><span>The interface hit a temporary problem.</span><button type="button" onClick={() => location.reload()}>Reload console</button></section></main>;
  }
}

// define state-specific power actions
type AgentPowerMenuProps = { pending: boolean; onTurnOff: () => void } & ({ mode: 'active'; onRestart: () => void; onClear: () => void; onSleep: () => void } | { mode: 'sleeping'; onWake: () => void });
// render configured-agent power choices
function AgentPowerMenu(props: AgentPowerMenuProps) {
  const { pending, onTurnOff } = props;
  const [open, setOpen] = useState(false);
  const { anchorRef, flyoutRef, style } = useViewportFlyout(open);
  // choose one power action
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  // limit sleeping tabs to wake and shutdown
  const stateActions = props.mode === 'sleeping'
    ? <button type="button" role="menuitem" onClick={() => choose(props.onWake)}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z" /></svg>Wake up</button>
    : <><button type="button" role="menuitem" onClick={() => choose(props.onRestart)}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.3-5.7L20 7.6M20 3v4.6h-4.6" /></svg>Restart</button><button type="button" role="menuitem" onClick={() => choose(props.onClear)}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 15 8-8 5 5-8 8H4v-5Zm7-7 5 5M10 20h10" /></svg>Clear</button><button type="button" role="menuitem" onClick={() => choose(props.onSleep)}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 15.5A8 8 0 0 1 8.5 5 8 8 0 1 0 19 15.5Z" /></svg>Sleep</button></>;
  return <><span className="power-menu-wrap" ref={anchorRef}><button className="danger icon-button deactivate-agent" disabled={pending} aria-label="Agent power options" aria-expanded={open} aria-haspopup="menu" title="Agent power options" onClick={() => setOpen(current => !current)}>{pending ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9m5.7-5.7a8 8 0 1 1-11.4 0" /></svg>}</button></span>{open && <FlyoutPortal onDismiss={() => setOpen(false)}><div className="more-menu flyout-menu agent-power-menu" ref={flyoutRef} style={style} role="menu" aria-label="Agent power options">{stateActions}<button className="agent-power-off" type="button" role="menuitem" onClick={() => choose(onTurnOff)}><svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9m5.7-5.7a8 8 0 1 1-11.4 0" /></svg>Turn off</button></div></FlyoutPortal>}</>;
}

// render reusable mobile terminal controls
function MobileTerminalKeys({ id }: { id: string }) {
  const [ctrlActive, setCtrlActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  useEffect(() => {
    mobileModifiers.set(id, { alt: altActive, ctrl: ctrlActive, shift: shiftActive });
    return () => { mobileModifiers.delete(id); };
  }, [id, altActive, ctrlActive, shiftActive]);
  // toggle one sticky modifier
  const toggleModifier = (name: 'alt'|'ctrl'|'shift') => {
    const setters = { alt: setAltActive, ctrl: setCtrlActive, shift: setShiftActive };
    const current = mobileModifiers.get(id) ?? { alt: false, ctrl: false, shift: false };
    mobileModifiers.set(id, { ...current, [name]: !current[name] });
    setters[name](value => !value);
  };
  // send one mobile key sequence
  const mobileKey = (key: 'tab'|'up'|'down'|'left'|'right'|'dollar'|'slash') => {
    const { alt, ctrl, shift } = mobileModifiers.get(id) ?? { alt: false, ctrl: false, shift: false };
    const arrows = { up: 'A', down: 'B', right: 'C', left: 'D' };
    let value = key === 'tab' ? (shift ? '\x1b[Z' : '\t') : key === 'dollar' ? '$' : key === 'slash' ? '/' : (ctrl || shift || alt ? `\x1b[1;${ctrl && shift ? 6 : ctrl && alt ? 7 : shift && alt ? 4 : ctrl ? 5 : shift ? 2 : 3}${arrows[key]}` : `\x1b[${arrows[key]}`);
    // prefix modified printable keys
    if (alt && (key === 'dollar' || key === 'slash' || key === 'tab')) value = `\x1b${value}`;
    terminalInputs.get(id)?.(value);
  };
  // send one direct control character
  const mobileControl = (value: '\x1b'|'\x03') => { terminalInputs.get(id)?.(value); };
  return <div className="mobile-terminal-keys" aria-label="Terminal keys"><div className="mobile-control-keys"><button type="button" aria-label="Esc" onPointerDown={event => { event.preventDefault(); mobileControl('\x1b'); }}>Esc</button><button type="button" aria-label="Ctrl+C" onPointerDown={event => { event.preventDefault(); mobileControl('\x03'); }}>Ctrl+C</button></div><div className="mobile-key-modifiers"><button type="button" aria-label="Tab" onPointerDown={event => { event.preventDefault(); mobileKey('tab'); }}>Tab</button><button type="button" className={shiftActive ? 'active' : ''} aria-pressed={shiftActive} onPointerDown={event => { event.preventDefault(); toggleModifier('shift'); }}>Shift</button><button type="button" className={ctrlActive ? 'active' : ''} aria-pressed={ctrlActive} onPointerDown={event => { event.preventDefault(); toggleModifier('ctrl'); }}>Ctrl</button><button type="button" className={altActive ? 'active' : ''} aria-pressed={altActive} onPointerDown={event => { event.preventDefault(); toggleModifier('alt'); }}>Alt</button></div><div className="mobile-arrow-keys"><button type="button" aria-label="Slash" onPointerDown={event => { event.preventDefault(); mobileKey('slash'); }}>/</button><button type="button" aria-label="Up arrow" onPointerDown={event => { event.preventDefault(); mobileKey('up'); }}><MobileKeyIcon name="up" /></button><button type="button" aria-label="Dollar" onPointerDown={event => { event.preventDefault(); mobileKey('dollar'); }}>$</button><button type="button" aria-label="Left arrow" onPointerDown={event => { event.preventDefault(); mobileKey('left'); }}><MobileKeyIcon name="left" /></button><button type="button" aria-label="Down arrow" onPointerDown={event => { event.preventDefault(); mobileKey('down'); }}><MobileKeyIcon name="down" /></button><button type="button" aria-label="Right arrow" onPointerDown={event => { event.preventDefault(); mobileKey('right'); }}><MobileKeyIcon name="right" /></button></div></div>;
}

// render the agent prompt controls
function Prompt({ id, history, onHistoryChanged, canCancel, cancelling, deleting, restarting, clearing, deactivating, sleeping, swapping, swapped, onCancel, onDelete, onRestart, onClear, onDeactivate, onSleep, onSwap, onSelectTarget, onPromptFocus, onOperationFeedback, projectUrl, browserOpen, onBrowserToggle, question, worktreeId, newTaskConfigured, pushAction, stack, review }: { id: string; history: PromptHistoryEntry[]; onHistoryChanged: () => Promise<void>; canCancel: boolean; cancelling: boolean; deleting: boolean; restarting: boolean; clearing: boolean; deactivating: boolean; sleeping: boolean; swapping: boolean; swapped: boolean; onCancel: () => void; onDelete?: () => void; onRestart?: () => void; onClear?: () => void; onDeactivate?: () => void; onSleep?: () => void; onSwap: () => void; onSelectTarget: (target: DashboardTarget) => void; onPromptFocus: () => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void; projectUrl?: string; browserOpen?: boolean; onBrowserToggle?: () => void; question?: ChoiceQuestion; worktreeId?: string; newTaskConfigured?: boolean; pushAction?: PromptAction; stack?: Stack; review?: ReviewButtonState }) {
  const [value, setValue] = usePromptDraft(id);
  const [commandToken, setCommandToken] = useState<CommandToken>();
  const [activeCommand, setActiveCommand] = useState(0);
  const [promptCommands, setPromptCommands] = useState<PromptCommand[]>([]);
  const pendingKey = `prompt:${id}`;
  const pending = usePendingOperation(pendingKey);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [savedPromptsOpen, setSavedPromptsOpen] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [savedConfirmation, setSavedConfirmation] = useState(false);
  const [savedPromptAction, setSavedPromptAction] = useState<{ id: string; kind: 'delete' | 'restore' | 'send' }>();
  const [savedPromptError, setSavedPromptError] = useState<string>();
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [queuedPromptsOpen, setQueuedPromptsOpen] = useState(false);
  const [queuedPromptAction, setQueuedPromptAction] = useState<{ id: string; kind: 'cancel' | 'edit' | 'move' | 'save' }>();
  const [queuedPromptEdit, setQueuedPromptEdit] = useState<{ id: string; text: string }>();
  const [queuedPromptError, setQueuedPromptError] = useState<string>();
  const savedConfirmationTimer = useRef<number | undefined>(undefined);
  const copiedSelectionTimer = useRef<number | undefined>(undefined);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const promptInput = useRef<HTMLTextAreaElement | null>(null);
  const promptSelection = useRef<number | undefined>(undefined);
  const historyIndex = useRef<number | undefined>(undefined);
  const historyDraft = useRef('');
  const focusPromptAtEnd = useRef(false);
  const { anchorRef: savedPromptAnchorRef, flyoutRef: savedPromptFlyoutRef, style: savedPromptFlyoutStyle } = useViewportFlyout(savedPromptsOpen);
  const { anchorRef: queuedPromptAnchorRef, flyoutRef: queuedPromptFlyoutRef, style: queuedPromptFlyoutStyle } = useViewportFlyout(queuedPromptsOpen);
  const { anchorRef: commandAnchorRef, flyoutRef: commandFlyoutRef, style: commandFlyoutStyle } = useViewportFlyout<HTMLDivElement>(commandToken !== undefined, { placement: 'above', matchAnchorWidth: true });
  const commandOptions = commandToken === undefined ? [] : promptCommands.filter(command => command.value.startsWith(commandToken.prefix) && command.value.slice(1).toLocaleLowerCase().includes(commandToken.query.toLocaleLowerCase()));
  useEffect(() => { historyIndex.current = undefined; historyDraft.current = ''; }, [id]);
  useEffect(() => {
    let cancelled = false;
    setPromptCommands([]);
    void request(`/api/agents/${encodeURIComponent(id)}/commands`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled || payload === null || typeof payload !== 'object' || !Array.isArray((payload as { commands?: unknown }).commands)) return;
      const catalog = (payload as { commands: unknown[] }).commands.flatMap(command => {
        if (command === null || typeof command !== 'object') return [];
        const { value, description } = command as { value?: unknown; description?: unknown };
        return typeof value === 'string' && validCommandValue.test(value) ? [{ value, ...(typeof description === 'string' ? { description } : {}) }] : [];
      });
      setPromptCommands(catalog);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [id]);
  const refreshQueuedPrompts = useCallback(async () => {
    const response = await request(`/api/agents/${encodeURIComponent(id)}/queued-prompts`);
    if (!response.ok) return;
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { prompts?: unknown }).prompts)) return;
    const prompts = (payload as { prompts: unknown[] }).prompts.filter(isQueuedPrompt);
    if (prompts.length !== (payload as { prompts: unknown[] }).prompts.length) return;
    setQueuedPrompts(prompts);
    if (prompts.length === 0) setQueuedPromptsOpen(false);
  }, [id]);
  useEffect(() => {
    setQueuedPrompts([]);
    setQueuedPromptsOpen(false);
    setQueuedPromptEdit(undefined);
    return pollWhileVisible(refreshQueuedPrompts, 2_000, true, 15_000);
  }, [refreshQueuedPrompts]);
  useEffect(() => {
    let cancelled = false;
    void request(`/api/agents/${encodeURIComponent(id)}/saved-prompts`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled || payload === null || typeof payload !== 'object' || !Array.isArray((payload as { prompts?: unknown }).prompts)) return;
      setSavedPrompts((payload as { prompts: unknown[] }).prompts.filter(isSavedPrompt));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [id]);
  useEffect(() => () => {
    if (savedConfirmationTimer.current !== undefined) window.clearTimeout(savedConfirmationTimer.current);
    if (copiedSelectionTimer.current !== undefined) window.clearTimeout(copiedSelectionTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (!focusPromptAtEnd.current) return;
    focusPromptAtEnd.current = false;
    const input = promptInput.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [value]);
  useLayoutEffect(() => {
    const input = promptInput.current;
    if (input !== null) fitPromptInput(input);
  }, [value]);
  // restore controlled-input selection
  useLayoutEffect(() => {
    const cursor = promptSelection.current;
    const input = promptInput.current;
    promptSelection.current = undefined;
    // apply only requested live selections
    if (cursor !== undefined && input !== null) {
      input.focus();
      input.setSelectionRange(cursor, cursor);
    }
  }, [value]);
  useLayoutEffect(() => {
    const input = promptInput.current;
    const composer = input?.parentElement;
    if (input === null || input === undefined || composer === null || composer === undefined) return;
    let width = composer.clientWidth;
    const observer = new ResizeObserver(() => {
      if (composer.clientWidth === width) return;
      width = composer.clientWidth;
      fitPromptInput(input);
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionInstance | undefined>(undefined);
  const voiceHoldTimer = useRef<number | undefined>(undefined);
  const voiceHoldPointer = useRef<number | undefined>(undefined);
  const voiceHoldStarted = useRef(false);
  const voiceEnabled = useRef(false);
  const voiceRestartTimer = useRef<number | undefined>(undefined);
  const promptValue = useRef(value);
  promptValue.current = value;
  const speechPrefix = useRef('');
  const speechSegments = useRef(new Map<number, string>());
  const speechWindow = window as Window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
  const supportsSpeechRecognition = speechWindow.SpeechRecognition !== undefined || speechWindow.webkitSpeechRecognition !== undefined;
  useEffect(() => () => {
    if (voiceHoldTimer.current !== undefined) window.clearTimeout(voiceHoldTimer.current);
    if (voiceRestartTimer.current !== undefined) window.clearTimeout(voiceRestartTimer.current);
    voiceEnabled.current = false;
    recognition.current?.abort();
  }, []);
  const chooseAttachments = (files: FileList | File[] | null) => {
    if (!files) return;
    const next = [...attachments, ...Array.from(files)];
    if (next.length > maxAttachments) return setAttachmentError(`Attach up to ${maxAttachments} files.`);
    if (next.reduce((total, file) => total + file.size, 0) > maxAttachmentBytes) return setAttachmentError(`Attachments must total ${maxAttachmentMegabytes} MB or less.`);
    setAttachmentError(undefined);
    setAttachments(next);
  };
  const pasteAttachments = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items).flatMap((item, index) => {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) return [];
      const image = item.getAsFile();
      if (image === null) return [];
      const subtype = image.type.slice('image/'.length).toLowerCase();
      const extension = subtype === 'jpeg' ? 'jpg' : /^[a-z0-9]+$/u.test(subtype) ? subtype : 'png';
      const name = image.name || `pasted-image-${index + 1}.${extension}`;
      return [new File([image], name, { type: image.type, lastModified: image.lastModified })];
    });
    if (images.length === 0) return;
    event.preventDefault();
    chooseAttachments(images);
  };
  const flashCopiedPromptSelection = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const input = event.currentTarget;
    if (input.selectionStart === input.selectionEnd) return;
    input.classList.add('selection-copied');
    if (copiedSelectionTimer.current !== undefined) window.clearTimeout(copiedSelectionTimer.current);
    copiedSelectionTimer.current = window.setTimeout(() => {
      copiedSelectionTimer.current = undefined;
      input.classList.remove('selection-copied');
    }, selectionCopyFlashMs);
  };
  const stopVoice = () => {
    voiceEnabled.current = false;
    if (voiceRestartTimer.current !== undefined) window.clearTimeout(voiceRestartTimer.current);
    voiceRestartTimer.current = undefined;
    recognition.current?.abort();
    recognition.current = undefined;
    setListening(false);
  };
  const submit = async () => {
    if (pending || (!swapped && !value && attachments.length === 0)) return;
    stopVoice();
    if (swapped) {
      const sendTerminalInput = terminalInputs.get(id);
      if (sendTerminalInput === undefined) return;
      sendTerminalInput(`${value}\r`);
      setValue('');
      return;
    }
    if (!beginPendingOperation(pendingKey)) return;
    const submittedValue = value;
    const submittedAttachments = attachments;
    const restoreSubmission = () => {
      setValue(current => submittedValue ? current ? `${submittedValue}\n\n${current}` : submittedValue : current);
      setAttachments(current => [...submittedAttachments, ...current]);
    };
    historyIndex.current = undefined;
    historyDraft.current = '';
    setValue('');
    setAttachments([]);
    setCommandToken(undefined);
    setAttachmentError(undefined);
    try {
      const payload = await Promise.all(submittedAttachments.map(encodeAttachment));
      const response = await request(`/api/agents/${encodeURIComponent(id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: submittedValue, attachments: payload }) });
      if (!response.ok) {
        restoreSubmission();
        setAttachmentError('Unable to queue the prompt with these attachments.');
      } else {
        // release the composer after acceptance
        void Promise.all([onHistoryChanged(), refreshQueuedPrompts()]).catch(() => {});
      }
    } catch {
      restoreSubmission();
      setAttachmentError('Unable to read the selected attachments.');
    }
    finally { setPendingOperation(pendingKey, false); }
  };
  const saveCurrentPrompt = async () => {
    if (pending || savingPrompt || (!value.trim() && attachments.length === 0)) return;
    stopVoice();
    setSavingPrompt(true);
    setSavedPromptError(undefined);
    try {
      const payload = await Promise.all(attachments.map(encodeAttachment));
      const response = await request(`/api/agents/${encodeURIComponent(id)}/saved-prompts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: value, attachments: payload }) });
      if (!response.ok) throw new Error();
      const saved = await response.json() as unknown;
      if (!isSavedPrompt(saved)) throw new Error();
      setSavedPrompts(current => [saved, ...current]);
      setValue('');
      setAttachments([]);
      setAttachmentError(undefined);
      setCommandToken(undefined);
      setSavedConfirmation(true);
      if (savedConfirmationTimer.current !== undefined) window.clearTimeout(savedConfirmationTimer.current);
      savedConfirmationTimer.current = window.setTimeout(() => {
        savedConfirmationTimer.current = undefined;
        setSavedConfirmation(false);
      }, 1_600);
    } catch {
      setSavedPromptError('Unable to save this prompt and its attachments.');
    } finally {
      setSavingPrompt(false);
    }
  };
  const deleteSavedPrompt = async (saved: SavedPrompt) => {
    const response = await request(`/api/agents/${encodeURIComponent(id)}/saved-prompts/${encodeURIComponent(saved.id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error();
    const consumed = await response.json() as unknown;
    if (!isSavedPrompt(consumed)) throw new Error();
    setSavedPrompts(current => current.filter(prompt => prompt.id !== consumed.id));
    return consumed;
  };
  const useSavedPrompt = async (saved: SavedPrompt) => {
    if (pending || savedPromptAction !== undefined) return;
    const savedAttachments = saved.attachments ?? [];
    if (attachments.length + savedAttachments.length > maxAttachments) return setSavedPromptError(`Restore would exceed ${maxAttachments} attachments.`);
    if (attachments.reduce((total, file) => total + file.size, 0) + savedAttachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0) > maxAttachmentBytes) return setSavedPromptError(`Restore would exceed ${maxAttachmentMegabytes} MB of attachments.`);
    setSavedPromptAction({ id: saved.id, kind: 'restore' });
    setSavedPromptError(undefined);
    try {
      const consumed = await deleteSavedPrompt(saved);
      const restoredAttachments = (consumed.attachments ?? []).map(decodeAttachment);
      setSavedPromptsOpen(false);
      focusPromptAtEnd.current = true;
      if (consumed.text) setValue(current => current ? `${current}${/\s$/u.test(current) ? '' : '\n\n'}${consumed.text}` : consumed.text);
      setAttachments(current => [...current, ...restoredAttachments]);
      setAttachmentError(undefined);
    } catch {
      setSavedPromptError('Unable to restore this saved prompt.');
    } finally {
      setSavedPromptAction(undefined);
    }
  };
  const sendSavedPrompt = async (saved: SavedPrompt) => {
    if (pending || savedPromptAction !== undefined || !beginPendingOperation(pendingKey)) return;
    setSavedPromptAction({ id: saved.id, kind: 'send' });
    setSavedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/saved-prompts/${encodeURIComponent(saved.id)}/queue`, { method: 'POST' });
      if (!response.ok) throw new Error();
      setSavedPrompts(current => current.filter(prompt => prompt.id !== saved.id));
      setSavedPromptsOpen(false);
      await Promise.all([onHistoryChanged(), refreshQueuedPrompts()]);
    } catch {
      setSavedPromptError('Unable to queue this saved prompt.');
    } finally {
      setSavedPromptAction(undefined);
      setPendingOperation(pendingKey, false);
    }
  };
  const removeSavedPrompt = async (saved: SavedPrompt) => {
    if (pending || savedPromptAction !== undefined) return;
    setSavedPromptAction({ id: saved.id, kind: 'delete' });
    setSavedPromptError(undefined);
    try {
      await deleteSavedPrompt(saved);
      if (savedPrompts.length === 1) setSavedPromptsOpen(false);
    } catch {
      setSavedPromptError('Unable to delete this saved prompt.');
    } finally {
      setSavedPromptAction(undefined);
    }
  };
  const moveQueuedPrompt = async (queued: QueuedPrompt, direction: 'earlier' | 'later') => {
    if (queuedPromptAction !== undefined) return;
    setQueuedPromptAction({ id: queued.id, kind: 'move' });
    setQueuedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/queued-prompts/${encodeURIComponent(queued.id)}/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction }) });
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { prompts?: unknown }).prompts)) throw new Error();
      const prompts = (payload as { prompts: unknown[] }).prompts.filter(isQueuedPrompt);
      if (prompts.length !== (payload as { prompts: unknown[] }).prompts.length) throw new Error();
      setQueuedPrompts(prompts);
    } catch { setQueuedPromptError('Unable to reorder this queued prompt.'); }
    finally { setQueuedPromptAction(undefined); }
  };
  const cancelQueuedPrompt = async (queued: QueuedPrompt) => {
    if (queuedPromptAction !== undefined) return;
    setQueuedPromptAction({ id: queued.id, kind: 'cancel' });
    setQueuedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/queued-prompts/${encodeURIComponent(queued.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      setQueuedPrompts(current => {
        const remaining = current.filter(prompt => prompt.id !== queued.id);
        if (remaining.length === 0) setQueuedPromptsOpen(false);
        return remaining;
      });
      if (queuedPromptEdit?.id === queued.id) setQueuedPromptEdit(undefined);
    } catch { setQueuedPromptError('Unable to cancel this queued prompt.'); }
    finally { setQueuedPromptAction(undefined); }
  };
  const moveQueuedPromptToSaved = async (queued: QueuedPrompt) => {
    if (queuedPromptAction !== undefined) return;
    setQueuedPromptAction({ id: queued.id, kind: 'save' });
    setQueuedPromptError(undefined);
    setSavedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/queued-prompts/${encodeURIComponent(queued.id)}/save`, { method: 'POST' });
      if (!response.ok) throw new Error();
      const saved: unknown = await response.json();
      if (!isSavedPrompt(saved)) throw new Error();
      setSavedPrompts(current => [saved, ...current]);
      setQueuedPrompts(current => {
        const remaining = current.filter(prompt => prompt.id !== queued.id);
        if (remaining.length === 0) setQueuedPromptsOpen(false);
        return remaining;
      });
      if (queuedPromptEdit?.id === queued.id) setQueuedPromptEdit(undefined);
    } catch { setQueuedPromptError('Unable to save this queued prompt.'); }
    finally { setQueuedPromptAction(undefined); }
  };
  const saveQueuedPromptEdit = async (queued: QueuedPrompt) => {
    if (queuedPromptAction !== undefined || queuedPromptEdit?.id !== queued.id) return;
    setQueuedPromptAction({ id: queued.id, kind: 'edit' });
    setQueuedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/queued-prompts/${encodeURIComponent(queued.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: queuedPromptEdit.text }) });
      if (!response.ok) throw new Error();
      const updated: unknown = await response.json();
      if (!isQueuedPrompt(updated)) throw new Error();
      setQueuedPrompts(current => current.map(prompt => prompt.id === updated.id ? updated : prompt));
      setQueuedPromptEdit(undefined);
    } catch { setQueuedPromptError('Unable to edit this queued prompt.'); }
    finally { setQueuedPromptAction(undefined); }
  };
  // submit one numbered answer
  const answer = async (answerIndex: number) => {
    // require one current unanswered question
    if (question === undefined || pending || !beginPendingOperation(pendingKey)) return;
    try {
      // every inline question — structured or parsed — answers through one endpoint
      const response = await request(`/api/agents/${encodeURIComponent(id)}/question`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: question.id, index: answerIndex }) });
      // optimistically retire a parsed question the server will next report as gone
      if (response.ok && question.source !== 'structured') answeredQuestionActions.get(id)?.(question);
    } finally { setPendingOperation(pendingKey, false); }
  };
  const startVoice = () => {
    if (pending || !supportsSpeechRecognition || recognition.current !== undefined) return false;
    const Recognition = (speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition)!;
    const next = new Recognition();
    recognition.current = next;
    next.continuous = true;
    next.interimResults = true;
    next.lang = navigator.language;
    voiceEnabled.current = true;
    speechPrefix.current = promptValue.current;
    speechSegments.current.clear();
    next.onresult = event => {
      if (recognition.current !== next) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript.trim() ?? '';
        if (transcript) speechSegments.current.set(index, transcript);
        else speechSegments.current.delete(index);
      }
      const transcript = [...speechSegments.current.entries()].sort(([left], [right]) => left - right).reduce((combined, [, segment]) => mergeSpeechSegments(combined, segment), '');
      if (!transcript) return;
      const nextValue = `${speechPrefix.current}${speechPrefix.current && !/\s$/u.test(speechPrefix.current) ? ' ' : ''}${transcript}`;
      promptValue.current = nextValue;
      setValue(nextValue);
    };
    next.onend = () => {
      if (recognition.current !== next) return;
      recognition.current = undefined;
      if (!voiceEnabled.current) return setListening(false);
      voiceRestartTimer.current = window.setTimeout(() => {
        voiceRestartTimer.current = undefined;
        if (voiceEnabled.current && recognition.current === undefined) startVoice();
      });
    };
    next.onerror = event => {
      if (event.error !== undefined && event.error !== 'no-speech' && event.error !== 'aborted') voiceEnabled.current = false;
    };
    setListening(true);
    try { next.start(); }
    catch {
      voiceEnabled.current = false;
      recognition.current = undefined;
      setListening(false);
      return false;
    }
    return true;
  };
  const beginVoiceHold = (event: React.PointerEvent<HTMLTextAreaElement>) => {
    if (pending || !supportsSpeechRecognition || !event.isPrimary || event.button !== 0) return;
    if (voiceEnabled.current || listening) {
      event.preventDefault();
      stopVoice();
      return;
    }
    if (voiceHoldTimer.current !== undefined) window.clearTimeout(voiceHoldTimer.current);
    const pointerId = event.pointerId;
    voiceHoldPointer.current = pointerId;
    voiceHoldStarted.current = false;
    try { event.currentTarget.setPointerCapture(pointerId); } catch { /* Pointer capture may be unavailable in synthetic events. */ }
    voiceHoldTimer.current = window.setTimeout(() => {
      voiceHoldTimer.current = undefined;
      if (voiceHoldPointer.current === pointerId) voiceHoldStarted.current = startVoice();
    }, voiceHoldDelayMs);
  };
  const endVoiceHold = (event: React.PointerEvent<HTMLTextAreaElement>) => {
    if (voiceHoldPointer.current !== event.pointerId) return;
    if (voiceHoldTimer.current !== undefined) window.clearTimeout(voiceHoldTimer.current);
    voiceHoldTimer.current = undefined;
    voiceHoldPointer.current = undefined;
    if (voiceHoldStarted.current) {
      event.preventDefault();
    }
    voiceHoldStarted.current = false;
  };
  const cancelButton = <button className="danger icon-button cancel-agent" disabled={!canCancel || cancelling} aria-label="Cancel agent" title="Cancel agent" onClick={onCancel}>{cancelling ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>}</button>;
  const deleteButton = <button className="danger icon-button delete-agent" disabled={deleting} aria-label="Delete agent" title="Delete agent" onClick={onDelete}>{deleting ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-8 0 1 13h8l1-13" /></svg>}</button>;
  const powerMenu = onRestart === undefined || onClear === undefined || onDeactivate === undefined || onSleep === undefined ? null : <AgentPowerMenu mode="active" pending={restarting || clearing || deactivating || sleeping} onRestart={onRestart} onClear={onClear} onSleep={onSleep} onTurnOff={onDeactivate} />;
  const stop = powerMenu ?? (onDelete === undefined ? cancelButton : deleteButton);
  const swapLabel = swapped ? 'Return to agent output' : 'Swap to terminal';
  const swap = <button className={`swap-agent icon-button${swapped ? ' active' : ''}`} disabled={swapping} aria-label={swapLabel} title={swapped ? 'Return to agent output' : 'Background agent and show terminal'} onClick={onSwap}>{swapping ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h13m0 0-4-4m4 4-4 4M19 17H6m0 0 4 4m-4-4 4-4" /></svg>}</button>;
  const reviewButton = review === undefined ? null : <button className={`review-tour-toggle icon-button${review.generating ? ' generating' : ''}${review.stale ? ' stale' : ''}`} type="button" aria-label={review.generating ? 'Open generating guided review' : review.stale ? 'Open out-of-date guided review' : 'Open guided review'} aria-busy={review.generating} title={review.generating ? 'Guided review is generating' : review.stale ? 'Guided review is out of date' : 'Open guided review'} onClick={review.onOpen}>{review.generating ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2h8l5 5v4M5 2v20h8M13 2v6h5" /><circle cx="16.5" cy="16.5" r="3.5" /><path d="m19 19 3 3" /></svg>}</button>;
  const selectCommand = (command: PromptCommand) => {
    if (commandToken === undefined) return;
    const next = `${value.slice(0, commandToken.start)}${command.value}${value.slice(commandToken.end)}`;
    const cursor = commandToken.start + command.value.length;
    setValue(next);
    setCommandToken(undefined);
    window.requestAnimationFrame(() => { promptInput.current?.focus(); promptInput.current?.setSelectionRange(cursor, cursor); });
  };
  // insert text at the active selection
  const insertPromptText = (input: HTMLTextAreaElement, text: string) => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const cursor = start + text.length;
    const next = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
    // collapse unchanged replacements immediately
    if (next === input.value) {
      input.setSelectionRange(cursor, cursor);
      return;
    }
    promptSelection.current = cursor;
    setValue(next);
    setCommandToken(commandTokenAt(next, cursor));
    setActiveCommand(0);
  };
  const updatePrompt = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setValue(next);
    setCommandToken(commandTokenAt(next, event.target.selectionStart ?? next.length));
    setActiveCommand(0);
  };
  const recallPrompt = (direction: -1 | 1) => {
    if (history.length === 0) return;
    const current = historyIndex.current;
    if (direction < 0) {
      if (current === undefined) historyDraft.current = value;
      const next = current === undefined ? 0 : Math.min(history.length - 1, current + 1);
      historyIndex.current = next;
      setValue(history[next]!.text);
    } else {
      if (current === undefined) return;
      if (current === 0) {
        historyIndex.current = undefined;
        setValue(historyDraft.current);
      } else {
        historyIndex.current = current - 1;
        setValue(history[current - 1]!.text);
      }
    }
    setCommandToken(undefined);
    window.requestAnimationFrame(() => {
      const input = promptInput.current;
      if (input === null) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  const composer = <div className="prompt-composer" ref={commandAnchorRef}><textarea ref={promptInput} className={listening ? 'voice-listening' : undefined} aria-label="Prompt" aria-description={supportsSpeechRecognition ? 'Press and hold to start dictation. Tap again to stop.' : undefined} aria-autocomplete="list" aria-expanded={commandToken !== undefined} aria-controls={commandToken === undefined ? undefined : `prompt-commands-${id}`} aria-activedescendant={commandOptions[activeCommand] === undefined ? undefined : `prompt-command-${id}-${activeCommand}`} value={value} onFocus={() => { exitTerminalInput.get(id)?.(); onPromptFocus(); }} onBlur={() => setCommandToken(undefined)} onCopy={flashCopiedPromptSelection} onPaste={pasteAttachments} onPointerDown={beginVoiceHold} onPointerUp={endVoiceHold} onPointerCancel={endVoiceHold} onLostPointerCapture={endVoiceHold} onContextMenu={event => { if (voiceHoldStarted.current) event.preventDefault(); }} onKeyDown={event => { const plainArrow = !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey; if (commandOptions.length > 0 && plainArrow && event.key === 'ArrowDown') { event.preventDefault(); setActiveCommand(current => (current + 1) % commandOptions.length); } else if (commandOptions.length > 0 && plainArrow && event.key === 'ArrowUp') { event.preventDefault(); setActiveCommand(current => (current + commandOptions.length - 1) % commandOptions.length); } else if (commandOptions.length > 0 && plainArrow && event.key === 'Enter') { event.preventDefault(); selectCommand(commandOptions[activeCommand] ?? commandOptions[0]!); } else if (plainArrow && event.key === 'ArrowUp' && (historyIndex.current !== undefined || event.currentTarget.selectionStart === event.currentTarget.selectionEnd && !value.slice(0, event.currentTarget.selectionStart).includes('\n'))) { event.preventDefault(); recallPrompt(-1); } else if (plainArrow && event.key === 'ArrowDown' && historyIndex.current !== undefined) { event.preventDefault(); recallPrompt(1); } else if (event.key === 'Escape' && commandToken !== undefined) { event.preventDefault(); setCommandToken(undefined); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveCurrentPrompt(); } else if (event.key === 'Tab') { event.preventDefault(); setValue(current => current + '\t'); } else if (event.key === 'Enter') { event.preventDefault(); /* insert line breaks at selection */ if (event.ctrlKey || event.shiftKey || window.matchMedia('(max-width: 600px)').matches) insertPromptText(event.currentTarget, '\n'); else void submit(); } }} onChange={updatePrompt} />{commandToken !== undefined && <FlyoutPortal onDismiss={() => setCommandToken(undefined)}><div ref={commandFlyoutRef} className="command-menu" style={commandFlyoutStyle} id={`prompt-commands-${id}`} role="listbox" aria-label={`${commandToken.prefix} commands`}>{commandOptions.length > 0 ? commandOptions.map((command, index) => <button key={command.value} id={`prompt-command-${id}-${index}`} type="button" role="option" aria-selected={index === activeCommand} className={index === activeCommand ? 'active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => selectCommand(command)}><code>{command.value}</code><span>{command.description}</span></button>) : <span className="command-menu-empty">No matching commands</span>}</div></FlyoutPortal>}</div>;
  const savedPanel = savedPromptsOpen && <FlyoutPortal onDismiss={() => setSavedPromptsOpen(false)}><section className="saved-prompts-panel more-menu flyout-menu" ref={savedPromptFlyoutRef} style={savedPromptFlyoutStyle} aria-label="Saved prompts"><header><strong>Saved prompts</strong></header><div className="saved-prompts-list">{savedPrompts.map(saved => { const label = saved.text || saved.attachments?.map(attachment => attachment.name).join(', ') || 'Attachments only'; return <div className="saved-prompt-item" key={saved.id}><button className="saved-prompt-restore" type="button" disabled={savedPromptAction !== undefined} title={label} onClick={() => void useSavedPrompt(saved)}>{savedPromptAction?.id === saved.id && savedPromptAction.kind === 'restore' ? <span className="spinner" /> : null}<span className="saved-prompt-copy"><span>{saved.text || 'Attachments only'}</span>{saved.attachments?.length ? <small>{saved.attachments.map(attachment => attachment.name).join(', ')}</small> : null}</span></button><span className="saved-prompt-actions"><button className="saved-prompt-send" type="button" disabled={savedPromptAction !== undefined} aria-label={`Queue saved draft: ${label}`} title="Queue saved draft" onClick={() => void sendSavedPrompt(saved)}>{savedPromptAction?.id === saved.id && savedPromptAction.kind === 'send' ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" /></svg>}</button><button className="saved-prompt-delete" type="button" disabled={savedPromptAction !== undefined} aria-label={`Delete saved draft: ${label}`} title="Delete saved draft" onClick={() => void removeSavedPrompt(saved)}>{savedPromptAction?.id === saved.id && savedPromptAction.kind === 'delete' ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6" /></svg>}</button></span></div>; })}</div></section></FlyoutPortal>;
  const savedToggle = savedPrompts.length > 0 ? <button className={`saved-prompts-toggle icon-button${savedPromptsOpen ? ' active' : ''}`} type="button" disabled={pending} aria-label={`Saved prompts (${savedPrompts.length})`} aria-expanded={savedPromptsOpen} title={`${savedPrompts.length} saved prompt${savedPrompts.length === 1 ? '' : 's'}`} onClick={() => setSavedPromptsOpen(open => !open)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg><span className="saved-prompts-count" aria-hidden="true">{savedPrompts.length}</span></button> : null;
  const saveLabel = savingPrompt ? 'Saving' : savedConfirmation ? 'Saved' : 'Save';
  const saveButton = <button className={`save-prompt outline-button icon-button${savedConfirmation ? ' saved' : ''}`} type="button" disabled={pending || savingPrompt || (!value.trim() && attachments.length === 0)} aria-label={saveLabel} title={saveLabel} onClick={() => void saveCurrentPrompt()}>{savingPrompt ? <span className="spinner" /> : savedConfirmation ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11l3 3v15H5V3Zm3 0v6h8V3M8 21v-7h8v7" /></svg>}</button>;
  const saveControls = <><span className={`save-prompt-group${savedToggle === null ? '' : ' has-saved-prompts'}`} ref={savedPromptAnchorRef} role="group" aria-label="Saved prompt controls">{saveButton}{savedToggle}</span>{savedPanel}</>;
  // render numbered answers
  if (question) return <section className="prompt question-prompt"><div className="question-copy"><strong>Agent question</strong><span>{question.text}</span></div><div className="question-choices">{question.choices.map(choice => <button key={`${choice.answerIndex}-${choice.label}`} className="question-choice" disabled={pending} onClick={() => void answer(choice.answerIndex)}><b aria-hidden="true">{choice.number}</b><span>{choice.label}</span></button>)}</div><div className="prompt-actions">{stop}{swapped && swap}<span className="prompt-actions-spacer" aria-hidden="true" />{reviewButton}<More id={id} worktreeId={worktreeId} newTaskConfigured={newTaskConfigured} pushAction={pushAction} swapDisabled={swapping} onSwap={swapped ? undefined : onSwap} onPromptQueued={onHistoryChanged} onSelectTarget={onSelectTarget} onOperationFeedback={onOperationFeedback} /></div></section>;
  const queueLabel = swapped ? 'Enter' : pending ? 'Queueing' : 'Queue';
  const queuePanel = queuedPromptsOpen && <FlyoutPortal onDismiss={() => setQueuedPromptsOpen(false)}><section className="queued-prompts-panel more-menu flyout-menu" ref={queuedPromptFlyoutRef} style={queuedPromptFlyoutStyle} aria-label="Queued prompts"><header><strong>Queued prompts</strong></header>{queuedPromptError && <p className="queued-prompt-error" role="alert">{queuedPromptError}</p>}<div className="queued-prompts-list">{queuedPrompts.map((queued, index) => { const label = queued.text || queued.attachments?.map(attachment => attachment.name).join(', ') || 'Attachments only'; const editing = queuedPromptEdit?.id === queued.id; const busy = queuedPromptAction !== undefined; return <div className={`queued-prompt-item${editing ? ' editing' : ''}`} key={queued.id}><span className="queued-prompt-order"><strong className="queued-prompt-position" aria-label={`Queue position ${index + 1}`}>{index + 1}</strong><span className="queued-prompt-order-buttons"><button type="button" disabled={busy || index === 0} aria-label={`Move queued prompt earlier: ${label}`} title="Move earlier" onClick={() => void moveQueuedPrompt(queued, 'earlier')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button type="button" disabled={busy || index === queuedPrompts.length - 1} aria-label={`Move queued prompt later: ${label}`} title="Move later" onClick={() => void moveQueuedPrompt(queued, 'later')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></span></span>{editing ? <textarea aria-label={`Edit queued prompt: ${label}`} value={queuedPromptEdit.text} maxLength={32_000} autoFocus onChange={event => setQueuedPromptEdit({ id: queued.id, text: event.target.value })} /> : <button className="queued-prompt-copy" type="button" disabled={busy} title={label} onClick={() => setQueuedPromptEdit({ id: queued.id, text: queued.text })}><span>{queued.text || 'Attachments only'}</span>{queued.attachments?.length ? <small>{queued.attachments.map(attachment => attachment.name).join(', ')}</small> : null}</button>}<span className="queued-prompt-actions">{editing ? <><button type="button" disabled={busy || !queuedPromptEdit.text.trim() && queued.attachments === undefined} aria-label={`Save queued prompt changes: ${label}`} title="Save changes" onClick={() => void saveQueuedPromptEdit(queued)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></button><button type="button" disabled={busy} aria-label={`Stop editing queued prompt: ${label}`} title="Stop editing" onClick={() => setQueuedPromptEdit(undefined)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></> : <button type="button" disabled={busy} aria-label={`Save queued prompt: ${label}`} title="Move to saved prompts" onClick={() => void moveQueuedPromptToSaved(queued)}>{queuedPromptAction?.id === queued.id && queuedPromptAction.kind === 'save' ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11l3 3v15H5V3Zm3 0v6h8V3M8 21v-7h8v7" /></svg>}</button>}<button className="queued-prompt-cancel" type="button" disabled={busy} aria-label={`Cancel queued prompt: ${label}`} title="Cancel queued prompt" onClick={() => void cancelQueuedPrompt(queued)}>{queuedPromptAction?.id === queued.id && queuedPromptAction.kind === 'cancel' ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-8 0 1 13h8l1-13" /></svg>}</button></span></div>; })}</div></section></FlyoutPortal>;
  const queuedToggle = !swapped && queuedPrompts.length > 0 ? <button className={`queued-prompts-toggle icon-button${queuedPromptsOpen ? ' active' : ''}`} type="button" disabled={pending} aria-label={`Queued prompts (${queuedPrompts.length})`} aria-expanded={queuedPromptsOpen} title={`${queuedPrompts.length} queued prompt${queuedPrompts.length === 1 ? '' : 's'}`} onClick={() => setQueuedPromptsOpen(open => !open)}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg><span className="saved-prompts-count queued-prompts-count" aria-hidden="true">{queuedPrompts.length}</span></button> : null;
  const queueControls = <><span className={`queue-prompt-group${queuedToggle === null ? '' : ' has-queued-prompts'}`} ref={queuedPromptAnchorRef} role="group" aria-label="Queue controls"><button className="queue icon-button" disabled={pending || (!swapped && !value && attachments.length === 0)} aria-label={queueLabel} title={queueLabel} onClick={() => void submit()}>{pending ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" /></svg>}</button>{queuedToggle}</span>{queuePanel}</>;
  return <section className="prompt">{composer}{attachments.length > 0 && <div className="prompt-attachments" aria-label="Selected attachments">{attachments.map((file, index) => <span key={`${file.name}-${index}`} title={file.name}>{file.name}<button type="button" disabled={pending} aria-label={`Remove ${file.name}`} onClick={() => setAttachments(current => current.filter((_, candidate) => candidate !== index))}>×</button></span>)}</div>}{attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}{savedPromptError && <p className="saved-prompt-error" role="alert">{savedPromptError}</p>}{queuedPromptError && !queuedPromptsOpen && <p className="queued-prompt-error" role="alert">{queuedPromptError}</p>}<input ref={attachmentInput} className="attachment-input" type="file" multiple onChange={event => { chooseAttachments(event.target.files); event.target.value = ''; }} /><div className="prompt-actions">{stop}{swapped && swap}<span className="prompt-actions-spacer" aria-hidden="true" />{reviewButton}<More id={id} worktreeId={worktreeId} newTaskConfigured={newTaskConfigured} pushAction={pushAction} attachDisabled={pending} onAttach={swapped ? undefined : () => attachmentInput.current?.click()} swapDisabled={swapping} onSwap={swapped ? undefined : onSwap} onPromptQueued={onHistoryChanged} onSelectTarget={onSelectTarget} onOperationFeedback={onOperationFeedback} /><ProjectOpen url={projectUrl} stack={stack} browserOpen={browserOpen} onBrowserToggle={onBrowserToggle} onStackAction={worktreeId === undefined ? undefined : action => request(`/api/worktrees/${encodeURIComponent(worktreeId)}/commands/${action}`, { method: 'POST' })} onStackLog={worktreeId === undefined ? undefined : () => stackLog(worktreeId)} />{saveControls}{queueControls}</div><MobileTerminalKeys id={id} /></section>;
}

type MobileKeyIconName = 'control'|'shift'|'tab'|'up'|'down'|'left'|'right';
function MobileKeyIcon({ name }: { name: MobileKeyIconName }) {
  const paths: Record<MobileKeyIconName, string> = { control: 'M8 5h8v4h3v6h-3v4H8v-4H5V9h3zm2 2v4H7v2h3v4h4v-4h3v-2h-3V7z', shift: 'm12 4 6 6h-4v8h-4v-8H6z', tab: 'M4 8h11m0 0-3-3m3 3-3 3M20 16H9m0 0 3 3m-3-3 3-3', up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6', left: 'm15 6-6 6 6 6', right: 'm9 6 6 6-6 6' };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

const isWorktreeNote = (value: unknown): value is WorktreeNote => value !== null && typeof value === 'object' && typeof (value as WorktreeNote).id === 'string' && typeof (value as WorktreeNote).text === 'string' && ((value as WorktreeNote).title === undefined || typeof (value as WorktreeNote).title === 'string');
// derive an assistant response title
const assistantNoteTitle = (text: string) => {
  const firstLine = text.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? 'Assistant response';
  const cleaned = firstLine.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, '').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/[*_`~]+/gu, '').trim() || 'Assistant response';
  const characters = Array.from(cleaned);
  return characters.length <= 80 ? cleaned : `${characters.slice(0, 79).join('').trimEnd()}…`;
};
// find the newest response substantial enough to save
const latestSubstantialResponse = (latestAssistantMessage: string | undefined, history: PromptHistoryEntry[]) => {
  const candidates = [...(latestAssistantMessage === undefined ? [] : [latestAssistantMessage]), ...history.flatMap(entry => entry.answer === undefined ? [] : [entry.answer])];
  return candidates.find(response => response.length <= 30_000 && response.trim().split(/\s+/u).filter(Boolean).length >= 50);
};
// resolve a note menu label
const noteName = (note: WorktreeNote) => note.title ?? notePreview(note.text);
const notePreview = (text: string) => {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return `${words.length === 0 ? 'Blank note' : words.slice(0, 6).join(' ')}…`;
};
const appendTextBlock = (current: string, text: string) => `${current}${current ? current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n' : ''}${text}`;
const bottomAlignedSnapshot = (value: string, rows: number) => {
  const renderedRows = value ? value.split('\n').length : 0;
  return `${'\n'.repeat(Math.max(0, rows - renderedRows))}${value}`;
};

// validate one referenced workspace file
const isAssistantFile = (value: unknown): value is AssistantFile => value !== null && typeof value === 'object'
  && typeof (value as AssistantFile).path === 'string'
  && Number.isInteger((value as AssistantFile).size)
  && (value as AssistantFile).size >= 0;
// validate one inline raster image
const isAssistantPreviewImage = (value: unknown): value is AssistantPreviewImage => value !== null && typeof value === 'object'
  && ((value as AssistantPreviewImage).mediaType === 'image/gif' || (value as AssistantPreviewImage).mediaType === 'image/jpeg' || (value as AssistantPreviewImage).mediaType === 'image/png' || (value as AssistantPreviewImage).mediaType === 'image/webp')
  && typeof (value as AssistantPreviewImage).base64 === 'string'
  && /^[A-Za-z0-9+/]*={0,2}$/u.test((value as AssistantPreviewImage).base64);
// validate one bounded workspace preview
const isAssistantFilePreview = (value: unknown): value is AssistantFilePreview => isAssistantFile(value)
  && typeof (value as AssistantFilePreview).binary === 'boolean'
  && typeof (value as AssistantFilePreview).truncated === 'boolean'
  && ((value as AssistantFilePreview).binary
    ? (value as { content?: unknown }).content === undefined && ((value as { image?: unknown }).image === undefined || isAssistantPreviewImage((value as { image?: unknown }).image))
    : typeof (value as { content?: unknown }).content === 'string' && (value as { image?: unknown }).image === undefined);
// render one explicit file-preview state
const filePreviewContent = (path: string, state: FilePreviewState, preview?: AssistantFilePreview): ReactNode => {
  // show pending requests
  if (state === 'loading') return <div className="response-file-message" role="status"><span className="spinner" />Loading preview…</div>;
  // show failed requests
  if (state === 'error' || preview === undefined) return <div className="response-file-message error" role="alert">Preview unavailable</div>;
  // show supported raster images
  if (preview.binary && preview.image !== undefined) return <div className="response-file-image"><img src={`data:${preview.image.mediaType};base64,${preview.image.base64}`} alt={`Preview of ${path}`} /></div>;
  // explain unsupported binary files
  if (preview.binary) return <div className="response-file-message">Binary file preview unavailable</div>;
  return <SyntaxHighlightedCode path={path} code={preview.content} label={`Contents of ${path}`} />;
};
// format compact file sizes
const assistantFileSize = (size: number) => size < 1_024 ? `${size} B` : size < 1_048_576 ? `${(size / 1_024).toFixed(1)} KB` : `${(size / 1_048_576).toFixed(1)} MB`;

// manage one workspace file preview
function useFilePreview(previewUrl: string) {
  const [previewPath, setPreviewPath] = useState<string>();
  const [preview, setPreview] = useState<AssistantFilePreview>();
  const [previewState, setPreviewState] = useState<FilePreviewState>('loading');
  const [copied, setCopied] = useState(false);
  const previewRequest = useRef(0);

  // reset when the workspace target changes
  useEffect(() => {
    setPreviewPath(undefined);
    setPreview(undefined);
    previewRequest.current += 1;
  }, [previewUrl]);
  // load one selected file preview
  const openFile = async (path: string) => {
    const requestId = ++previewRequest.current;
    setPreviewPath(path);
    setPreview(undefined);
    setPreviewState('loading');
    setCopied(false);
    try {
      const response = await request(previewUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
      if (!response.ok) throw new Error('preview unavailable');
      const payload: unknown = await response.json();
      if (!isAssistantFilePreview(payload)) throw new Error('invalid preview');
      // ignore replaced or closed previews
      if (previewRequest.current !== requestId) return;
      setPreviewPath(payload.path);
      setPreview(payload);
      setPreviewState('ready');
    } catch { if (previewRequest.current === requestId) setPreviewState('error'); }
  };
  // close the active file preview
  const closePreview = () => {
    previewRequest.current += 1;
    setPreviewPath(undefined);
    setPreview(undefined);
    setCopied(false);
  };
  // copy the canonical workspace path
  const copyPath = async () => {
    if (previewPath === undefined) return;
    try { await copyText(previewPath); setCopied(true); } catch { setCopied(false); }
  };

  const dialog = previewPath === undefined ? null : createPortal(<div className="dialog response-file-dialog" role="dialog" aria-modal="true" aria-label={`File preview: ${previewPath}`} onKeyDown={event => { if (event.key === 'Escape') closePreview(); }}><div><header><strong title={previewPath}>{previewPath}</strong><button className="response-file-copy-path" type="button" onClick={() => void copyPath()}>{copied ? 'Path copied' : 'Copy path'}</button><button type="button" aria-label="Close file preview" title="Close" onClick={closePreview}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>{filePreviewContent(previewPath, previewState, preview)}{preview?.truncated && <footer>Preview limited to the first 256 KB.</footer>}</div></div>, document.body);
  return { dialog, openFile, closePreview };
}

// manage files referenced by the latest assistant response
function useLatestAssistantFiles(agentId: string, message?: string) {
  const [files, setFiles] = useState<AssistantFile[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const { anchorRef, flyoutRef, style: flyoutStyle } = useViewportFlyout<HTMLDivElement>(menuOpen, { placement: 'left', boundarySelector: '.log', boundaryRootSelector: '.agent-view', contentSized: true });
  const filePreview = useFilePreview(`/api/agents/${encodeURIComponent(agentId)}/file-preview`);

  useEffect(() => {
    let cancelled = false;
    setFiles([]);
    setMenuOpen(false);
    filePreview.closePreview();
    // ignore sessions without a completed response
    if (message === undefined) return () => { cancelled = true; };
    void request(`/api/agents/${encodeURIComponent(agentId)}/message-files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) }).then(async response => {
      // reject malformed list responses
      if (!response.ok) throw new Error('file list unavailable');
      const payload: unknown = await response.json();
      if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { files?: unknown }).files) || !(payload as { files: unknown[] }).files.every(isAssistantFile)) throw new Error('invalid file list');
      if (!cancelled) setFiles((payload as { files: AssistantFile[] }).files);
    }).catch(() => {
      // hide unavailable response files
      if (!cancelled) setFiles([]);
    });
    return () => { cancelled = true; };
  }, [agentId, message]);

  const label = `Files from latest response (${files.length})`;
  const control = files.length === 0 ? null : <div className="response-files-control" ref={anchorRef}><button className={`log-control page-arrow response-files-toggle${menuOpen ? ' active' : ''}`} type="button" aria-label={label} title={label} aria-expanded={menuOpen} onPointerDown={event => event.preventDefault()} onClick={() => setMenuOpen(open => !open)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 12 5.7-5.7a3.5 3.5 0 1 1 5 5L11 20a5 5 0 1 1-7-7l8.3-8.3" /></svg><span className="saved-prompts-count response-files-count" aria-hidden="true">{files.length}</span></button>{menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div ref={flyoutRef} className="response-files-menu" style={flyoutStyle} aria-label="Files from latest response">{files.map(file => <button className="log-control" type="button" key={file.path} title={file.path} onClick={() => { setMenuOpen(false); void filePreview.openFile(file.path); }}><span>{file.path}</span><small>{assistantFileSize(file.size)}</small></button>)}</div></FlyoutPortal>}</div>;
  return { control, ...filePreview };
}

// format one saved bookmark time
const bookmarkDate = (createdAt: string) => {
  const date = new Date(createdAt);
  // fall back for malformed legacy data
  if (!Number.isFinite(date.getTime())) return 'Saved chat';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
};

// resolve one configured or scratch persistence API
function persistenceResourceBase(worktreeId?: string, agentId?: string): string | undefined {
  // prefer stable configured worktree storage
  if (worktreeId !== undefined) return `/api/worktrees/${encodeURIComponent(worktreeId)}`;
  // fall back to one live scratch agent
  if (agentId !== undefined) return `/api/agents/${encodeURIComponent(agentId)}`;
  return undefined;
}

// manage shared Codex chat bookmarks
function useWorktreeBookmarks(worktreeId?: string, agentId?: string) {
  const [bookmarks, setBookmarks] = useState<CodexBookmark[]>();
  const [canResume, setCanResume] = useState(false);
  const [currentBookmarkId, setCurrentBookmarkId] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [switchingId, setSwitchingId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState<{ id: string; title: string }>();
  const [renamingId, setRenamingId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [error, setError] = useState('');
  const loadGeneration = useRef(0);
  const resourceBase = persistenceResourceBase(worktreeId, agentId);
  const lifecycleSwitching = usePendingOperation(restartOperationKey(worktreeId ?? 'unavailable'));
  const { anchorRef, flyoutRef, style: flyoutStyle } = useViewportFlyout<HTMLDivElement>(menuOpen, { placement: 'left', boundarySelector: '.log', boundaryRootSelector: '.agent-view, .worktree-view', contentSized: true });

  // reset state between bookmark contexts
  useEffect(() => {
    setBookmarks(undefined);
    setCanResume(false);
    setCurrentBookmarkId(undefined);
    setMenuOpen(false);
    setLoading(false);
    setSaving(false);
    setSwitchingId(undefined);
    setRenameDraft(undefined);
    setRenamingId(undefined);
    setDeletingId(undefined);
    setError('');
  }, [agentId, worktreeId]);

  // load one shared bookmark group
  const load = useCallback(async () => {
    // require one persistence context
    if (resourceBase === undefined) return undefined;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError('');
    try {
      const query = worktreeId === undefined || agentId === undefined ? '' : `?agentId=${encodeURIComponent(agentId)}`;
      const response = await request(`${resourceBase}/bookmarks${query}`);
      // require a successful list response
      if (!response.ok) throw new Error('bookmark list unavailable');
      const payload: unknown = await response.json();
      // validate every bookmark
      if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { bookmarks?: unknown }).bookmarks) || !(payload as { bookmarks: unknown[] }).bookmarks.every(isCodexBookmark) || typeof (payload as { canResume?: unknown }).canResume !== 'boolean' || ((payload as { currentBookmarkId?: unknown }).currentBookmarkId !== undefined && typeof (payload as { currentBookmarkId?: unknown }).currentBookmarkId !== 'string')) throw new Error('invalid bookmark list');
      const loaded = (payload as { bookmarks: CodexBookmark[] }).bookmarks;
      const currentId = (payload as { currentBookmarkId?: string }).currentBookmarkId;
      // require the selected bookmark to exist in the group
      if (currentId !== undefined && !loaded.some(bookmark => bookmark.id === currentId)) throw new Error('invalid current bookmark');
      // ignore a superseded worktree load
      if (generation !== loadGeneration.current) return undefined;
      setBookmarks(loaded);
      setCanResume((payload as { canResume: boolean }).canResume);
      setCurrentBookmarkId(currentId);
      return loaded;
    } catch {
      // ignore a superseded worktree failure
      if (generation === loadGeneration.current) setError('Unable to load bookmarks');
      return undefined;
    } finally {
      // retain loading state for the newest request
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [agentId, resourceBase, worktreeId]);

  // preload the bookmark count for the closed control
  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  // toggle the bookmark flyout
  const toggle = async () => {
    // close an open menu
    if (menuOpen) return setMenuOpen(false);
    await load();
    // expose either bookmarks or the load error
    setMenuOpen(true);
  };

  // save the current Codex chat
  const saveCurrent = async () => {
    // require one live agent
    if (agentId === undefined || saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agentId)}/bookmarks`, { method: 'POST' });
      // surface bounded server diagnostics
      if (!response.ok) throw new Error(await launchError(response));
      const saved: unknown = await response.json();
      // require one complete bookmark
      if (!isCodexBookmark(saved)) throw new Error('bookmark unavailable');
      setBookmarks(current => [saved, ...(current ?? []).filter(bookmark => bookmark.id !== saved.id)]);
      setCurrentBookmarkId(saved.id);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : 'Unable to bookmark this chat');
    } finally {
      setSaving(false);
    }
  };

  // resume one exact saved chat
  const switchTo = async (bookmark: CodexBookmark) => {
    // serialize worktree chat switches
    if (worktreeId === undefined || switchingId !== undefined || !canResume) return;
    const operationKey = restartOperationKey(worktreeId);
    // share lifecycle state with the worktree tab
    if (!beginPendingOperation(operationKey)) return;
    pendingWorktreeLaunches.set(worktreeId, { operationKey, ...(agentId === undefined ? {} : { sourceAgentId: agentId }) });
    setSwitchingId(bookmark.id);
    setError('');
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/bookmarks/${encodeURIComponent(bookmark.id)}/switch`, { method: 'POST' });
      const payload: unknown = response.ok ? await response.json() : undefined;
      const nextAgentId = payload !== null && typeof payload === 'object' ? (payload as { agentId?: unknown }).agentId : undefined;
      // require the replacement identity
      if (typeof nextAgentId !== 'string') throw new Error(response.ok ? 'The bookmarked chat opened without a replacement agent.' : await launchError(response));
      setCurrentBookmarkId(bookmark.id);
      const pending = pendingWorktreeLaunches.get(worktreeId);
      // avoid restoring a handoff already confirmed by dashboard push
      if (pending !== undefined) pendingWorktreeLaunches.set(worktreeId, { ...pending, agentId: nextAgentId });
      else setPendingOperation(operationKey, false);
      setMenuOpen(false);
    } catch (reason) {
      pendingWorktreeLaunches.delete(worktreeId);
      setPendingOperation(operationKey, false);
      setError(reason instanceof Error && reason.message ? reason.message : 'Unable to switch chats');
    } finally {
      setSwitchingId(undefined);
    }
  };

  // persist one saved chat title
  const saveRename = async () => {
    const title = renameDraft?.title.trim();
    // require one valid rename operation
    if (resourceBase === undefined || renameDraft === undefined || renamingId !== undefined || !title) return;
    const bookmark = bookmarks?.find(candidate => candidate.id === renameDraft.id);
    // close unchanged names without writing
    if (bookmark?.title === title) {
      setRenameDraft(undefined);
      return;
    }
    setRenamingId(renameDraft.id);
    setError('');
    try {
      const response = await request(`${resourceBase}/bookmarks/${encodeURIComponent(renameDraft.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
      const renamed: unknown = response.ok ? await response.json() : undefined;
      // require one complete saved chat
      if (!isCodexBookmark(renamed)) throw new Error('bookmark rename unavailable');
      setBookmarks(current => current?.map(candidate => candidate.id === renamed.id ? renamed : candidate));
      setRenameDraft(undefined);
    } catch {
      setError('Unable to rename saved chat');
    } finally {
      setRenamingId(undefined);
    }
  };

  // delete one saved chat link
  const remove = async (bookmark: CodexBookmark) => {
    // serialize bookmark deletes
    if (resourceBase === undefined || deletingId !== undefined) return;
    setDeletingId(bookmark.id);
    setError('');
    try {
      const response = await request(`${resourceBase}/bookmarks/${encodeURIComponent(bookmark.id)}`, { method: 'DELETE' });
      // require one successful delete
      if (!response.ok) throw new Error('Unable to delete bookmark');
      setBookmarks(current => current?.filter(candidate => candidate.id !== bookmark.id));
      // clear current state with its deleted bookmark
      if (currentBookmarkId === bookmark.id) setCurrentBookmarkId(undefined);
      // close a deleted rename draft
      if (renameDraft?.id === bookmark.id) setRenameDraft(undefined);
    } catch {
      setError('Unable to delete bookmark');
    } finally {
      setDeletingId(undefined);
    }
  };

  // hide bookmarks without any persistence context
  if (resourceBase === undefined) return { control: null };
  const count = bookmarks?.length ?? 0;
  const label = `Bookmarked chats (${count})`;
  const busy = loading || saving || switchingId !== undefined || renamingId !== undefined || deletingId !== undefined || lifecycleSwitching;
  const resumeUnavailable = worktreeId === undefined ? 'Exact chat resume is not available for scratch agents.' : 'Exact chat resume is not configured for this worktree.';
  const control = <div className="bookmarks-control" ref={anchorRef}><button className={`log-control page-arrow bookmarks-toggle${menuOpen ? ' active' : ''}`} type="button" aria-label={label} title={label} aria-expanded={menuOpen} disabled={loading} onPointerDown={event => event.preventDefault()} onClick={() => void toggle()}>{loading ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18l-6-4-6 4V4Z" /></svg>}{count > 0 && <span className="saved-prompts-count bookmarks-count" aria-hidden="true">{count}</span>}</button>{menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div ref={flyoutRef} className="bookmarks-menu" style={flyoutStyle} aria-label="Bookmarked chats"><button className="log-control bookmark-current" type="button" disabled={agentId === undefined || busy || renameDraft !== undefined || currentBookmarkId !== undefined} onClick={() => void saveCurrent()}>{saving ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>}<span>{agentId === undefined ? 'Launch an agent to bookmark a chat' : 'Bookmark this chat'}</span></button>{error && <p className="bookmark-error" role="alert">{error}</p>}{!canResume && count > 0 && <p className="bookmark-warning">{resumeUnavailable}</p>}{bookmarks?.map(bookmark => {
    // render one saved chat row
    const editing = renameDraft?.id === bookmark.id;
    const current = currentBookmarkId === bookmark.id;
    return <div className={`bookmark-row${current ? ' selected' : ''}`} key={bookmark.id}>{editing ? <form className="bookmark-rename-form" onSubmit={event => { event.preventDefault(); void saveRename(); }} onKeyDown={event => {
      // save or cancel from the keyboard
      if (event.key === 'Escape') { event.preventDefault(); setRenameDraft(undefined); }
    }}><input aria-label="Chat name" value={renameDraft.title} maxLength={120} autoFocus disabled={renamingId !== undefined} onChange={event => setRenameDraft({ id: bookmark.id, title: event.target.value })} /><button className="log-control bookmark-rename-save" type="submit" disabled={busy || !renameDraft.title.trim()} aria-label="Save chat name" title="Save chat name">{renamingId === bookmark.id ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}</button><button className="log-control bookmark-rename-cancel" type="button" disabled={busy} aria-label="Cancel chat rename" title="Cancel" onClick={() => setRenameDraft(undefined)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></form> : <><button className="log-control bookmark-choice" type="button" aria-current={current ? 'true' : undefined} disabled={busy || renameDraft !== undefined || !canResume} title={canResume ? bookmark.title : resumeUnavailable} onClick={() => void switchTo(bookmark)}>{switchingId === bookmark.id ? <span className="spinner" /> : <span className="bookmark-details"><strong>{bookmark.title}</strong><small>{bookmarkDate(bookmark.createdAt)}</small></span>}</button><span className="bookmark-actions"><button className="log-control bookmark-rename" type="button" disabled={busy || renameDraft !== undefined} aria-label={`Rename saved chat: ${bookmark.title}`} title="Rename saved chat" onClick={() => setRenameDraft({ id: bookmark.id, title: bookmark.title })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3" /></svg></button><button className="log-control bookmark-delete" type="button" disabled={busy || renameDraft !== undefined} aria-label={`Delete saved chat: ${bookmark.title}`} title="Delete saved chat" onClick={() => void remove(bookmark)}>{deletingId === bookmark.id ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6" /></svg>}</button></span></>}</div>;
  })}</div></FlyoutPortal>}</div>;
  return { control };
}

// manage persistent worktree notes
function useWorktreeNotes(worktreeId?: string, agentId?: string, latestAssistantMessage?: string, latestAssistantMessageOverflows = false, onPromptHistoryChanged?: () => void | Promise<void>, promptHistory: PromptHistoryEntry[] = []) {
  const [notes, setNotes] = useState<WorktreeNote[]>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeNote, setActiveNote] = useState<WorktreeNote>();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renamePending, setRenamePending] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menuRenameDraft, setMenuRenameDraft] = useState<{ id: string; title: string }>();
  const [menuRenamingId, setMenuRenamingId] = useState<string>();
  const [menuDeletingId, setMenuDeletingId] = useState<string>();
  const [menuError, setMenuError] = useState('');
  const [copyState, setCopyState] = useState<'idle'|'copied'|'error'>('idle');
  const [sendState, setSendState] = useState<'idle'|'sending'|'queued'|'error'>('idle');
  const [dirtyCount, setDirtyCount] = useState(0);
  const [saveStatus, setSaveStatus] = useState<'saved'|'saving'|'error'>('saved');
  const resourceBase = persistenceResourceBase(worktreeId, agentId);
  const noteViewId = worktreeId ?? (agentId === undefined ? undefined : `agent:${agentId}`);
  const { anchorRef, flyoutRef, style: flyoutStyle } = useViewportFlyout<HTMLDivElement>(menuOpen, { placement: 'left', boundarySelector: '.log', boundaryRootSelector: '.agent-view, .worktree-view', contentSized: true });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const titleEditorRef = useRef<HTMLInputElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const selectionAtPointerDown = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const activeNoteRef = useRef<WorktreeNote | undefined>(undefined);
  const draftRef = useRef('');
  const acknowledgedTexts = useRef(new Map<string, string>());
  const dirtyTexts = useRef(new Map<string, string>());
  const queuedTexts = useRef(new Map<string, string>());
  const failedNotes = useRef(new Set<string>());
  const saveVersions = useRef(new Map<string, number>());
  const saveQueue = useRef(Promise.resolve());
  const actionStatusTimer = useRef<number | undefined>(undefined);
  const selectionCopiedTimer = useRef<number | undefined>(undefined);
  const [selectionToolbar, setSelectionToolbar] = useState<{ text: string; top: number }>();
  const promptPendingKey = `prompt:${agentId ?? 'unavailable'}`;
  const promptPending = usePendingOperation(promptPendingKey);

  const clearActionStatusLater = () => {
    if (actionStatusTimer.current !== undefined) window.clearTimeout(actionStatusTimer.current);
    actionStatusTimer.current = window.setTimeout(() => {
      actionStatusTimer.current = undefined;
      setCopyState('idle');
      setSendState('idle');
    }, 1_600);
  };

  const persist = useCallback((noteId: string, text: string, immediate = false) => {
    // skip unavailable or duplicate saves
    if (resourceBase === undefined || (!immediate && queuedTexts.current.get(noteId) === text)) return;
    queuedTexts.current.set(noteId, text);
    const version = (saveVersions.current.get(noteId) ?? 0) + 1;
    saveVersions.current.set(noteId, version);
    if (activeNoteRef.current?.id === noteId) setSaveStatus('saving');
    const save = async () => {
      if (!immediate && saveVersions.current.get(noteId) !== version) return;
      try {
        const response = await request(`${resourceBase}/notes/${encodeURIComponent(noteId)}`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        if (!response.ok) throw new Error('note save failed');
        const saved: unknown = await response.json();
        if (!isWorktreeNote(saved)) throw new Error('invalid saved note');
        if (saveVersions.current.get(noteId) !== version) return;
        acknowledgedTexts.current.set(noteId, text);
        if (queuedTexts.current.get(noteId) === text) queuedTexts.current.delete(noteId);
        if (dirtyTexts.current.get(noteId) === text) dirtyTexts.current.delete(noteId);
        if (!dirtyTexts.current.has(noteId)) failedNotes.current.delete(noteId);
        setDirtyCount(dirtyTexts.current.size);
        setNotes(current => current?.map(note => note.id === saved.id && !dirtyTexts.current.has(noteId) ? saved : note));
        if (activeNoteRef.current?.id === noteId) setSaveStatus(dirtyTexts.current.has(noteId) ? failedNotes.current.has(noteId) ? 'error' : 'saving' : 'saved');
      } catch {
        if (saveVersions.current.get(noteId) !== version) return;
        if (queuedTexts.current.get(noteId) === text) queuedTexts.current.delete(noteId);
        if (dirtyTexts.current.get(noteId) === text) {
          failedNotes.current.add(noteId);
          setDirtyCount(dirtyTexts.current.size);
          if (activeNoteRef.current?.id === noteId) setSaveStatus('error');
        }
      }
    };
    if (immediate) void save();
    else saveQueue.current = saveQueue.current.then(save, save);
  }, [resourceBase]);

  const flush = useCallback(() => {
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    const note = activeNoteRef.current;
    const text = note === undefined ? undefined : dirtyTexts.current.get(note.id);
    if (note !== undefined && text !== undefined) persist(note.id, text);
  }, [persist]);
  const flushAll = useCallback((immediate = false) => {
    if (immediate) {
      if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    } else flush();
    for (const [noteId, text] of dirtyTexts.current) persist(noteId, text, immediate);
  }, [flush, persist]);

  useEffect(() => {
    const pageHiding = () => flushAll(true);
    window.addEventListener('pagehide', pageHiding);
    return () => {
      window.removeEventListener('pagehide', pageHiding);
      flushAll(true);
    };
  }, [flushAll]);
  useEffect(() => () => {
    if (actionStatusTimer.current !== undefined) window.clearTimeout(actionStatusTimer.current);
    if (selectionCopiedTimer.current !== undefined) window.clearTimeout(selectionCopiedTimer.current);
  }, []);
  useEffect(() => {
    const retained = noteViewId === undefined ? undefined : getWorktreeNoteView(noteViewId);
    setNotes(undefined);
    setMenuOpen(false);
    setActiveNote(undefined);
    setExpanded(retained?.expanded ?? false);
    setEditing(false);
    setRenaming(false);
    setRenamePending(false);
    setTitleDraft('');
    setMenuRenameDraft(undefined);
    setMenuRenamingId(undefined);
    setMenuDeletingId(undefined);
    setMenuError('');
    activeNoteRef.current = undefined;
    draftRef.current = '';
    acknowledgedTexts.current.clear();
    dirtyTexts.current.clear();
    queuedTexts.current.clear();
    failedNotes.current.clear();
    saveVersions.current.clear();
    setCopyState('idle');
    setSendState('idle');
    setDirtyCount(0);
  }, [noteViewId]);
  useEffect(() => {
    // require one configured or scratch persistence context
    if (resourceBase === undefined || noteViewId === undefined) return;
    let cancelled = false;
    setLoading(true);
    void request(`${resourceBase}/notes`).then(async response => {
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { notes?: unknown }).notes)) throw new Error();
      const loaded = (payload as { notes: unknown[] }).notes.filter(isWorktreeNote);
      if (cancelled) return;
      for (const note of loaded) acknowledgedTexts.current.set(note.id, note.text);
      setNotes(loaded);
      const retained = getWorktreeNoteView(noteViewId);
      if (retained !== undefined) {
        const note = loaded.find(candidate => candidate.id === retained.noteId);
        if (note === undefined) clearWorktreeNoteView(noteViewId);
        else {
          activeNoteRef.current = note;
          draftRef.current = note.text;
          setDraft(note.text);
          setActiveNote(note);
          setExpanded(retained.expanded);
          setEditing(false);
        }
      }
    }).catch(() => {
      if (!cancelled) setSaveStatus('error');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [noteViewId, resourceBase]);
  useLayoutEffect(() => { if (activeNote !== undefined && editing) editorRef.current?.focus(); }, [activeNote?.id, editing]);
  useLayoutEffect(() => { if (activeNote !== undefined && renaming) titleEditorRef.current?.select(); }, [activeNote?.id, renaming]);
  useEffect(() => {
    setSelectionToolbar(undefined);
    const preview = previewRef.current;
    if (preview === null || activeNote === undefined || editing) return;
    const syncSelection = () => {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0 || selection.anchorNode === null || selection.focusNode === null || !preview.contains(selection.anchorNode) || !preview.contains(selection.focusNode)) {
        setSelectionToolbar(undefined);
        return;
      }
      const range = selection.getRangeAt(0);
      const bounds = Array.from(range.getClientRects()).at(-1) ?? range.getBoundingClientRect();
      const text = selection.toString();
      if (!text) return setSelectionToolbar(undefined);
      setSelectionToolbar({ text, top: Math.max(8, Math.min(window.innerHeight - 48, bounds.bottom + 8)) });
    };
    document.addEventListener('selectionchange', syncSelection);
    preview.addEventListener('scroll', syncSelection);
    window.addEventListener('resize', syncSelection);
    syncSelection();
    return () => {
      document.removeEventListener('selectionchange', syncSelection);
      preview.removeEventListener('scroll', syncSelection);
      window.removeEventListener('resize', syncSelection);
    };
  }, [activeNote?.id, editing]);

  const restoreTriggerFocus = () => window.requestAnimationFrame(() => triggerRef.current?.focus());
  const open = (note: WorktreeNote, edit?: boolean) => {
    flush();
    const text = dirtyTexts.current.get(note.id) ?? note.text;
    const opened = { ...note, text };
    const editingOnOpen = edit ?? !text.trim();
    const expandOnOpen = editingOnOpen && window.matchMedia('(max-width: 600px)').matches;
    activeNoteRef.current = opened;
    draftRef.current = text;
    if (!acknowledgedTexts.current.has(note.id)) acknowledgedTexts.current.set(note.id, note.text);
    setDraft(text);
    setActiveNote(opened);
    setExpanded(expandOnOpen);
    // retain this context's open note
    if (noteViewId !== undefined) setWorktreeNoteView(noteViewId, { noteId: note.id, expanded: expandOnOpen });
    setEditing(editingOnOpen);
    setRenaming(false);
    setTitleDraft(note.title ?? '');
    setCopyState('idle');
    setSendState('idle');
    setSaveStatus(failedNotes.current.has(note.id) ? 'error' : dirtyTexts.current.has(note.id) ? 'saving' : 'saved');
    setMenuOpen(false);
    if (dirtyTexts.current.has(note.id)) persist(note.id, text);
  };
  const updateDraft = (note: WorktreeNote, text: string) => {
    draftRef.current = text;
    activeNoteRef.current = { ...note, text };
    setDraft(text);
    setCopyState('idle');
    setSendState('idle');
    setNotes(current => current?.map(candidate => candidate.id === note.id ? { ...candidate, text } : candidate));
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    failedNotes.current.delete(note.id);
    const clean = text === acknowledgedTexts.current.get(note.id) && queuedTexts.current.get(note.id) === undefined;
    if (clean) {
      dirtyTexts.current.delete(note.id);
      saveTimer.current = undefined;
      setDirtyCount(dirtyTexts.current.size);
      setSaveStatus('saved');
      return;
    }
    dirtyTexts.current.set(note.id, text);
    setDirtyCount(dirtyTexts.current.size);
    setSaveStatus('saving');
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined;
      persist(note.id, dirtyTexts.current.get(note.id) ?? draftRef.current);
    }, 500);
  };
  const load = async () => {
    // require one persistence context
    if (resourceBase === undefined) return undefined;
    if (notes !== undefined) return notes;
    setLoading(true);
    try {
      const response = await request(`${resourceBase}/notes`);
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { notes?: unknown }).notes)) throw new Error();
      const loaded = (payload as { notes: unknown[] }).notes.filter(isWorktreeNote);
      for (const note of loaded) acknowledgedTexts.current.set(note.id, note.text);
      setNotes(loaded);
      return loaded;
    } catch {
      setSaveStatus('error');
      return undefined;
    } finally { setLoading(false); }
  };
  // create an optionally titled note
  const create = async (text = '', title?: string) => {
    // require one idle persistence context
    if (resourceBase === undefined || loading) return;
    setLoading(true);
    try {
      const response = await request(`${resourceBase}/notes`, { method: 'POST', ...(title === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }) });
      const note: unknown = response.ok ? await response.json() : undefined;
      if (!isWorktreeNote(note)) throw new Error();
      acknowledgedTexts.current.set(note.id, note.text);
      setNotes(current => [note, ...(current ?? [])]);
      open(note, !text.trim());
      if (text) updateDraft(note, text);
    } catch { setSaveStatus('error'); }
    finally { setLoading(false); }
  };
  // toggle notes menu
  const toggle = async () => {
    if (menuOpen) return setMenuOpen(false);
    // refresh completed historical responses before choosing one
    await onPromptHistoryChanged?.();
    const loaded = await load();
    if (loaded === undefined) return;
    setMenuOpen(true);
  };
  const changeDraft = (text: string) => {
    const note = activeNoteRef.current;
    if (note === undefined) return;
    updateDraft(note, text);
  };
  const appendToActive = (text: string) => {
    const note = activeNoteRef.current;
    const next = appendTextBlock(draftRef.current, text);
    if (note === undefined || !text || next.length > 30_000) return;
    updateDraft(note, next);
  };
  const canAppendToActive = (text: string) => activeNoteRef.current !== undefined && appendTextBlock(draftRef.current, text).length <= 30_000;
  const copy = async () => {
    try {
      await copyText(draftRef.current);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    clearActionStatusLater();
  };
  const copySelection = async (text: string) => {
    await copyText(text);
    const preview = previewRef.current;
    preview?.classList.add('selection-copied');
    if (selectionCopiedTimer.current !== undefined) window.clearTimeout(selectionCopiedTimer.current);
    selectionCopiedTimer.current = window.setTimeout(() => {
      selectionCopiedTimer.current = undefined;
      preview?.classList.remove('selection-copied');
    }, selectionCopyFlashMs);
  };
  const send = async () => {
    const prompt = draftRef.current;
    if (agentId === undefined || !prompt.trim() || deleting || sendState === 'sending' || !beginPendingOperation(promptPendingKey)) return;
    flush();
    setSendState('sending');
    setCopyState('idle');
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agentId)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, attachments: [] }) });
      if (!response.ok) throw new Error();
      setSendState('queued');
      await onPromptHistoryChanged?.();
      clearActionStatusLater();
    } catch {
      setSendState('error');
    } finally {
      setPendingOperation(promptPendingKey, false);
    }
  };
  // persist one note title while retaining local text
  const renameNote = async (note: WorktreeNote, title: string) => {
    // require one persistence context
    if (resourceBase === undefined) throw new Error('note rename unavailable');
    const response = await request(`${resourceBase}/notes/${encodeURIComponent(note.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
    // require a complete renamed note
    if (!response.ok) throw new Error('note rename unavailable');
    const saved: unknown = await response.json();
    // reject malformed rename responses
    if (!isWorktreeNote(saved) || saved.title === undefined) throw new Error('note rename unavailable');
    setNotes(current => current?.map(candidate => candidate.id === note.id ? { ...candidate, title: saved.title } : candidate));
    const current = activeNoteRef.current;
    // keep the open note synchronized
    if (current?.id === note.id) {
      const renamed = { ...current, title: saved.title, text: dirtyTexts.current.get(note.id) ?? draftRef.current };
      activeNoteRef.current = renamed;
      setActiveNote(renamed);
      setTitleDraft(saved.title);
    }
    return saved.title;
  };
  // persist a note title
  const saveTitle = async () => {
    const note = activeNoteRef.current;
    const title = titleDraft.trim();
    // require one valid pane rename
    if (resourceBase === undefined || note === undefined || renamePending || !title) return;
    // close unchanged names without writing
    if (title === note.title) {
      setRenaming(false);
      return;
    }
    setRenamePending(true);
    try {
      await renameNote(note, title);
      setRenaming(false);
    } catch { setSaveStatus('error'); }
    finally { setRenamePending(false); }
  };
  // persist an inline flyout title
  const saveMenuTitle = async () => {
    const title = menuRenameDraft?.title.trim();
    const note = notes?.find(candidate => candidate.id === menuRenameDraft?.id);
    // require one valid menu rename
    if (note === undefined || menuRenameDraft === undefined || menuRenamingId !== undefined || !title) return;
    // close unchanged names without writing
    if (title === note.title) {
      setMenuRenameDraft(undefined);
      return;
    }
    setMenuRenamingId(note.id);
    setMenuError('');
    try {
      await renameNote(note, title);
      setMenuRenameDraft(undefined);
    } catch {
      setMenuError('Unable to rename note');
    } finally {
      setMenuRenamingId(undefined);
    }
  };
  // remove one deleted note from local state
  const forgetNote = (note: WorktreeNote, restoreFocusAfterClose: boolean) => {
    acknowledgedTexts.current.delete(note.id);
    dirtyTexts.current.delete(note.id);
    queuedTexts.current.delete(note.id);
    failedNotes.current.delete(note.id);
    saveVersions.current.delete(note.id);
    setDirtyCount(dirtyTexts.current.size);
    setNotes(current => current?.filter(candidate => candidate.id !== note.id));
    setMenuRenameDraft(current => current?.id === note.id ? undefined : current);
    // close the pane when it displayed the deleted note
    if (activeNoteRef.current?.id === note.id) {
      activeNoteRef.current = undefined;
      // clear this context's retained note
      if (noteViewId !== undefined) clearWorktreeNoteView(noteViewId);
      setActiveNote(undefined);
      setExpanded(false);
      setEditing(false);
      setRenaming(false);
      // restore toolbar focus for pane deletes
      if (restoreFocusAfterClose) restoreTriggerFocus();
    }
  };
  // delete one note after pending saves settle
  const deleteNote = async (note: WorktreeNote, restoreFocusAfterClose: boolean) => {
    // discard a pending autosave for this note
    if (activeNoteRef.current?.id === note.id && saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    await saveQueue.current;
    // require one persistence context
    if (resourceBase === undefined) throw new Error('note delete unavailable');
    const response = await request(`${resourceBase}/notes/${encodeURIComponent(note.id)}`, { method: 'DELETE' });
    // retain the note after a failed delete
    if (!response.ok) throw new Error('note delete unavailable');
    forgetNote(note, restoreFocusAfterClose);
  };
  const remove = () => {
    const note = activeNoteRef.current;
    // serialize pane deletes
    if (resourceBase === undefined || note === undefined || deleting) return;
    setDeleting(true);
    void deleteNote(note, true).catch(() => {
      // preserve dirty state after a failed pane delete
      if (dirtyTexts.current.has(note.id)) failedNotes.current.add(note.id);
      setDirtyCount(dirtyTexts.current.size);
      setSaveStatus('error');
    }).finally(() => setDeleting(false));
  };
  // delete one note from the flyout
  const removeFromMenu = async (note: WorktreeNote) => {
    // serialize menu deletes
    if (menuDeletingId !== undefined || menuRenamingId !== undefined) return;
    setMenuDeletingId(note.id);
    setMenuError('');
    try {
      await deleteNote(note, false);
    } catch {
      setMenuError('Unable to delete note');
    } finally {
      setMenuDeletingId(undefined);
    }
  };
  const close = () => {
    if (!draftRef.current.trim()) {
      remove();
      return;
    }
    flush();
    activeNoteRef.current = undefined;
    // clear this context's retained note
    if (noteViewId !== undefined) clearWorktreeNoteView(noteViewId);
    setActiveNote(undefined);
    setExpanded(false);
    setEditing(false);
    setRenaming(false);
    restoreTriggerFocus();
  };

  // hide notes without any persistence context
  if (resourceBase === undefined) return { active: false, expanded: false, appendToActive, canAppendToActive, canCreate: false, control: null, createWithText: create, pane: null };
  const noteCount = notes?.length ?? 0;
  const substantialResponse = latestSubstantialResponse(latestAssistantMessage, promptHistory);
  const latestResponseAvailable = notes !== undefined && substantialResponse !== undefined && !notes.some(note => note.text === substantialResponse);
  const highlightLatestResponse = latestResponseAvailable && substantialResponse === latestAssistantMessage && latestAssistantMessageOverflows;
  const notesLabel = dirtyCount === 0 ? `Notes (${noteCount})` : `Notes (${noteCount}; ${dirtyCount} unsaved)`;
  const noteMenuBusy = menuRenamingId !== undefined || menuDeletingId !== undefined;
  const control = <div className="notes-control" ref={anchorRef}>
    <button ref={triggerRef} className={`log-control page-arrow notes-toggle${menuOpen || activeNote !== undefined ? ' active' : ''}${dirtyCount > 0 ? ' unsaved' : ''}${highlightLatestResponse ? ' latest-response-available' : ''}`} aria-label={notesLabel} title={notesLabel} aria-expanded={menuOpen} disabled={loading} onPointerDown={event => event.preventDefault()} onClick={() => void toggle()}>{loading ? <span className="spinner" /> : <svg className="notes-icon" viewBox="0 0 24 24" aria-hidden="true"><path className="notes-icon-sheet" d="M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M15 21v-6h6" /></svg>}{noteCount > 0 && <span className="saved-prompts-count notes-count" aria-hidden="true">{noteCount}</span>}</button>
    {menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div ref={flyoutRef} className="notes-menu" style={flyoutStyle} aria-label={worktreeId === undefined ? 'Scratch notes' : 'Worktree notes'}>
      <button className="log-control save-latest-response" disabled={!latestResponseAvailable || noteMenuBusy || menuRenameDraft !== undefined} onClick={() => {
        // save only an available response
        if (substantialResponse !== undefined) void create(substantialResponse, assistantNoteTitle(substantialResponse));
      }}>Save latest response</button>
      {menuError && <p className="note-menu-error" role="alert">{menuError}</p>}
      {notes?.map(note => {
        // render one sticky note row
        const label = noteName(note);
        const editingTitle = menuRenameDraft?.id === note.id;
        return <div className="note-row" key={note.id}>{editingTitle ? <form className="note-menu-rename-form" onSubmit={event => { event.preventDefault(); void saveMenuTitle(); }} onKeyDown={event => {
          // save or cancel from the keyboard
          if (event.key === 'Escape') { event.preventDefault(); setMenuRenameDraft(undefined); }
        }}><input aria-label="Note name" value={menuRenameDraft.title} maxLength={120} autoFocus disabled={menuRenamingId !== undefined} onChange={event => setMenuRenameDraft({ id: note.id, title: event.target.value })} /><button className="log-control note-menu-rename-save" type="submit" disabled={noteMenuBusy || !menuRenameDraft.title.trim()} aria-label="Save note name" title="Save note name">{menuRenamingId === note.id ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}</button><button className="log-control note-menu-rename-cancel" type="button" disabled={noteMenuBusy} aria-label="Cancel note rename" title="Cancel" onClick={() => setMenuRenameDraft(undefined)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></form> : <><button className="log-control note-choice" type="button" disabled={noteMenuBusy || menuRenameDraft !== undefined} title={(note.title ?? note.text) || 'Blank note'} onClick={() => open(note)}><span className="note-menu-name">{label}</span></button><span className="note-menu-actions"><button className="log-control note-menu-rename" type="button" disabled={noteMenuBusy || menuRenameDraft !== undefined} aria-label={`Rename note: ${label}`} title="Rename note" onClick={() => setMenuRenameDraft({ id: note.id, title: Array.from(note.title ?? label).slice(0, 120).join('') })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3" /></svg></button><button className="log-control note-menu-delete" type="button" disabled={noteMenuBusy || menuRenameDraft !== undefined} aria-label={`Delete note: ${label}`} title="Delete note" onClick={() => void removeFromMenu(note)}>{menuDeletingId === note.id ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6" /></svg>}</button></span></>}</div>;
      })}
      <button className="log-control new-note" disabled={noteMenuBusy || menuRenameDraft !== undefined} onClick={() => void create()}>+ New note</button>
    </div></FlyoutPortal>}
  </div>;
  const actionStatus = copyState === 'error' ? 'Copy failed' : sendState === 'queued' ? 'Queued' : sendState === 'error' ? 'Queue failed' : '';
  const toggleExpanded = () => setExpanded(value => {
    const next = !value;
    // retain this context's pane state
    if (noteViewId !== undefined && activeNote !== undefined) setWorktreeNoteView(noteViewId, { noteId: activeNote.id, expanded: next });
    return next;
  });
  const inferEditing = (target: EventTarget | null) => {
    if (target instanceof Element && target.closest('a, button, input')) {
      selectionAtPointerDown.current = false;
      return;
    }
    const selected = window.getSelection()?.toString() ?? '';
    if (selectionAtPointerDown.current || selected) {
      selectionAtPointerDown.current = false;
      return;
    }
    if (window.matchMedia('(max-width: 600px)').matches) {
      setExpanded(true);
      // retain mobile expansion state
      if (noteViewId !== undefined && activeNote !== undefined) setWorktreeNoteView(noteViewId, { noteId: activeNote.id, expanded: true });
    }
    setEditing(true);
  };
  const selectionActions = activeNote === undefined || selectionToolbar === undefined ? null : createPortal(<div className="output-selection-toolbar note-selection-toolbar" role="toolbar" aria-label="Note selection actions" style={{ top: selectionToolbar.top }} onPointerDown={event => event.preventDefault()}>
    <button type="button" disabled={agentId === undefined} onClick={() => { if (agentId !== undefined) setPromptDraft(agentId, current => appendTextBlock(current, selectionToolbar.text)); }}>Add to prompt</button>
    <button type="button" onClick={() => void copySelection(selectionToolbar.text)}>Copy</button>
  </div>, document.body);
  const pane = activeNote === undefined ? null : <><section className={`note-pane${expanded ? ' expanded' : ''}${editing ? ' editing' : ' selecting'}`} role="dialog" aria-label="Note" onKeyDown={event => { if (event.key === 'Escape' && !deleting && sendState !== 'sending') { event.preventDefault(); close(); } }}><header className="note-toolbar" role="toolbar" aria-label="Note actions">{renaming ? <form className="note-title-form" onSubmit={event => { event.preventDefault(); void saveTitle(); }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); } }}><input ref={titleEditorRef} aria-label="Note name" value={titleDraft} maxLength={120} disabled={renamePending} onChange={event => setTitleDraft(event.target.value)} /><button type="submit" disabled={renamePending || !titleDraft.trim()} aria-label="Save note name" title="Save note name"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></button><button type="button" disabled={renamePending} aria-label="Cancel note rename" title="Cancel" onClick={() => setRenaming(false)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></form> : <><strong title={activeNote.title ?? 'Note'}>{activeNote.title ?? 'Note'}</strong><button className="note-rename" type="button" disabled={deleting || renamePending} aria-label="Rename note" title="Rename note" onClick={() => { setTitleDraft(activeNote.title ?? ''); setRenaming(true); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3" /></svg></button></>}{saveStatus === 'error' && <span className="note-save-status error" role="alert" aria-live="assertive">Unable to save</span>}{actionStatus && <span className={`note-action-status${copyState === 'error' || sendState === 'error' ? ' error' : ''}`} role={copyState === 'error' || sendState === 'error' ? 'alert' : 'status'}>{actionStatus}</span>}<button className={`note-copy${copyState === 'copied' ? ' copied' : ''}`} type="button" disabled={deleting} aria-label={copyState === 'copied' ? 'Note copied' : 'Copy note'} title={copyState === 'copied' ? 'Copied' : 'Copy note'} onClick={() => void copy()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={copyState === 'copied' ? 'm5 12 4 4L19 6' : 'M9 9h10v10H9zM5 15H4V5h10v1'} /></svg></button><button className="note-send" type="button" disabled={agentId === undefined || deleting || promptPending || !draft.trim()} aria-label="Send note as prompt" title={agentId === undefined ? 'Launch an agent to send this note' : 'Send note as prompt'} onClick={() => void send()}>{sendState === 'sending' ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" /></svg>}</button><button className="note-delete" type="button" disabled={deleting || sendState === 'sending'} aria-label="Delete note" title="Delete note" onClick={remove}>{deleting ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-8 0 1 13h8l1-13" /></svg>}</button><button className="note-expand" type="button" disabled={deleting || sendState === 'sending'} aria-label={expanded ? 'Restore note' : 'Expand note'} title={expanded ? 'Restore note' : 'Expand note'} aria-pressed={expanded} onClick={toggleExpanded}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={expanded ? 'M9 3v6H3m18 6h-6v6M3 9l6-6m6 18 6-6' : 'M9 3H3v6m18 6v6h-6M3 3l6 6m6 6 6 6'} /></svg></button><button className="note-close" type="button" disabled={deleting || sendState === 'sending'} aria-label="Close note" title="Close note" onClick={close}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>{editing ? <textarea ref={editorRef} aria-label="Note content" value={draft} maxLength={30_000} disabled={deleting} onChange={event => changeDraft(event.target.value)} onBlur={() => { flush(); setEditing(false); }} /> : <div className="note-preview-interaction" onPointerDown={() => { selectionAtPointerDown.current = Boolean(window.getSelection()?.toString()); }} onClick={event => inferEditing(event.target)}><NoteMarkdown text={draft} containerRef={previewRef} /></div>}</section>{selectionActions}</>;
  return { active: activeNote !== undefined, expanded: activeNote !== undefined && expanded, appendToActive, canAppendToActive, canCreate: !loading, control, createWithText: create, pane };
}

const browserViewportKey = (worktreeId: string) => `rac.browser-viewport:${worktreeId}`;
const browserSplitKey = (worktreeId: string) => `rac.browser-split:${worktreeId}`;
const browserUrlKey = (worktreeId: string) => `rac.browser-url:${worktreeId}`;
const browserDesktopViewportWidth = 980;
type ProjectBrowserNavigationRequest = { sequence: number; url: string };
// normalize project-owned locations
const normalizeBrowserUrl = (candidate: string, homeUrl: string) => {
  try {
    const home = new URL(homeUrl);
    const next = new URL(candidate, home);
    // keep the frame inside its configured origin
    if (next.origin !== home.origin || next.username || next.password) return undefined;
    return next.href;
  } catch { return undefined; }
};
// restore the last valid project location
const savedBrowserUrl = (homeUrl: string, worktreeId?: string) => {
  // skip storage for unscoped agents
  if (worktreeId === undefined) return normalizeBrowserUrl(homeUrl, homeUrl) ?? homeUrl;
  try {
    const stored = localStorage.getItem(browserUrlKey(worktreeId));
    return stored === null ? normalizeBrowserUrl(homeUrl, homeUrl) ?? homeUrl : normalizeBrowserUrl(stored, homeUrl) ?? homeUrl;
  } catch { return normalizeBrowserUrl(homeUrl, homeUrl) ?? homeUrl; }
};
// persist a project location
const saveBrowserUrl = (worktreeId: string | undefined, url: string) => {
  // skip storage for unscoped agents
  if (worktreeId === undefined) return;
  try { localStorage.setItem(browserUrlKey(worktreeId), url); }
  catch { /* browser storage is optional */ }
};
const savedBrowserMobile = (worktreeId?: string) => {
  if (worktreeId === undefined) return false;
  try { return localStorage.getItem(browserViewportKey(worktreeId)) === 'mobile'; }
  catch { return false; }
};
const saveBrowserMobile = (worktreeId: string | undefined, mobile: boolean) => {
  if (worktreeId === undefined) return;
  try { localStorage.setItem(browserViewportKey(worktreeId), mobile ? 'mobile' : 'desktop'); }
  catch { /* browser storage is optional */ }
};
// route one frame load through the project device selector
const browserDeviceUrl = (target: string, mobile: boolean) => {
  const destination = new URL(target);
  const deviceUrl = new URL('/__rac/browser-device', destination.origin);
  deviceUrl.searchParams.set('mode', mobile ? 'mobile' : 'desktop');
  deviceUrl.searchParams.set('location', `${destination.pathname}${destination.search}${destination.hash}`);
  return deviceUrl.href;
};
const savedBrowserSplit = (worktreeId?: string) => {
  if (worktreeId === undefined) return false;
  try { return localStorage.getItem(browserSplitKey(worktreeId)) === 'open'; }
  catch { return false; }
};
const saveBrowserSplit = (worktreeId: string | undefined, open: boolean) => {
  if (worktreeId === undefined) return;
  try { localStorage.setItem(browserSplitKey(worktreeId), open ? 'open' : 'closed'); }
  catch { /* browser storage is optional */ }
};
// retain browser state for one worktree
function useProjectBrowser(homeUrl?: string, worktreeId?: string) {
  const [open, setOpen] = useState(() => homeUrl !== undefined && savedBrowserSplit(worktreeId));
  const [currentUrl, setCurrentUrl] = useState(() => homeUrl === undefined ? undefined : savedBrowserUrl(homeUrl, worktreeId));
  const [navigationRequest, setNavigationRequest] = useState<ProjectBrowserNavigationRequest>();
  // restore split state whenever the project context changes
  useEffect(() => {
    // close unavailable browser panes
    if (homeUrl === undefined) { setOpen(false); return; }
    // restore scoped split preferences
    if (worktreeId !== undefined) setOpen(savedBrowserSplit(worktreeId));
  }, [homeUrl, worktreeId]);
  useEffect(() => {
    setCurrentUrl(homeUrl === undefined ? undefined : savedBrowserUrl(homeUrl, worktreeId));
  }, [homeUrl, worktreeId]);
  // validate and retain explicit frame navigation
  const navigate = useCallback((candidate: string) => {
    // reject missing or cross-origin locations
    if (homeUrl === undefined) return false;
    const next = normalizeBrowserUrl(candidate, homeUrl);
    // reject malformed locations
    if (next === undefined) return false;
    saveBrowserUrl(worktreeId, next);
    setCurrentUrl(next);
    return true;
  }, [homeUrl, worktreeId]);
  // request one explicit frame navigation
  const openUrl = useCallback((candidate: string) => {
    // reject missing or cross-origin locations
    if (homeUrl === undefined) return false;
    const next = normalizeBrowserUrl(candidate, homeUrl);
    // reject malformed locations
    if (next === undefined) return false;
    saveBrowserUrl(worktreeId, next);
    setCurrentUrl(next);
    // distinguish repeated clicks on one retained URL
    setNavigationRequest(current => ({ sequence: (current?.sequence ?? 0) + 1, url: next }));
    return true;
  }, [homeUrl, worktreeId]);
  return {
    open: open && homeUrl !== undefined,
    homeUrl,
    url: open ? currentUrl : undefined,
    navigate,
    navigationRequest,
    openUrl,
    toggle: () => {
      // ignore unavailable browser panes
      if (homeUrl === undefined) return;
      setOpen(value => { const next = !value; saveBrowserSplit(worktreeId, next); return next; });
    },
    close: () => { saveBrowserSplit(worktreeId, false); setOpen(false); }
  };
}

type ProjectBrowserLocationMessage = { type: 'rac-browser-location'; url: string };
type ProjectBrowserRefreshMessage = { type: 'rac-browser-refresh' };
type ProjectBrowserDeviceErrorMessage = { type: 'rac-browser-device-error'; properties: string[] };
// recognize cooperative frame navigation reports
const isProjectBrowserLocationMessage = (value: unknown): value is ProjectBrowserLocationMessage => value !== null && typeof value === 'object'
  && (value as ProjectBrowserLocationMessage).type === 'rac-browser-location'
  && typeof (value as ProjectBrowserLocationMessage).url === 'string';
// recognize cooperative frame refresh requests
const isProjectBrowserRefreshMessage = (value: unknown): value is ProjectBrowserRefreshMessage => value !== null && typeof value === 'object'
  && (value as ProjectBrowserRefreshMessage).type === 'rac-browser-refresh';
// recognize failed browser identity overrides
const isProjectBrowserDeviceErrorMessage = (value: unknown): value is ProjectBrowserDeviceErrorMessage => value !== null && typeof value === 'object'
  && (value as ProjectBrowserDeviceErrorMessage).type === 'rac-browser-device-error'
  && Array.isArray((value as ProjectBrowserDeviceErrorMessage).properties)
  && (value as ProjectBrowserDeviceErrorMessage).properties.every(property => typeof property === 'string');
// render project navigation controls and content
// render the embedded project browser
function ProjectBrowserPane({ url, homeUrl, worktreeId, navigationRequest, onNavigate, onClose }: { url: string; homeUrl: string; worktreeId?: string; navigationRequest?: ProjectBrowserNavigationRequest; onNavigate: (url: string) => boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [mobile, setMobile] = useState(() => savedBrowserMobile(worktreeId));
  const [deviceError, setDeviceError] = useState<string>();
  const [address, setAddress] = useState(url);
  const [frameSource, setFrameSource] = useState(() => browserDeviceUrl(url, mobile));
  const [frameAwayFromKnownUrl, setFrameAwayFromKnownUrl] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameShellRef = useRef<HTMLDivElement | null>(null);
  const loadedFrameSource = useRef(url);
  const expectedFrameLoad = useRef(true);
  const appliedNavigationSequence = useRef(navigationRequest?.sequence);
  const normalizedHomeUrl = normalizeBrowserUrl(homeUrl, homeUrl) ?? homeUrl;
  const normalizedUrl = normalizeBrowserUrl(url, homeUrl) ?? normalizedHomeUrl;
  const atHome = normalizedUrl === normalizedHomeUrl && !frameAwayFromKnownUrl;
  useEffect(() => setAddress(url), [url]);
  // scale one desktop layout viewport into the visible phone frame
  useEffect(() => {
    const shell = frameShellRef.current;
    // skip an unavailable frame shell
    if (shell === null) return;
    // publish dimensions used by phone-only desktop emulation
    const measure = () => {
      const width = shell.clientWidth;
      const height = shell.clientHeight;
      // wait for a measurable frame
      if (width <= 0 || height <= 0) return;
      const scale = Math.min(width / browserDesktopViewportWidth, 1);
      shell.style.setProperty('--browser-desktop-width', `${browserDesktopViewportWidth}px`);
      shell.style.setProperty('--browser-desktop-scale', String(scale));
      shell.style.setProperty('--browser-desktop-height', `${height / scale}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    measure();
    return () => observer.disconnect();
  }, []);
  // navigate without replacing the frame
  const loadFrame = useCallback((target: string, device = mobile) => {
    loadedFrameSource.current = target;
    const source = browserDeviceUrl(target, device);
    setDeviceError(undefined);
    setFrameSource(source);
    frameRef.current?.setAttribute('src', source);
  }, [mobile]);
  // refresh the retained location
  const refreshFrame = useCallback(() => {
    expectedFrameLoad.current = true;
    setLoading(true);
    setFrameAwayFromKnownUrl(false);
    loadFrame(loadedFrameSource.current);
  }, [loadFrame]);
  // apply parent-directed navigation
  useEffect(() => {
    const explicitlyRequested = navigationRequest !== undefined && appliedNavigationSequence.current !== navigationRequest.sequence;
    const target = explicitlyRequested ? navigationRequest.url : normalizedUrl;
    // skip retained locations already loaded by the pane
    if (!explicitlyRequested && loadedFrameSource.current === target) return;
    // consume one explicit navigation request
    if (explicitlyRequested) appliedNavigationSequence.current = navigationRequest.sequence;
    expectedFrameLoad.current = true;
    setLoading(true);
    setFrameAwayFromKnownUrl(false);
    loadFrame(target);
  }, [loadFrame, navigationRequest, normalizedUrl]);
  useEffect(() => {
    // accept reports only from this frame and project origin
    const syncReportedFrame = (event: MessageEvent<unknown>) => {
      // ignore unrelated messages
      if (event.source !== frameRef.current?.contentWindow || event.origin !== new URL(homeUrl).origin) return;
      // reload only the embedded browser
      if (isProjectBrowserRefreshMessage(event.data)) { refreshFrame(); return; }
      // surface failed identity emulation
      if (isProjectBrowserDeviceErrorMessage(event.data)) { setDeviceError(`Unable to apply device mode: ${event.data.properties.join(', ')}`); return; }
      // ignore unrelated project messages
      if (!isProjectBrowserLocationMessage(event.data)) return;
      // mark cooperative navigation
      if (onNavigate(event.data.url)) {
        loadedFrameSource.current = event.data.url;
        setFrameAwayFromKnownUrl(false);
      }
    };
    window.addEventListener('message', syncReportedFrame);
    return () => window.removeEventListener('message', syncReportedFrame);
  }, [homeUrl, onNavigate, refreshFrame]);
  // sync readable same-origin frame locations
  const syncFrameLocation = () => {
    const expected = expectedFrameLoad.current;
    expectedFrameLoad.current = false;
    setLoading(false);
    // track unreported frame navigation
    if (!expected) setFrameAwayFromKnownUrl(true);
    try {
      const current = frameRef.current?.contentWindow?.location.href;
      // retain a readable frame location
      if (current !== undefined && onNavigate(current)) {
        loadedFrameSource.current = current;
        setFrameAwayFromKnownUrl(false);
      }
    } catch { /* cross-origin frames can report with rac-browser-location */ }
  };
  // submit an owned browser location
  const navigate = () => {
    const target = normalizeBrowserUrl(address, homeUrl);
    // restore the retained address after invalid input
    if (target === undefined) { setAddress(url); return; }
    // avoid reloading an already known location
    if (target === normalizedUrl && !frameAwayFromKnownUrl) { setAddress(target); return; }
    expectedFrameLoad.current = true;
    setLoading(true);
    setFrameAwayFromKnownUrl(false);
    // reload an unknown in-frame location
    loadFrame(target);
    onNavigate(target);
  };
  // handle address submission
  const submitAddress = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); navigate(); };
  // update the editable address
  const changeAddress = (event: React.ChangeEvent<HTMLInputElement>) => setAddress(event.target.value);
  // return to the configured root
  const goHome = () => {
    expectedFrameLoad.current = true;
    setLoading(true);
    setFrameAwayFromKnownUrl(false);
    loadFrame(homeUrl);
    onNavigate(homeUrl);
  };
  // stop the active frame navigation
  const stopFrame = () => {
    try {
      frameRef.current?.contentWindow?.stop();
      expectedFrameLoad.current = false;
    } catch {
      // abort inaccessible cross-origin navigation
      expectedFrameLoad.current = true;
      loadFrame(loadedFrameSource.current);
    }
    setLoading(false);
  };
  // switch between refresh and stop
  const toggleFrameLoad = () => {
    // stop an active navigation
    if (loading) { stopFrame(); return; }
    refreshFrame();
  };
  // handle pane escape behavior
  const handleEscape = (event: React.KeyboardEvent<HTMLElement>) => {
    // ignore other keys
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // restore fullscreen before closing
    if (expanded) setExpanded(false);
    else onClose();
  };
  // apply both viewport and browser identity
  const toggleDevice = () => {
    const nextMobile = !mobile;
    saveBrowserMobile(worktreeId, nextMobile);
    setMobile(nextMobile);
    expectedFrameLoad.current = true;
    setLoading(true);
    setFrameAwayFromKnownUrl(false);
    loadFrame(loadedFrameSource.current, nextMobile);
  };
  return <section className={`browser-pane ${mobile ? 'mobile' : 'desktop'}${expanded ? ' expanded' : ''}`} role="dialog" aria-label="Browser" onKeyDown={handleEscape}><header className="browser-toolbar" role="toolbar" aria-label="Browser actions">{deviceError && <span className="browser-device-error" role="alert" title={deviceError}>Mode failed</span>}<form className="browser-address-form" onSubmit={submitAddress}><input type="text" inputMode="url" aria-label="Browser address" value={address} spellCheck={false} onChange={changeAddress} onBlur={navigate} /></form><button className="browser-home" type="button" aria-label="Go to project home" title="Home" disabled={atHome} onClick={goHome}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7" /></svg></button><button className="browser-device-toggle" type="button" aria-label={mobile ? 'Use desktop viewport and user agent' : 'Use mobile viewport and user agent'} aria-pressed={mobile} title={mobile ? 'Desktop viewport and user agent' : 'Mobile viewport and user agent'} onClick={toggleDevice}><svg data-device={mobile ? 'mobile' : 'desktop'} viewBox="0 0 24 24" aria-hidden="true">{mobile ? <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M10 5h4M11 19h2" /></> : <><rect x="3" y="5" width="18" height="13" rx="1" /><path d="M8 21h8M12 18v3" /></>}</svg></button><button className={`browser-refresh${loading ? ' loading' : ''}`} type="button" aria-label={loading ? 'Stop loading browser' : 'Refresh browser'} aria-busy={loading} title={loading ? 'Stop' : 'Refresh'} onClick={toggleFrameLoad}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={loading ? 'm6 6 12 12M18 6 6 18' : 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6'} /></svg></button><button className="browser-expand" type="button" aria-label={expanded ? 'Exit browser fullscreen' : 'Enter browser fullscreen'} aria-pressed={expanded} title={expanded ? 'Exit fullscreen' : 'Fullscreen'} onClick={() => setExpanded(value => !value)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={expanded ? 'M9 3v6H3m18 6h-6v6M3 9l6-6m6 18 6-6' : 'M9 3H3v6m18 6v6h-6M3 3l6 6m6 6 6 6'} /></svg></button><button className="browser-close" type="button" aria-label="Close browser" title="Close" onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header><div ref={frameShellRef} className={`browser-frame-shell ${mobile ? 'mobile' : 'desktop'}`}><iframe ref={frameRef} src={frameSource} title="Project browser" referrerPolicy="no-referrer" onLoad={syncFrameLocation} /></div></section>;
}

type SplitPanel = 'agent'|'note'|'browser';
type SplitSizes = Record<SplitPanel, number>;
type SplitStyle = React.CSSProperties & { '--agent-split': string; '--note-split': string; '--browser-split': string };
type SplitDrag = { pointerId: number; startX: number; left: SplitPanel; right: SplitPanel; leftWidth: number; rightWidth: number; sizes: SplitSizes; resized?: SplitSizes };
const splitPanelSelector: Record<SplitPanel, string> = { agent: '.log-output', note: '.note-pane', browser: '.browser-pane' };
const browserMobileWidth = 390;
const minimumSplitPanelWidth = browserMobileWidth;
// create an independent default layout
const defaultSplitSizes = (): SplitSizes => ({ agent: 1, note: 1, browser: 1 });
// scope split layouts to one browser client and workspace composition
const splitSizesKey = (worktreeId: string, signature: string) => `rac.split-sizes:${worktreeId}:${signature}`;
// restore one validated browser-local layout
const savedSplitSizes = (worktreeId: string | undefined, signature: string): SplitSizes => {
  // keep unscoped agent layouts ephemeral
  if (worktreeId === undefined) return defaultSplitSizes();
  try {
    const stored = JSON.parse(localStorage.getItem(splitSizesKey(worktreeId, signature)) ?? 'null') as Partial<SplitSizes> | null;
    // reject missing, nonnumeric, or unreasonable panel weights
    if (stored !== null
      && typeof stored.agent === 'number' && Number.isFinite(stored.agent) && stored.agent > 0 && stored.agent <= 100_000
      && typeof stored.note === 'number' && Number.isFinite(stored.note) && stored.note > 0 && stored.note <= 100_000
      && typeof stored.browser === 'number' && Number.isFinite(stored.browser) && stored.browser > 0 && stored.browser <= 100_000) return stored as SplitSizes;
  } catch { /* browser storage is optional */ }
  return defaultSplitSizes();
};
// persist one user-adjusted browser-local layout
const saveSplitSizes = (worktreeId: string | undefined, signature: string, sizes: SplitSizes) => {
  // keep unscoped agent layouts ephemeral
  if (worktreeId === undefined) return;
  try { localStorage.setItem(splitSizesKey(worktreeId, signature), JSON.stringify(sizes)); }
  catch { /* browser storage is optional */ }
};
// render ordered resizable output panels
function ResizableLogSplit({ worktreeId, output, note, browser }: { worktreeId?: string; output: ReactNode; note?: ReactNode; browser?: ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<SplitDrag | undefined>(undefined);
  const hasNote = note !== undefined && note !== null;
  const hasBrowser = browser !== undefined && browser !== null;
  const signature = `${hasNote ? 'note' : ''}:${hasBrowser ? 'browser' : ''}`;
  const [sizes, setSizes] = useState<SplitSizes>(() => savedSplitSizes(worktreeId, signature));
  const [mobilePanel, setMobilePanel] = useState<'agent'|'browser'>('agent');
  // restore the exact workspace layout for each open-panel composition
  useEffect(() => setSizes(savedSplitSizes(worktreeId, signature)), [signature, worktreeId]);
  // start every mobile split on the agent
  useEffect(() => setMobilePanel('agent'), [hasBrowser]);
  // collect current panel widths
  const measuredSizes = () => {
    const container = containerRef.current;
    const measured: SplitSizes = { agent: 1, note: 1, browser: 1 };
    // retain every visible panel width
    for (const panel of ['agent', 'note', 'browser'] as const) {
      const element = container?.querySelector<HTMLElement>(`:scope > ${splitPanelSelector[panel]}`);
      // skip closed panels
      if (element !== null && element !== undefined) measured[panel] = element.getBoundingClientRect().width;
    }
    return measured;
  };
  // begin pointer resizing
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    // accept primary-button drags only
    if (event.button !== 0) return;
    const left = event.currentTarget.dataset.left as SplitPanel;
    const right = event.currentTarget.dataset.right as SplitPanel;
    const measured = measuredSizes();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, left, right, leftWidth: measured[left], rightWidth: measured[right], sizes: measured };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  // apply pointer resizing
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    // ignore unrelated pointers
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const combined = drag.leftWidth + drag.rightWidth;
    const minimum = minimumSplitPanelWidth;
    const leftWidth = Math.max(minimum, Math.min(combined - minimum, drag.leftWidth + event.clientX - drag.startX));
    const resized = { ...drag.sizes, [drag.left]: leftWidth, [drag.right]: combined - leftWidth };
    // retain the final pointer position for pointerup persistence
    dragRef.current = { ...drag, resized };
    setSizes(resized);
  };
  // finish pointer resizing
  const stopResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    // ignore unrelated pointers
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    // persist only layouts that the user actually moved
    if (drag.resized !== undefined) saveSplitSizes(worktreeId, signature, drag.resized);
    // release an active drag capture
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  // resize with arrow keys
  const keyboardResize = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // handle horizontal arrows only
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const left = event.currentTarget.dataset.left as SplitPanel;
    const right = event.currentTarget.dataset.right as SplitPanel;
    const measured = measuredSizes();
    const combined = measured[left] + measured[right];
    const minimum = minimumSplitPanelWidth;
    const direction = event.key === 'ArrowLeft' ? -32 : 32;
    const leftWidth = Math.max(minimum, Math.min(combined - minimum, measured[left] + direction));
    const resized = { ...measured, [left]: leftWidth, [right]: combined - leftWidth };
    setSizes(resized);
    saveSplitSizes(worktreeId, signature, resized);
    event.preventDefault();
  };
  // switch the retained mobile split panel
  const toggleMobilePanel = () => setMobilePanel(current => current === 'browser' ? 'agent' : 'browser');
  const style: SplitStyle = { '--agent-split': `${sizes.agent}fr`, '--note-split': `${sizes.note}fr`, '--browser-split': `${sizes.browser}fr` };
  const noteDivider = hasNote ? <div className="split-resizer note-resizer" role="separator" aria-label="Resize agent and note panels" aria-orientation="vertical" tabIndex={0} data-left="agent" data-right="note" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={keyboardResize} /> : null;
  const browserDivider = hasBrowser ? <div className="split-resizer browser-resizer" role="separator" aria-label={`Resize ${hasNote ? 'note' : 'agent'} and browser panels`} aria-orientation="vertical" tabIndex={0} data-left={hasNote ? 'note' : 'agent'} data-right="browser" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={keyboardResize} /> : null;
  // expose the hidden mobile split peer
  const mobileSwitch = hasBrowser ? <button className="mobile-split-switch" type="button" aria-label={mobilePanel === 'browser' ? 'Show agent output' : 'Show project browser'} title={mobilePanel === 'browser' ? 'Agent output' : 'Project browser'} onClick={toggleMobilePanel}><svg viewBox="0 0 24 24" aria-hidden="true">{mobilePanel === 'browser' ? <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="m7 9 3 3-3 3M12 15h5" /></> : <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>}</svg></button> : null;
  return <div ref={containerRef} className={`log-split${hasNote ? ' has-note' : ''}${hasBrowser ? ` has-browser mobile-${mobilePanel}-view` : ''}`} style={style}>{output}{noteDivider}{note}{browserDivider}{browser}{mobileSwitch}</div>;
}

// format one git stat number
const gitNumberLabel = (count: number) => count.toLocaleString('en-US');
// pluralize one git stat count
const gitCountLabel = (count: number, label: string) => `${gitNumberLabel(count)} ${label}${count === 1 ? '' : 's'}`;
const gitConflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const gitChangeState = (code: string) => code === '??' ? 'untracked' : gitConflictCodes.has(code) ? 'conflicted' : code[0] !== ' ' && code[1] !== ' ' ? 'mixed' : code[0] !== ' ' ? 'staged' : 'unstaged';
const gitSupportingFile = (path: string) => {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  return /(^|\/)(?:__tests__|e2e|specs?|tests?)(?:\/|$)/u.test(lower)
    || /(?:^|[._-])(?:spec|test)(?:[._-]|$)/u.test(name)
    || /(^|\/)(?:docs?|documentation)(?:\/|$)/u.test(lower)
    || /\.(?:adoc|md|mdx|rst)$/u.test(name)
    || /^(?:changelog|code_of_conduct|contributing|license|readme|security)(?:\.|$)/u.test(name);
};
// prefer server-owned change categories
const gitSupportingChange = (change: GitStatusChange) => change.category === undefined ? gitSupportingFile(change.path) : change.category !== 'implementation';
const gitLineTotals = (changes: GitStatusChange[]) => changes.reduce((totals, change) => ({ additions: totals.additions + (change.additions ?? 0), deletions: totals.deletions + (change.deletions ?? 0) }), { additions: 0, deletions: 0 });
// render one git line summary
function GitLineSummary({ additions, deletions, className }: { additions: number; deletions: number; className: string }) {
  const label = [additions > 0 ? `${gitCountLabel(additions, 'line')} added` : undefined, deletions > 0 ? `${gitCountLabel(deletions, 'line')} removed` : undefined].filter(Boolean).join(', ') || 'No lines added or removed';
  return <span className={className} aria-label={label}><span className="git-lines-added">{additions > 0 ? `+${gitNumberLabel(additions)}` : ''}</span><span className="git-lines-deleted">{deletions > 0 ? `−${gitNumberLabel(deletions)}` : ''}</span></span>;
}
// render one clickable changed-file group
function GitChangeGroup({ label, changes, onOpenFile }: { label: string; changes: GitStatusChange[]; onOpenFile: (path: string) => void }) {
  if (changes.length === 0) return null;
  const totals = gitLineTotals(changes);
  return <span className="git-status-group" role="group" aria-label={`${label} files`}><span className="git-status-group-header"><strong>{label}</strong><span>{gitCountLabel(changes.length, 'file')}</span><GitLineSummary {...totals} className="git-status-group-lines" /></span><span className="git-status-file-list">{changes.map((change, index) => <button className={`git-status-file ${gitChangeState(change.code)}`} type="button" aria-label={`Preview ${change.path}`} title={`Preview ${change.path}`} key={`${change.code}:${change.path}:${index}`} onClick={() => onOpenFile(change.path)}><span className="git-status-file-code" aria-hidden="true">{change.code}</span><span className="git-status-file-path">{change.originalPath === undefined ? change.path : `${change.originalPath} → ${change.path}`}</span>{change.additions === undefined || change.deletions === undefined ? <span className="git-status-file-lines unavailable">binary</span> : <GitLineSummary additions={change.additions} deletions={change.deletions} className="git-status-file-lines" />}</button>)}</span></span>;
}
// render working and pull-request changes
function GitStatus({ branch, summary, prSummary, expanded = false, onToggle, onOpenFile, onReview, reviewOpen = false, reviewUnavailable }: { branch?: string; summary?: GitStatusSummary; prSummary?: GitComparisonSummary; expanded?: boolean; onToggle?: () => void; onOpenFile: (path: string) => void; onReview?: (scope: ReviewScope) => void; reviewOpen?: boolean; reviewUnavailable?: string }) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const [mode, setMode] = useState<'working' | 'pr'>(prSummary === undefined ? 'working' : 'pr');
  // default new branches to all pr changes
  useEffect(() => { setMode(prSummary === undefined ? 'working' : 'pr'); }, [branch]);
  // keep the selected view available
  useEffect(() => {
    // fall back when comparison disappears
    if (mode === 'pr' && prSummary === undefined) setMode('working');
  }, [mode, prSummary]);
  // fit the popup above the toolbar
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    // wait for an expanded anchor
    if (!expanded || wrap === null) return;
    // measure the available viewport
    // place the portal at its former anchored position
    const syncPanelPosition = () => {
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const anchorTop = wrap.getBoundingClientRect().top;
      const gap = rootFontSize * .7;
      const maxHeight = Math.max(0, Math.floor(anchorTop - viewportTop - gap));
      setPanelStyle({ position: 'fixed', top: 'auto', right: '.375rem', bottom: window.innerHeight - anchorTop + gap, left: 'auto', maxHeight, visibility: 'visible' });
    };
    const observer = new ResizeObserver(syncPanelPosition);
    observer.observe(wrap);
    const shell = wrap.closest('.log-shell');
    // follow shell size changes
    if (shell !== null) observer.observe(shell);
    window.addEventListener('resize', syncPanelPosition);
    window.addEventListener('scroll', syncPanelPosition, true);
    window.visualViewport?.addEventListener('resize', syncPanelPosition);
    window.visualViewport?.addEventListener('scroll', syncPanelPosition);
    syncPanelPosition();
    // release viewport listeners
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncPanelPosition);
      window.removeEventListener('scroll', syncPanelPosition, true);
      window.visualViewport?.removeEventListener('resize', syncPanelPosition);
      window.visualViewport?.removeEventListener('scroll', syncPanelPosition);
    };
  }, [expanded]);
  // hide outside repositories
  if (branch === undefined) return null;
  const state = summary === undefined ? 'unavailable' : summary.files === 0 ? 'clean' : summary.conflicted > 0 ? 'conflicted' : 'dirty';
  const stateLabel = summary === undefined
    ? 'status unavailable'
    : summary.files === 0
      ? 'clean'
      : summary.conflicted > 0
        ? `${gitCountLabel(summary.conflicted, 'conflict')} · ${gitCountLabel(summary.files, 'change')}`
        : gitCountLabel(summary.files, 'change');
  const details = summary === undefined ? [] : [
    summary.staged > 0 ? gitCountLabel(summary.staged, 'staged file') : undefined,
    summary.unstaged > 0 ? gitCountLabel(summary.unstaged, 'unstaged file') : undefined,
    summary.untracked > 0 ? gitCountLabel(summary.untracked, 'untracked file') : undefined
  ].filter((value): value is string => value !== undefined);
  const label = `Git status: ${branch}; ${stateLabel}${details.length === 0 ? '' : ` (${details.join(', ')})`}`;
  const activeSummary = mode === 'working' ? summary : prSummary;
  const implementationChanges = activeSummary?.changes?.filter(change => !gitSupportingChange(change)) ?? [];
  const supportingChanges = activeSummary?.changes?.filter(gitSupportingChange) ?? [];
  const changedFiles = activeSummary?.changes;
  const prTotals = gitLineTotals(prSummary?.changes ?? []);
  const panelDetails = mode === 'working'
    ? details
    : prSummary === undefined
      ? []
      : [`Compared with ${prSummary.base}`, gitCountLabel(prSummary.files, 'file'), `+${gitNumberLabel(prTotals.additions)} −${gitNumberLabel(prTotals.deletions)}`];
  const emptyLabel = activeSummary?.files === 0 ? mode === 'working' ? 'No working changes' : 'No PR changes' : 'Changed-file details unavailable';
  const disabledReviewReason = reviewOpen ? undefined : reviewUnavailable ?? (activeSummary === undefined ? 'Selected changes unavailable' : undefined);
  const reviewLabel = reviewOpen ? 'Open Review' : 'Review';
  return <span ref={wrapRef} className={`git-status-wrap${expanded ? ' expanded' : ''}`}><button className={`git-status-summary ${state}`} type="button" aria-label={label} aria-expanded={expanded} title={label} onClick={onToggle}><span className="git-branch">{branch}</span><span className="git-status-separator" aria-hidden="true">·</span><span className="git-worktree-state">{stateLabel}</span></button>{expanded && <FlyoutPortal onDismiss={() => onToggle?.()}><div className="git-status-panel" role="region" aria-label="Changed files" style={panelStyle}><span className="git-status-panel-header"><strong>{mode === 'working' ? 'Working changes' : 'PR changes'}</strong>{panelDetails.length > 0 && <small className="git-status-details">{panelDetails.join(' · ')}</small>}</span>{changedFiles !== undefined && changedFiles.length > 0 ? <span className="git-status-files"><GitChangeGroup label="Implementation" changes={implementationChanges} onOpenFile={onOpenFile} /><GitChangeGroup label="TESTS & DOCS" changes={supportingChanges} onOpenFile={onOpenFile} /></span> : <span className="git-status-empty">{emptyLabel}</span>}<span className="git-status-panel-footer"><button className="git-status-review" type="button" disabled={onReview === undefined || disabledReviewReason !== undefined} title={disabledReviewReason ?? (reviewOpen ? 'Open the current guided review' : `Start guided review of ${mode === 'working' ? 'Working' : 'All PR'} changes`)} onClick={() => onReview?.(mode)}>{reviewLabel}</button><span className="git-status-mode" role="group" aria-label="Git change view"><button type="button" aria-pressed={mode === 'working'} onClick={() => setMode('working')}>Working</button><button type="button" aria-pressed={mode === 'pr'} disabled={prSummary === undefined} title={prSummary === undefined ? 'Merge target unavailable' : `Compare with ${prSummary.base}`} onClick={() => setMode('pr')}>All PR</button></span></span></div></FlyoutPortal>}</span>;
}

type LogProps = { id: string; worktreeId?: string; branch?: string; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; history: PromptHistoryEntry[]; refreshHistory: () => Promise<void>; onQuestion: (question: ChoiceQuestion | undefined) => void; onMetadata?: (response: string | undefined) => void; cleanupControl?: ReactNode; browserUrl?: string; browserHomeUrl?: string; browserNavigationRequest?: ProjectBrowserNavigationRequest; onBrowserNavigate?: (url: string) => boolean; onBrowserOpen?: (url: string) => boolean; onBrowserClose?: () => void; terminalMode?: boolean; embedded?: boolean; onReview?: (scope: ReviewScope) => void; reviewOpen?: boolean; reviewUnavailable?: string; processingLabel?: string; processingDetail?: string };

// render reusable live agent output
function Log({ id, worktreeId, branch, gitStatus, gitPrStatus, history, refreshHistory, onQuestion, onMetadata, cleanupControl, browserUrl, browserHomeUrl, browserNavigationRequest, onBrowserNavigate, onBrowserOpen, onBrowserClose, terminalMode = false, embedded = false, onReview, reviewOpen = false, reviewUnavailable, processingLabel, processingDetail }: LogProps) {
  const canvas = useRef<HTMLDivElement | null>(null);
  const primaryHost = useRef<HTMLDivElement | null>(null);
  const secondaryHost = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | undefined>(undefined);
  const [visibleFrame, setVisibleFrame] = useState<0 | 1>(0);
  // A Log mounts whenever its tab becomes active. Existing agents therefore
  // begin by attaching to their live output, not by starting a new process.
  const [status, setStatus] = useState('Connecting');
  const [hasRendered, setHasRendered] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<string>();
  const [latestAssistantMessage, setLatestAssistantMessage] = useState<string>();
  const [latestAssistantMessageOverflows, setLatestAssistantMessageOverflows] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyAnswerId, setHistoryAnswerId] = useState<string>();
  const [toolbarExpanded, setToolbarExpanded] = useState<'git'>();
  const { anchorRef: historyAnchorRef, flyoutRef: historyFlyoutRef, style: historyFlyoutStyle } = useViewportFlyout(historyOpen);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const historyPanelOpenRef = useRef(false);
  const historyPinnedToLatestRef = useRef(true);
  const historyScrollIntentRef = useRef(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [inputActive, setInputActive] = useState(terminalMode);
  const [selectionActive, setSelectionActive] = useState(false);
  const [selectionToolbar, setSelectionToolbar] = useState<{ text: string; top: number }>();
  const copyOutputSelectionRef = useRef<(value: string) => Promise<void>>(copyText);
  const onMetadataRef = useRef(onMetadata);
  onMetadataRef.current = onMetadata;
  const worktreeBookmarks = useWorktreeBookmarks(worktreeId, id);
  const worktreeNotes = useWorktreeNotes(worktreeId, id, embedded ? undefined : latestAssistantMessage, embedded ? false : latestAssistantMessageOverflows, refreshHistory, history);
  const responseFiles = useLatestAssistantFiles(id, embedded ? undefined : latestAssistantMessage);
  const gitFilePreview = useFilePreview(`/api/agents/${encodeURIComponent(id)}/file-preview`);
  // retain preview handling across terminal connections
  const openOutputFileRef = useRef(responseFiles.openFile);
  openOutputFileRef.current = responseFiles.openFile;
  // retain browser routing across terminal connections
  const openOutputUrlRef = useRef<(url: string) => boolean>(() => false);
  openOutputUrlRef.current = url => browserUrl !== undefined && browserHomeUrl !== undefined && onBrowserOpen !== undefined && outputUrlMatchesHost(url, browserHomeUrl) && onBrowserOpen(url);
  // preview one changed branch file
  const openGitFile = (path: string) => {
    setToolbarExpanded(undefined);
    void gitFilePreview.openFile(path);
  };
  // refresh open history while answers arrive
  useEffect(() => {
    // require visible history
    if (!historyOpen) return;
    void refreshHistory();
    // catch completion persistence after the panel opens
    const interval = window.setInterval(() => { void refreshHistory(); }, 1_000);
    return () => window.clearInterval(interval);
  }, [historyOpen, refreshHistory]);
  useLayoutEffect(() => {
    const list = historyListRef.current;
    // reset closed history tracking
    if (!historyOpen || list === null) {
      historyPanelOpenRef.current = false;
      historyScrollIntentRef.current = false;
      return;
    }
    const opening = !historyPanelOpenRef.current;
    historyPanelOpenRef.current = true;
    // reset user intent for each opening
    if (opening) historyScrollIntentRef.current = false;
    let alignmentFrame: number | undefined;
    // follow latest only when opening or already pinned
    if (opening || historyPinnedToLatestRef.current) {
      // align after both current and pending layout
      const alignLatest = () => {
        list.scrollTop = list.scrollHeight;
        historyPinnedToLatestRef.current = true;
      };
      alignLatest();
      alignmentFrame = window.requestAnimationFrame(() => {
        // preserve immediate user scrolling
        if (historyPinnedToLatestRef.current) alignLatest();
      });
    }
    const openAnswer = list.querySelector<HTMLElement>('.prompt-history-entry.answer-open');
    // keep the selected answer visible
    if (openAnswer !== null) openAnswer.scrollIntoView({ block: 'nearest' });
    const observer = new ResizeObserver(() => {
      // follow layout changes only while pinned
      if (historyPinnedToLatestRef.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => {
      observer.disconnect();
      // cancel pending alignment
      if (alignmentFrame !== undefined) window.cancelAnimationFrame(alignmentFrame);
    };
  }, [historyOpen, history, historyAnswerId]);
  // mark deliberate history navigation
  const markHistoryScrollIntent = () => { historyScrollIntentRef.current = true; };
  // track whether history should follow new prompts
  const updateHistoryPin = () => {
    const list = historyListRef.current;
    // ignore closed or programmatic scrolling
    if (list === null || !historyScrollIntentRef.current) return;
    historyPinnedToLatestRef.current = Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) <= 1;
  };
  useEffect(() => {
    let socket: WebSocket | undefined;
    let closed = false;
    let retry: number | undefined;
    let snapshot = '';
    let latestQuestion = latestQuestions.get(id);
    let interactiveSocket: WebSocket | undefined;
    let connectingInteractive = false;
    let attemptedLogConnection = false;
    let pendingRender = false;
    let renderingSnapshot = false;
    let flushFrame: number | undefined;
    let resizeFrame: number | undefined;
    let overlayFrame: number | undefined;
    let analysisFrame: number | undefined;
    let connectedPaintFrame: number | undefined;
    let connectedPaintConfirmationFrame: number | undefined;
    let copiedSelectionTimer: number | undefined;
    let awaitingConnectedPaint = true;
    let connectionUpdateVersion = 0;
    let metadataRefreshPending = false;
    let dismissedQuestionId = dismissedQuestionIds.get(id);
    let rerenderAfterResize = () => {};
    const pendingInput: string[] = [];
    setStatus('Connecting');
    setHasRendered(false);
    setLastPrompt(lastPrompts.get(id));
    setToolbarExpanded(undefined);
    setLatestAssistantMessage(latestAssistantMessages.get(id));
    setLatestAssistantMessageOverflows(overflowingLatestAssistantMessages.has(id));
    setVisibleFrame(0);
    setInputActive(terminalMode);
    setSelectionActive(false);
    setSelectionToolbar(undefined);
    let historyOffset = 0;
    let requestHistory = (_offset: number) => {};
    const terminalTheme = { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#cba6f7', selectionForeground: '#11111b', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#89dceb', brightWhite: '#a6adc8' };
    const outputFontSize = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--output-font-size')) || 11;
    const terminalOptions = { convertEol: true, fontFamily: monoFontFamily, fontSize: outputFontSize, scrollback: 0, screenReaderMode: window.matchMedia('(pointer: coarse)').matches, theme: terminalTheme };
    const terminals = [new XTerm(terminalOptions), new XTerm(terminalOptions)];
    const fits = [new FitAddon(), new FitAddon()];
    let suppressOutputFocusUntil = 0;
    const overlays = createOutputLinkOverlays(canvas.current!, () => { suppressOutputFocusUntil = performance.now() + 250; }, path => { void openOutputFileRef.current(path); }, url => openOutputUrlRef.current(url));
    const releaseScrollContainment = containOutputScroll(canvas.current!);
    let activeFrame: 0 | 1 = 0;
    let terminal = terminals[activeFrame];
    terminalRef.current = terminal;
    terminals.forEach((candidate, index) => {
      candidate.loadAddon(fits[index]);
      candidate.open(index === 0 ? primaryHost.current! : secondaryHost.current!);
      Object.assign(candidate.element!.style, {
        fontFamily: monoFontFamily,
        fontKerning: 'none',
        fontSize: `${terminalOptions.fontSize}px`,
        fontWeight: 'normal'
      });
      fits[index].fit();
    });
    const scheduleOverlayRender = () => {
      if (overlayFrame !== undefined) return;
      overlayFrame = window.requestAnimationFrame(() => {
        overlayFrame = undefined;
        if (!closed) overlays.render(terminal);
      });
    };
    const encoded = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const connectInteractive = async () => {
      if (closed || connectingInteractive || interactiveSocket !== undefined) return;
      connectingInteractive = true;
      try {
        const response = await request(`/api/agents/${encodeURIComponent(id)}/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'input' }) });
        if (!response.ok) throw new Error('terminal ticket unavailable');
        const { ticket } = await response.json();
        if (closed) return;
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/input/${encodeURIComponent(id)}`, ['rac', ticket]);
        interactiveSocket = ws;
        ws.onopen = () => { if (closed || interactiveSocket !== ws) return; while (pendingInput.length) ws.send(JSON.stringify({ v: 1, type: 'input', data: encoded(pendingInput.shift()!) })); };
        ws.onclose = () => { if (interactiveSocket === ws) interactiveSocket = undefined; };
        ws.onerror = () => ws.close();
      } catch { interactiveSocket = undefined; }
      finally { connectingInteractive = false; }
    };
    const sendInput = (value: string) => {
      if (interactiveSocket?.readyState === WebSocket.OPEN) interactiveSocket.send(JSON.stringify({ v: 1, type: 'input', data: encoded(value) }));
      else { pendingInput.push(value); void connectInteractive(); }
    };
    terminalInputs.set(id, sendInput);
    let outputModeActive = terminalMode;
    const exitInput = () => { outputModeActive = false; setInputActive(false); terminal.blur(); };
    exitTerminalInput.set(id, exitInput);
    // Keep one line in common between page windows so a line at the viewport boundary is never lost while paging.
    const moveHistory = (direction: -1 | 0 | 1) => {
      // Adjacent pages intentionally share five rows, preserving context at
      // the boundary without turning page navigation into a large jump.
      const step = Math.max(1, terminal.rows - 5);
      // Keep both controls interactive at the boundaries. The server clamps
      // unavailable history to the oldest available page.
      const next = direction < 0 ? historyOffset + step : direction > 0 ? Math.max(0, historyOffset - step) : 0;
      requestHistory(next);
    };
    logHistoryRequests.set(id, moveHistory);
    const sendViewport = () => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'viewport', cols: terminal.cols, rows: terminal.rows })); };
    const scheduleViewport = () => {
      if (resizeFrame !== undefined) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = undefined;
        if (closed) return;
        overlays.clear();
        fits.forEach(fit => fit.fit());
        rerenderAfterResize();
        scheduleOverlayRender();
        sendViewport();
      });
    };
    const observer = new ResizeObserver(scheduleViewport);
    observer.observe(canvas.current!);
    window.addEventListener('resize', scheduleViewport);
    window.visualViewport?.addEventListener('resize', scheduleViewport);
    const syncVisibleViewport = () => { if (document.visibilityState === 'visible') scheduleViewport(); };
    document.addEventListener('visibilitychange', syncVisibleViewport);
    window.addEventListener('pageshow', scheduleViewport);
    const syncScrollState = () => {
      setScrolledUp(historyOffset > 0);
    };
    const terminalSelectionActive = () => terminals.some(candidate => candidate.hasSelection());
    const nativeSelectionActive = () => {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed) return false;
      return [selection.anchorNode, selection.focusNode].some(node => node !== null && canvas.current?.contains(node));
    };
    const outputSelectionPresent = () => terminalSelectionActive() || nativeSelectionActive();
    const selectedOutput = () => {
      const selectedTerminal = terminals.find(candidate => candidate.hasSelection());
      if (selectedTerminal !== undefined) return selectedTerminal.getSelection();
      return nativeSelectionActive() ? window.getSelection()?.toString() ?? '' : '';
    };
    const flashCopiedOutputSelection = () => {
      const log = canvas.current?.closest('.log');
      log?.classList.add('selection-copied');
      terminals.filter(candidate => candidate.hasSelection()).forEach(candidate => {
        candidate.options.theme = { ...terminalTheme, selectionBackground: '#a6e3a1', selectionInactiveBackground: '#a6e3a1' };
      });
      if (copiedSelectionTimer !== undefined) window.clearTimeout(copiedSelectionTimer);
      copiedSelectionTimer = window.setTimeout(() => {
        copiedSelectionTimer = undefined;
        log?.classList.remove('selection-copied');
        terminals.forEach(candidate => { candidate.options.theme = { ...terminalTheme }; });
      }, selectionCopyFlashMs);
    };
    const copyOutputSelection = async (value: string) => {
      await copyText(value);
      if (!closed) flashCopiedOutputSelection();
    };
    copyOutputSelectionRef.current = copyOutputSelection;
    terminals.forEach(candidate => candidate.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      if (event.key === 'Tab' && outputModeActive) {
        event.preventDefault();
        event.stopPropagation();
        sendInput(event.shiftKey ? '\x1b[Z' : '\t');
        return false;
      }
      if (event.key.toLowerCase() !== 'c') return true;
      if ((event.ctrlKey || event.metaKey) && candidate.hasSelection()) {
        event.preventDefault();
        void copyOutputSelection(candidate.getSelection());
        return false;
      }
      return true;
    }));
    const interruptOutput = (event: KeyboardEvent) => {
      const controlC = event.key.toLowerCase() === 'c' || event.code === 'KeyC';
      if (!outputModeActive || !event.ctrlKey || event.shiftKey || event.metaKey || event.altKey || !controlC || selectedOutput()) return;
      event.preventDefault();
      event.stopPropagation();
      sendInput('\x03');
    };
    const copySelectionShortcut = (event: KeyboardEvent) => {
      if (isPromptKeyboardTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const yank = key === 'y' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      const terminalCopy = key === 'c' && event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
      if (!yank && !terminalCopy) return;
      const selected = selectedOutput();
      if (!selected) return;
      event.preventDefault();
      event.stopPropagation();
      void copyOutputSelection(selected);
    };
    const nativeOutputCopied = () => { if (nativeSelectionActive()) flashCopiedOutputSelection(); };
    let outputSelectionActive = false;
    const syncSelectionMode = () => {
      const nativeActive = nativeSelectionActive();
      const selectedTerminal = terminals.find(candidate => candidate.hasSelection());
      outputSelectionActive = selectedTerminal !== undefined || nativeActive;
      setSelectionActive(outputSelectionActive);
      if (!outputSelectionActive) flushSelectedOutput();
      if (nativeActive) {
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
        const rectangles = range === undefined ? [] : Array.from(range.getClientRects());
        const bounds = rectangles.at(-1) ?? range?.getBoundingClientRect();
        const text = selection?.toString() ?? '';
        if (!text || bounds === undefined) return setSelectionToolbar(undefined);
        return setSelectionToolbar({ text, top: Math.min(window.innerHeight - 48, bounds.bottom + 8) });
      }
      if (selectedTerminal === undefined) return setSelectionToolbar(undefined);
      const text = selectedTerminal.getSelection();
      const position = selectedTerminal.getSelectionPosition();
      const screen = selectedTerminal.element?.querySelector<HTMLElement>('.xterm-screen');
      if (!text || position === undefined || screen === null || screen === undefined) return setSelectionToolbar(undefined);
      const screenBounds = screen.getBoundingClientRect();
      const viewportRow = position.end.y - selectedTerminal.buffer.active.viewportY + 1;
      const selectionBottom = screenBounds.top + viewportRow * (screenBounds.height / selectedTerminal.rows);
      setSelectionToolbar({ text, top: Math.min(window.innerHeight - 48, selectionBottom + 8) });
    };
    const clearOutputSelection = () => {
      terminals.forEach(candidate => candidate.clearSelection());
      if (nativeSelectionActive()) window.getSelection()?.removeAllRanges();
      outputSelectionActive = false;
      setSelectionActive(false);
      setSelectionToolbar(undefined);
    };
    let flushSelectedOutput = () => {};
    // request one authoritative live scan
    const requestMetadataRefresh = () => {
      // coalesce unavailable or duplicate requests
      if (metadataRefreshPending || historyOffset !== 0 || socket?.readyState !== WebSocket.OPEN) return;
      metadataRefreshPending = true;
      socket.send(JSON.stringify({ v: 1, type: 'metadata' }));
    };
    // the server parses the viewed agent's inline question and sends the current
    // one on each authoritative metadata frame; the web no longer parses pane
    // text. `latestQuestion` mirrors that frame, cleared when it carries none.
    const currentQuestion = (): ChoiceQuestion | undefined => {
      // retire a stale optimistic dismissal once the answered question is gone or replaced
      if (dismissedQuestionId !== undefined && latestQuestion?.id !== dismissedQuestionId) {
        dismissedQuestionId = undefined;
        dismissedQuestionIds.delete(id);
      }
      if (latestQuestion === undefined || latestQuestion.id === dismissedQuestionId) return undefined;
      return choiceQuestionFromInline(latestQuestion);
    };
    // optimistically hide one just-answered question until the server reports it gone
    const answeredQuestion = (answered: ChoiceQuestion) => {
      dismissedQuestionId = answered.id;
      dismissedQuestionIds.set(id, answered.id);
      onQuestion(undefined);
    };
    answeredQuestionActions.set(id, answeredQuestion);
    // defer question analysis until output settles
    const scheduleOutputAnalysis = () => {
      if (terminalMode) return;
      if (analysisFrame !== undefined) return;
      analysisFrame = window.requestAnimationFrame(() => {
        analysisFrame = undefined;
        if (closed) return;
        onQuestion(currentQuestion());
      });
    };
    const appendWrites = createAnimationFrameTextBatcher(text => {
      const paintedSocket = socket;
      const paintedConnectionVersion = connectionUpdateVersion;
      if (closed || paintedSocket === undefined) return;
      if (terminalSelectionActive() || renderingSnapshot) {
        pendingRender = true;
        return;
      }
      terminal.write(text, () => {
        terminal.scrollToBottom();
        scheduleOverlayRender();
        syncScrollState();
        revealConnectedOutput(paintedSocket, paintedConnectionVersion);
      });
    }, undefined, undefined, 1_000_000);
    const selectionSubscriptions = terminals.map(candidate => candidate.onSelectionChange(() => {
      syncSelectionMode();
      if (!terminalSelectionActive()) flushSelectedOutput();
    }));
    document.addEventListener('selectionchange', syncSelectionMode);
    window.addEventListener('keydown', interruptOutput, true);
    document.addEventListener('keydown', copySelectionShortcut, true);
    document.addEventListener('copy', nativeOutputCopied);
    const inputSubscriptions = terminals.map(candidate => candidate.onData(value => {
      const { alt, ctrl, shift } = mobileModifiers.get(id) ?? { alt: false, ctrl: false, shift: false };
      const first = value.charAt(0);
      const modified = `${alt ? '\x1b' : ''}${ctrl && /^[a-z]$/iu.test(first) ? String.fromCharCode(first.toLowerCase().charCodeAt(0) - 96) : shift && /^[a-z]$/iu.test(first) ? `${first.toUpperCase()}${value.slice(1)}` : value}`;
      sendInput(modified);
    }));
    let selectionModeAtPointerDown = false;
    const captureSelectionMode = () => {
      // Pointer-down capture runs before the browser collapses a native range.
      // Remember that the tap began in selection mode so its later click cannot
      // fall through and activate terminal input.
      selectionModeAtPointerDown = outputSelectionActive || terminalSelectionActive() || nativeSelectionActive();
    };
    const focus = () => {
      if (performance.now() < suppressOutputFocusUntil) {
        suppressOutputFocusUntil = 0;
        return;
      }
      // Capture native accessibility-tree selection before the click's default
      // action can collapse it on mobile.
      const selectedTextAtClick = window.getSelection()?.toString() ?? '';
      const exitSelectionMode = selectionModeAtPointerDown || outputSelectionActive || Boolean(selectedTextAtClick);
      selectionModeAtPointerDown = false;
      if (exitSelectionMode) {
        clearOutputSelection();
        return exitInput();
      }
      if (selectedTextAtClick || terminalSelectionActive() || outputModeActive) return exitInput();
      outputModeActive = true;
      setInputActive(true);
      // Mobile browsers only open and retain the software keyboard when the
      // terminal textarea is focused synchronously from the user's tap.
      terminal.focus();
      void connectInteractive();
    };
    const releaseLongPressSelection = preserveOutputLongPressSelection(canvas.current!, () => {
      exitInput();
    });
    canvas.current!.addEventListener('pointerdown', captureSelectionMode, true);
    canvas.current!.addEventListener('click', focus);
    if (terminalMode) {
      terminal.focus();
      void connectInteractive();
    }
    const cachedSnapshot = terminalMode || embedded ? undefined : logSnapshots.get(id);
    let outputRendered = false;
    const markRendered = () => {
      if (outputRendered) return;
      outputRendered = true;
      setHasRendered(true);
    };
    const cancelConnectedPaint = () => {
      if (connectedPaintFrame !== undefined) window.cancelAnimationFrame(connectedPaintFrame);
      if (connectedPaintConfirmationFrame !== undefined) window.cancelAnimationFrame(connectedPaintConfirmationFrame);
      connectedPaintFrame = undefined;
      connectedPaintConfirmationFrame = undefined;
    };
    const revealConnectedOutput = (ws: WebSocket, paintedConnectionVersion: number) => {
      if (!awaitingConnectedPaint || paintedConnectionVersion === 0 || closed || socket !== ws || connectedPaintFrame !== undefined || connectedPaintConfirmationFrame !== undefined) return;
      // Keep the connecting treatment through the first frame that contains
      // fresh output. The nested animation frame runs after that DOM update
      // has had an opportunity to paint, so Live never precedes the output.
      connectedPaintFrame = window.requestAnimationFrame(() => {
        connectedPaintFrame = undefined;
        connectedPaintConfirmationFrame = window.requestAnimationFrame(() => {
          connectedPaintConfirmationFrame = undefined;
          if (closed || socket !== ws || !awaitingConnectedPaint) return;
          awaitingConnectedPaint = false;
          connectionUpdateVersion = 0;
          markRendered();
          setStatus('Live');
        });
      });
    };
    // restore cached questions before the live socket reconnects
    if (cachedSnapshot) { snapshot = cachedSnapshot; markRendered(); onQuestion(currentQuestion()); terminal.write(cachedSnapshot, () => { scheduleOverlayRender(); syncScrollState(); }); }
    const reconnect = () => {
      if (closed || retry !== undefined) return;
      retry = window.setTimeout(() => {
        retry = undefined;
        void connect();
      }, 1_000);
    };
    const renderSnapshot = (ws: WebSocket) => {
      if (closed || socket !== ws || renderingSnapshot || outputSelectionPresent()) {
        pendingRender = true;
        return;
      }
      renderingSnapshot = true;
      const renderedSnapshot = snapshot;
      const renderedConnectionVersion = connectionUpdateVersion;
      // Keep the currently focused xterm mounted while output input is active.
      // Hiding its frame during the normal double-buffer swap dismisses mobile
      // software keyboards even though the helper textarea remains focused.
      const preserveFocusedFrame = outputModeActive;
      const nextFrame: 0 | 1 = preserveFocusedFrame ? activeFrame : activeFrame === 0 ? 1 : 0;
      const nextTerminal = terminals[nextFrame];
      const viewport = `\x1b[H${bottomAlignedSnapshot(renderedSnapshot, nextTerminal.rows).replace(/\n/g, '\x1b[K\n')}\x1b[K\x1b[J`;
      nextTerminal.reset();
      nextTerminal.write(viewport, () => {
        renderingSnapshot = false;
        if (closed || socket !== ws) return;
        if (outputSelectionPresent()) {
          nextTerminal.reset();
          pendingRender = true;
          return;
        }
        // Input may have become active while the inactive frame was rendering.
        // Discard that frame and redraw into the focused terminal instead.
        if (outputModeActive && nextTerminal !== terminal) {
          nextTerminal.reset();
          pendingRender = true;
          return flushSelectedOutput();
        }
        if (preserveFocusedFrame) {
          scheduleOverlayRender();
          syncScrollState();
          revealConnectedOutput(ws, renderedConnectionVersion);
          if (snapshot !== renderedSnapshot) pendingRender = true;
          return flushSelectedOutput();
        }
        const previousTerminal = terminal;
        activeFrame = nextFrame;
        terminal = nextTerminal;
        terminalRef.current = terminal;
        scheduleOverlayRender();
        setVisibleFrame(activeFrame);
        revealConnectedOutput(ws, renderedConnectionVersion);
        requestAnimationFrame(() => { previousTerminal.reset(); syncScrollState(); });
        if (snapshot !== renderedSnapshot) pendingRender = true;
        flushSelectedOutput();
      });
    };
    flushSelectedOutput = () => {
      if (!pendingRender || outputSelectionPresent() || renderingSnapshot || closed || socket === undefined || flushFrame !== undefined) return;
      flushFrame = window.requestAnimationFrame(() => {
        flushFrame = undefined;
        if (!pendingRender || outputSelectionPresent() || renderingSnapshot || closed || socket === undefined) return;
        pendingRender = false;
        renderSnapshot(socket);
      });
    };
    rerenderAfterResize = () => {
      if (!snapshot || closed || socket === undefined) return;
      pendingRender = true;
      flushSelectedOutput();
    };
    const connect = async () => {
      if (attemptedLogConnection) {
        awaitingConnectedPaint = true;
        connectionUpdateVersion = 0;
        cancelConnectedPaint();
        setStatus('Connecting');
      }
      attemptedLogConnection = true;
      try {
        const response = await request(`/api/agents/${encodeURIComponent(id)}/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'logs' }) });
        if (!response.ok) throw new Error('ticket unavailable');
        const { ticket } = await response.json();
        if (closed) return;
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/logs/${encodeURIComponent(id)}`, ['rac', ticket]);
        socket = ws;
        requestHistory = offset => {
          historyOffset = Math.max(0, offset);
          syncScrollState();
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'history', offset: historyOffset, cols: terminal.cols, rows: terminal.rows }));
        };
        ws.onopen = () => {
          if (closed || socket !== ws) return;
          scheduleViewport();
          requestMetadataRefresh();
        };
        ws.onmessage = event => {
          if (closed || socket !== ws) return;
          const frame = JSON.parse(event.data) as LogFrame;
          const text = frame.text ?? '';
          if (frame.newer !== true) historyOffset = 0;
          syncScrollState();
          const latest = historyOffset === 0;
          const metadata = completeLogMetadata(frame);
          const metadataRefreshed = metadata !== undefined;
          if (!terminalMode && latest && frame.lastPrompt !== undefined) setLastPrompt(frame.lastPrompt);
          // the inline question rides every live frame, so it appears and clears
          // with the pane output rather than waiting on the periodic metadata frame
          if (!terminalMode && latest) latestQuestion = frame.question;
          // update complete history only from metadata frames
          if (!terminalMode && latest && metadata !== undefined) {
            setLatestAssistantMessage(metadata.latestAssistantMessage ?? undefined);
            setLatestAssistantMessageOverflows(metadata.latestAssistantMessageOverflows);
            onMetadataRef.current?.(metadata.latestAssistantMessage?.trim() || undefined);
            metadataRefreshPending = false;
          }
          // keep modal-only advisors out of shared tab caches
          if (!terminalMode && !embedded && latest) cacheLogFrame(id, frame);
          // apply authoritative empty resets
          if (!text) {
            // retain legacy empty-frame behavior
            if (!metadataRefreshed || frame.type !== 'reset') return;
            if (awaitingConnectedPaint) connectionUpdateVersion += 1;
            appendWrites.clear();
            snapshot = '';
            scheduleOutputAnalysis();
            // defer clears around active selection or rendering
            if (outputSelectionPresent() || renderingSnapshot) { pendingRender = true; return; }
            renderSnapshot(ws);
            return;
          }
          if (awaitingConnectedPaint) connectionUpdateVersion += 1;
          if (frame.type === 'reset') {
            // reanalyze unchanged output when metadata changes
            if (text === snapshot && !awaitingConnectedPaint) {
              if (metadataRefreshed) scheduleOutputAnalysis();
              return;
            }
            appendWrites.clear();
            snapshot = nextLiveSnapshot(snapshot, frame.type, text);
            scheduleOutputAnalysis();
            if (outputSelectionPresent() || renderingSnapshot) {
              pendingRender = true;
              return;
            }
            return renderSnapshot(ws);
          }
          snapshot = nextLiveSnapshot(snapshot, frame.type, text);
          scheduleOutputAnalysis();
          if (outputSelectionPresent() || renderingSnapshot) {
            pendingRender = true;
            return;
          }
          if (!appendWrites.push(text)) {
            appendWrites.clear();
            pendingRender = true;
            flushSelectedOutput();
          }
        };
        ws.onclose = () => {
          if (closed || socket !== ws) return;
          socket = undefined;
          appendWrites.clear();
          awaitingConnectedPaint = true;
          connectionUpdateVersion = 0;
          metadataRefreshPending = false;
          cancelConnectedPaint();
          setStatus('Connecting');
          reconnect();
        };
        ws.onerror = () => ws.close();
      } catch { setStatus('Connecting'); reconnect(); }
    };
    void connect();
    return () => { closed = true; appendWrites.clear(); cancelConnectedPaint(); if (terminalInputs.get(id) === sendInput) terminalInputs.delete(id); if (exitTerminalInput.get(id) === exitInput) exitTerminalInput.delete(id); if (logHistoryRequests.get(id) === moveHistory) logHistoryRequests.delete(id); if (answeredQuestionActions.get(id) === answeredQuestion) answeredQuestionActions.delete(id); if (retry !== undefined) window.clearTimeout(retry); if (flushFrame !== undefined) window.cancelAnimationFrame(flushFrame); if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame); if (overlayFrame !== undefined) window.cancelAnimationFrame(overlayFrame); if (analysisFrame !== undefined) window.cancelAnimationFrame(analysisFrame); if (copiedSelectionTimer !== undefined) window.clearTimeout(copiedSelectionTimer); selectionSubscriptions.forEach(subscription => subscription.dispose()); inputSubscriptions.forEach(subscription => subscription.dispose()); window.removeEventListener('resize', scheduleViewport); window.visualViewport?.removeEventListener('resize', scheduleViewport); document.removeEventListener('visibilitychange', syncVisibleViewport); window.removeEventListener('pageshow', scheduleViewport); document.removeEventListener('selectionchange', syncSelectionMode); window.removeEventListener('keydown', interruptOutput, true); document.removeEventListener('keydown', copySelectionShortcut, true); document.removeEventListener('copy', nativeOutputCopied); canvas.current?.closest('.log')?.classList.remove('selection-copied'); canvas.current?.removeEventListener('pointerdown', captureSelectionMode, true); canvas.current?.removeEventListener('click', focus); releaseLongPressSelection(); releaseScrollContainment(); observer.disconnect(); socket?.close(); interactiveSocket?.close(); if (terminalRef.current === terminal) terminalRef.current = undefined; overlays.clear(); terminals.forEach(candidate => candidate.dispose()); };
  }, [embedded, id, onQuestion, terminalMode]);
  const processing = processingLabel !== undefined;
  const loading = !hasRendered || processing;
  const visibleStatus = processing ? 'Starting' : terminalMode && status === 'Live' ? 'Terminal' : hasRendered && status === 'Connecting' ? 'Cached' : status;
  const cached = visibleStatus === 'Cached';
  const loadingLabel = processingLabel ?? (terminalMode ? 'Connecting to pane' : status === 'Live' ? 'Waiting for output' : status);
  const selectionActions = selectionToolbar === undefined || (!embedded && worktreeNotes.expanded) ? null : createPortal(<div className={`output-selection-toolbar${embedded ? ' embedded' : ''}`} role="toolbar" aria-label="Output selection actions" style={{ top: selectionToolbar.top }} onPointerDown={event => event.preventDefault()}>
    {!embedded && <button type="button" disabled={!worktreeNotes.canCreate || selectionToolbar.text.length > 30_000} onClick={() => void worktreeNotes.createWithText(selectionToolbar.text, assistantNoteTitle(selectionToolbar.text))}>Create note</button>}
    {!embedded && worktreeNotes.active && <button type="button" disabled={!worktreeNotes.canAppendToActive(selectionToolbar.text)} onClick={() => worktreeNotes.appendToActive(selectionToolbar.text)}>Append to note</button>}
    {!embedded && <button type="button" onClick={() => setPromptDraft(id, current => appendTextBlock(current, selectionToolbar.text))}>Add to prompt</button>}
    <button type="button" onClick={() => void copyOutputSelectionRef.current(selectionToolbar.text)}>Copy</button>
  </div>, document.body);
  // restore a previous prompt
  const useHistoryEntry = (entry: PromptHistoryEntry) => {
    setPromptDraft(id, entry.text);
    setHistoryOpen(false);
    setHistoryAnswerId(undefined);
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  };
  // toggle one recorded answer
  const toggleHistoryAnswer = (entry: PromptHistoryEntry) => setHistoryAnswerId(current => current === entry.id ? undefined : entry.id);
  // save one recorded answer as a formatted note
  const saveHistoryAnswer = (entry: PromptHistoryEntry) => {
    // require a bounded final answer
    if (entry.answer === undefined || entry.answer.length > 30_000) return;
    setHistoryOpen(false);
    setHistoryAnswerId(undefined);
    void worktreeNotes.createWithText(entry.answer, assistantNoteTitle(entry.answer));
  };
  const historyPanel = historyOpen && <FlyoutPortal onDismiss={() => { setHistoryOpen(false); setHistoryAnswerId(undefined); }}><section className="prompt-history-menu more-menu flyout-menu" ref={historyFlyoutRef} style={historyFlyoutStyle} aria-label="Prompt history"><header><strong>Prompt history</strong><span>{history.length}</span></header><div className="prompt-history-list" ref={historyListRef} onScroll={updateHistoryPin} onWheel={markHistoryScrollIntent} onTouchStart={markHistoryScrollIntent} onPointerDown={markHistoryScrollIntent} onKeyDown={markHistoryScrollIntent}>{history.length === 0 ? <p>No prompts have been queued for this worktree yet.</p> : [...history].reverse().map(entry => <div className={`prompt-history-entry${historyAnswerId === entry.id ? ' answer-open' : ''}`} key={entry.id}><button className="prompt-history-prompt" type="button" title={entry.text} onClick={() => useHistoryEntry(entry)}><span>{entry.text}</span><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></button><button className="prompt-history-answer-toggle" type="button" disabled={entry.answer === undefined} title={entry.answer === undefined ? 'Answer not recorded yet' : 'View final answer'} aria-label={`View answer for ${entry.text}`} aria-expanded={historyAnswerId === entry.id} onClick={() => toggleHistoryAnswer(entry)}>View answer</button>{historyAnswerId === entry.id && entry.answer !== undefined && <div className="prompt-history-answer" role="region" aria-label={`Answer for ${entry.text}`}><button className="prompt-history-save-note" type="button" disabled={!worktreeNotes.canCreate || entry.answer.length > 30_000} onClick={() => saveHistoryAnswer(entry)}>Save as note</button><div className="prompt-history-answer-text">{entry.answer}</div></div>}</div>)}</div></section></FlyoutPortal>;
  // open or close prompt history
  const toggleHistory = () => {
    const open = !historyOpen;
    setHistoryOpen(open);
    // close the toolbar before opening history
    if (open) setToolbarExpanded(undefined);
    // discard closed answer details
    else setHistoryAnswerId(undefined);
  };
  const historyToggle = !terminalMode ? <><span className="prompt-history-anchor" ref={historyAnchorRef}><button className={`prompt-history-toggle${historyOpen ? ' active' : ''}`} type="button" aria-label={`Prompt history (${history.length})`} title="Prompt history" aria-expanded={historyOpen} onClick={event => { event.stopPropagation(); toggleHistory(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M12 7v5l3 2" /></svg></button></span>{historyPanel}</> : null;
  // prefer the refreshed prompt history over a stale log frame
  const visibleLastPrompt = history[0]?.text ?? lastPrompt;
  const promptSection = !terminalMode ? <div className="toolbar-prompt-group">{historyToggle}{visibleLastPrompt !== undefined && <button className="toolbar-prompt" type="button" aria-label="Last prompt" aria-expanded={historyOpen} title={visibleLastPrompt} onClick={toggleHistory}><span className="toolbar-prompt-text">{visibleLastPrompt}</span></button>}</div> : null;
  const gitSection = embedded ? null : <GitStatus branch={branch} summary={gitStatus} prSummary={gitPrStatus} expanded={toolbarExpanded === 'git'} onToggle={() => { setHistoryOpen(false); setToolbarExpanded(current => current === 'git' ? undefined : 'git'); }} onOpenFile={openGitFile} onReview={scope => { setToolbarExpanded(undefined); onReview?.(scope); }} reviewOpen={reviewOpen} reviewUnavailable={reviewUnavailable} />;
  // distinguish retained output from live frames
  const output = <div className={`log-output${cached ? ' cached' : ''}`}>{!embedded && <ServerSwitcher className="output-server-switcher" />}<div className="log-canvas" ref={canvas} aria-label={terminalMode ? 'Interactive agent pane' : 'Live log'}><div ref={primaryHost} className={`terminal-frame ${visibleFrame === 0 ? 'active' : ''}`} /><div ref={secondaryHost} className={`terminal-frame ${visibleFrame === 1 ? 'active' : ''}`} /></div>{cached && <div className="log-cached-treatment" aria-hidden="true"><span>Cached view · reconnecting</span></div>}{((status !== 'Live' && !hasRendered) || processing) && <div className="log-stale-overlay" aria-hidden="true" />}{loading && <div className="log-loading" role={processing ? 'status' : undefined} aria-label={processing ? processingLabel : undefined}><span className="spinner" /><strong>{loadingLabel}</strong>{processingDetail && <span>{processingDetail}</span>}</div>}<span className={`status log-status ${visibleStatus.toLowerCase()}`}>{visibleStatus}</span><div className="log-footer">{!terminalMode && <div className="log-controls-bottom"><div className="page-controls">{!embedded && cleanupControl}{!embedded && responseFiles.control}{!embedded && worktreeBookmarks.control}{!embedded && worktreeNotes.control}<button className="log-control page-arrow" aria-label="Page up" title="Page up" onPointerDown={event => event.preventDefault()} onClick={() => logHistoryRequests.get(id)?.(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><div className="page-down-controls">{scrolledUp && <button className="log-control page-arrow back-to-bottom" aria-label="Back to bottom" title="Back to bottom" onPointerDown={event => event.preventDefault()} onClick={() => logHistoryRequests.get(id)?.(0)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h14M6 8l6 6 6-6" /></svg></button>}<button className="log-control page-arrow" aria-label="Page down" title="Page down" onPointerDown={event => event.preventDefault()} onClick={() => logHistoryRequests.get(id)?.(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div></div></div>}</div></div>;
  const browserPane = browserUrl === undefined || browserHomeUrl === undefined || onBrowserNavigate === undefined || onBrowserClose === undefined ? null : <ProjectBrowserPane url={browserUrl} homeUrl={browserHomeUrl} worktreeId={worktreeId} navigationRequest={browserNavigationRequest} onNavigate={onBrowserNavigate} onClose={onBrowserClose} />;
  return <section className={`log-shell${embedded ? ' embedded-log-shell' : ''}`}><div className={`log${embedded ? ' embedded-log' : ''}${terminalMode ? ' inline-terminal' : ''}${inputActive ? ' input-active' : ''}${selectionActive ? ' selection-active' : ''}`}><ResizableLogSplit worktreeId={worktreeId} output={output} note={embedded ? undefined : worktreeNotes.pane} browser={browserPane} /></div>{selectionActions}{!embedded && responseFiles.dialog}{!embedded && gitFilePreview.dialog}{!embedded && <div className={`log-topbar${toolbarExpanded === undefined ? '' : ' expanded'}`}>{promptSection}{gitSection}</div>}</section>;
}

type MoreMenuIconName = 'actions'|'attachment'|'new-task'|'pull-request'|'push'|'swap';
function MoreMenuIcon({ name }: { name: MoreMenuIconName }) {
  if (name === 'pull-request') return <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M6 8.5v7M18 8.5v2.5a7 7 0 0 1-7 7H8.5M15.5 6H13" /></svg>;
  const paths: Record<Exclude<MoreMenuIconName, 'pull-request'>, string> = {
    actions: 'M8 5v14l11-7L8 5ZM4 5h1M4 12h1M4 19h1',
    attachment: 'm9 12 5.7-5.7a3.5 3.5 0 1 1 5 5L11 20a5 5 0 1 1-7-7l8.3-8.3',
    'new-task': 'M12 5v14M5 12h14',
    push: 'M12 16V4m0 0-5 5m5-5 5 5M5 14v5h14v-5',
    swap: 'M5 7h13m0 0-4-4m4 4-4 4M19 17H6m0 0 4 4m-4-4 4-4'
  };
  return <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

// retain only safe pull request actions
function switchablePullRequests(values: unknown[]): SwitchablePullRequest[] {
  return values.filter((value): value is SwitchablePullRequest => {
    // require the core pull request fields
    if (value === null || typeof value !== 'object' || !Number.isInteger((value as PullRequestChoice).number) || typeof (value as PullRequestChoice).title !== 'string' || typeof (value as PullRequestChoice).branch !== 'string' || typeof (value as PullRequestChoice).draft !== 'boolean' || typeof (value as PullRequestChoice).url !== 'string' || typeof (value as SwitchablePullRequest).checkedOut !== 'boolean') return false;
    const checks = (value as PullRequestChoice).checks;
    // constrain the optional CI status
    if (checks !== undefined && checks !== 'passed' && checks !== 'pending' && checks !== 'failed') return false;
    const issues = (value as PullRequestChoice).issues;
    // constrain the optional issue flags
    if (issues !== undefined && (issues === null || typeof issues !== 'object' || Object.entries(issues).some(([name, enabled]) => !['mergeConflicts', 'failingChecks', 'unresolvedComments'].includes(name) || typeof enabled !== 'boolean'))) return false;
    const openIn = (value as SwitchablePullRequest).openIn;
    return openIn === undefined || (openIn !== null && typeof openIn === 'object' && typeof openIn.worktreeId === 'string' && typeof openIn.worktreeName === 'string' && (openIn.agentId === undefined || typeof openIn.agentId === 'string'));
  });
}

// explain one unavailable switch target
function pullRequestCheckoutReason(pullRequest: SwitchablePullRequest, enabled: boolean, refreshFailed: boolean): string {
  // prioritize stale remote data
  if (refreshFailed) return 'Pull request list could not be refreshed';
  // reject an unresolvable checkout owner
  if (pullRequest.checkedOut && pullRequest.openIn === undefined) return 'Already open in another worktree';
  // protect a dirty working copy
  if (!enabled) return 'Working copy must be clean and pushed';
  return pullRequest.checkedOut ? `Move PR #${pullRequest.number} here` : `Checkout PR #${pullRequest.number}`;
}

// render one pull request switch target
function SwitchPullRequestOption({ pullRequest, enabled, loading, refreshFailed, switchingPr, movingPr, onSwitch, onMove, onSelectTarget }: { pullRequest: SwitchablePullRequest; enabled: boolean; loading: boolean; refreshFailed: boolean; switchingPr?: number; movingPr?: number; onSwitch: (number: number) => void | Promise<void>; onMove: (number: number) => void | Promise<void>; onSelectTarget: (target: DashboardTarget) => void }) {
  const status = pullRequest.draft ? 'draft' : 'open';
  const label = `#${pullRequest.number}: ${pullRequest.title}`;
  const openIn = pullRequest.openIn;
  // expose checkout ownership in the row
  const checkoutOwner = pullRequest.checkedOut ? `Already open in ${openIn?.worktreeName ?? 'another worktree'}` : undefined;
  const operationPending = switchingPr !== undefined || movingPr !== undefined;
  const checkoutReason = pullRequestCheckoutReason(pullRequest, enabled, refreshFailed);
  // run one checkout transaction
  const checkout = () => {
    // transfer occupied branches
    if (pullRequest.checkedOut) return void onMove(pullRequest.number);
    void onSwitch(pullRequest.number);
  };
  return <div className="switch-pr-option"><a className="switch-pr" href={pullRequest.url} target="_blank" rel="noreferrer" title={`Open ${label} in GitHub`} aria-label={label}><span className="switch-pr-copy"><span><strong className={`status-${status}`}>#{pullRequest.number}</strong><span>: {pullRequest.title}</span></span>{checkoutOwner !== undefined && <small className="switch-pr-open-in">{checkoutOwner}</small>}</span></a><span className="switch-pr-actions"><PullRequestStatusIcon status={status} className="switch-pr-status-icon" /><PullRequestIndicators checks={pullRequest.checks} issues={pullRequest.issues} /><button className="switch-pr-action switch-pr-checkout outline-button" disabled={loading || refreshFailed || operationPending || !enabled || pullRequest.checkedOut && openIn === undefined} title={checkoutReason} onClick={checkout}>{movingPr === pullRequest.number ? <><span className="spinner" />Moving…</> : switchingPr === pullRequest.number ? <><span className="spinner" />Checking out…</> : 'Checkout'}</button>{openIn !== undefined && <button className="switch-pr-action switch-pr-worktree outline-button" disabled={operationPending} onClick={() => onSelectTarget(openIn)}>Switch to {openIn.worktreeName}</button>}</span></div>;
}

// explain pull request availability
function pullRequestStatusReason(loading: boolean, error: string | undefined, loaded: boolean, availability: PullRequestSwitchAvailability | undefined): string | undefined {
  // prioritize active loading
  if (loading) return 'Loading pull requests…';
  // preserve one actionable error
  if (error !== undefined) return error;
  // distinguish an unavailable endpoint
  if (loaded && availability === undefined) return 'Pull requests unavailable.';
  // explain an empty owned list
  if (availability?.pullRequests.length === 0) return availability.otherPullRequests.length > 0 ? 'No open pull requests by you.' : 'No open pull requests.';
  return undefined;
}

// render the agent action menu
function More({ id, worktreeId, newTaskConfigured = false, pushAction = defaultPushAction, attachDisabled = false, onAttach, swapDisabled = false, onSwap, onPromptQueued, onSelectTarget, onOperationFeedback }: { id?: string; worktreeId?: string; newTaskConfigured?: boolean; pushAction?: PromptAction; attachDisabled?: boolean; onAttach?: () => void; swapDisabled?: boolean; onSwap?: () => void; onPromptQueued?: () => void | Promise<void>; onSelectTarget: (target: DashboardTarget) => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const [menuOpen, setMenuOpen] = useState(false); const { anchorRef, flyoutRef, style } = useViewportFlyout(menuOpen);
  const prSwitchCacheKey = worktreeId ?? id;
  const cachedPrSwitch = prSwitchCacheKey === undefined ? undefined : pullRequestSwitchCache.get(prSwitchCacheKey);
  const [prSwitch, setPrSwitch] = useState<PullRequestSwitchAvailability | undefined>(cachedPrSwitch); const [prSwitchLoaded, setPrSwitchLoaded] = useState(cachedPrSwitch !== undefined); const [prSwitchError, setPrSwitchError] = useState<string>(); const [loadingPrSwitch, setLoadingPrSwitch] = useState(false); const [switchingPr, setSwitchingPr] = useState<number>(); const [movingPr, setMovingPr] = useState<number>();
  const [githubActionsUrl, setGithubActionsUrl] = useState<string>(); const [loadingGithubActions, setLoadingGithubActions] = useState(false);
  const [newTask, setNewTask] = useState<NewTaskAvailability>(); const [loadingNewTask, setLoadingNewTask] = useState(false);
  const newTaskKey = newTaskOperationKey(worktreeId ?? id ?? 'unavailable');
  const startingNewTask = usePendingOperation(newTaskKey);
  const promptPendingKey = `prompt:${id ?? 'unavailable'}`;
  const promptPending = usePendingOperation(promptPendingKey);
  // refresh menu availability
  useEffect(() => {
    if (!menuOpen || id === undefined) return;
    let cancelled = false;
    setLoadingPrSwitch(true);
    setLoadingGithubActions(true);
    void request(`/api/agents/${encodeURIComponent(id)}/github-actions`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled) return;
      if (payload === null || typeof payload !== 'object' || typeof (payload as { url?: unknown }).url !== 'string') return setGithubActionsUrl(undefined);
      try {
        const url = new URL((payload as { url: string }).url);
        if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.endsWith('/actions')) setGithubActionsUrl(url.href);
        else setGithubActionsUrl(undefined);
      } catch { setGithubActionsUrl(undefined); }
    }).catch(() => { if (!cancelled) setGithubActionsUrl(undefined); }).finally(() => { if (!cancelled) setLoadingGithubActions(false); });
    void request(`/api/agents/${encodeURIComponent(id)}/switch-prs`).then(async response => ({ ok: response.ok, status: response.status, payload: await response.json().catch(() => undefined) })).then(({ ok, status, payload }) => {
      // ignore closed menu work
      if (cancelled) return;
      // expose the server failure
      if (!ok) {
        const error = payload !== null && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string' ? (payload as { error: string }).error : `Unable to load pull requests (${status}).`;
        setPrSwitchError(error);
        setPrSwitchLoaded(true);
        setLoadingPrSwitch(false);
        return;
      }
      const availability = payload as { enabled?: unknown; pullRequests?: unknown; otherPullRequests?: unknown };
      // validate successful availability
      if (payload !== null && typeof payload === 'object' && typeof availability.enabled === 'boolean' && Array.isArray(availability.pullRequests) && Array.isArray(availability.otherPullRequests)) {
        const next = {
          enabled: availability.enabled,
          pullRequests: switchablePullRequests(availability.pullRequests),
          otherPullRequests: switchablePullRequests(availability.otherPullRequests)
        };
        // cache one workspace list
        if (prSwitchCacheKey !== undefined) pullRequestSwitchCache.set(prSwitchCacheKey, next);
        setPrSwitch(next);
        setPrSwitchError(undefined);
      } else {
        setPrSwitchError('The console returned invalid pull request data.');
      }
      setPrSwitchLoaded(true);
      setLoadingPrSwitch(false);
    }).catch(() => {
      // retain one actionable client error
      if (!cancelled) { setPrSwitchError('Unable to load pull requests.'); setPrSwitchLoaded(true); setLoadingPrSwitch(false); }
    });
    setLoadingNewTask(newTaskConfigured);
    if (!newTaskConfigured) setNewTask(undefined);
    if (newTaskConfigured) void request(`/api/agents/${encodeURIComponent(id)}/new-task`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled || payload === null || typeof payload !== 'object' || typeof (payload as { enabled?: unknown }).enabled !== 'boolean') throw new Error('invalid new task availability');
      const availability = payload as { enabled: boolean; reason?: unknown };
      setNewTask({ enabled: availability.enabled, reason: typeof availability.reason === 'string' ? availability.reason : undefined });
    }).catch(() => { if (!cancelled) setNewTask({ enabled: false, reason: 'Unable to check whether a new task can start.' }); }).finally(() => { if (!cancelled) setLoadingNewTask(false); });
    return () => { cancelled = true; };
  }, [menuOpen, id, newTaskConfigured, prSwitchCacheKey]);
  const swapToTerminal = () => { setMenuOpen(false); onSwap?.(); };
  const attachFiles = () => { setMenuOpen(false); window.requestAnimationFrame(() => onAttach?.()); };
  const queuePush = async () => {
    if (id === undefined || promptPending || !beginPendingOperation(promptPendingKey)) return;
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: pushAction.prompt, attachments: [] }) });
      if (response.ok) { setMenuOpen(false); await onPromptQueued?.(); }
    } finally { setPendingOperation(promptPendingKey, false); }
  };
  const switchPullRequest = async (number: number) => { if (id === undefined || switchingPr !== undefined) return; setSwitchingPr(number); try { const response = await request(`/api/agents/${encodeURIComponent(id)}/switch-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number }) }); if (response.ok) setMenuOpen(false); } finally { setSwitchingPr(undefined); } };
  // move one occupied pull request into this worktree
  const movePullRequest = async (number: number) => {
    // prevent duplicate move transactions
    if (id === undefined || switchingPr !== undefined || movingPr !== undefined) return;
    setMovingPr(number);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/move-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number }) });
      // surface a rejected server transaction
      if (!response.ok) return onOperationFeedback({ tone: 'error', message: 'Pull request could not be moved', detail: await launchError(response), worktreeId });
      // discard stale checkout ownership after success
      if (prSwitchCacheKey !== undefined) pullRequestSwitchCache.delete(prSwitchCacheKey);
      setMenuOpen(false);
      onOperationFeedback({ tone: 'success', message: 'Pull request moved here', detail: 'The source worktree was detached and its uncommitted changes were restored here.', worktreeId });
    } catch {
      onOperationFeedback({ tone: 'error', message: 'Pull request could not be moved', detail: 'The console could not be reached. Check both worktrees before trying again.', worktreeId });
    } finally {
      setMovingPr(undefined);
    }
  };
  const clearNewTask = () => {
    if (worktreeId !== undefined && pendingNewTaskSources.get(worktreeId) === id) pendingNewTaskSources.delete(worktreeId);
    setPendingOperation(newTaskKey, false);
  };
  const startNewTask = async () => {
    if (id === undefined || startingNewTask || !newTask?.enabled || !beginPendingOperation(newTaskKey)) return;
    if (worktreeId !== undefined) pendingNewTaskSources.set(worktreeId, id);
    setMenuOpen(false);
    onOperationFeedback({ tone: 'pending', message: 'Starting a new task…', detail: 'Closing the current session and preparing a fresh agent. You can keep using other tabs.', worktreeId });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/new-task`, { method: 'POST' });
      if (!response.ok) {
        clearNewTask();
        setNewTask({ enabled: false, reason: 'Unable to start a new task.' });
        onOperationFeedback({ tone: 'error', message: 'New task did not start', detail: await launchError(response), worktreeId });
        return;
      }
      window.setTimeout(() => {
        // require one worktree handoff
        if (worktreeId === undefined) return clearNewTask();
        // ignore completed replacements
        if (pendingNewTaskSources.get(worktreeId) !== id) return;
        // retain the recovery tab
        setPendingOperation(newTaskKey, false);
        onOperationFeedback({ tone: 'error', message: 'New task is taking longer than expected', detail: 'No fresh agent appeared within 30 seconds. Check the worktree status before trying again.', worktreeId });
      }, 30_000);
    } catch {
      clearNewTask();
      setNewTask({ enabled: false, reason: 'Unable to start a new task.' });
      onOperationFeedback({ tone: 'error', message: 'New task did not start', detail: 'The console could not be reached. The current agent is unchanged.', worktreeId });
    }
  };
  const toggleMenu = () => {
    if (!menuOpen && id !== undefined) { setLoadingPrSwitch(true); setLoadingGithubActions(true); setLoadingNewTask(newTaskConfigured); }
    setMenuOpen(open => !open);
  };
  const selectWorktree = (target: DashboardTarget) => { setMenuOpen(false); onSelectTarget(target); };
  if (id === undefined) return null;
  const otherPullRequestCount = prSwitch?.otherPullRequests.length ?? 0;
  const pullRequestReason = pullRequestStatusReason(loadingPrSwitch, prSwitchError, prSwitchLoaded, prSwitch);
  const newTaskReason = !newTaskConfigured ? 'Not configured for this worktree.' : newTask === undefined ? 'Checking availability…' : newTask.enabled ? 'Start a fresh task for this worktree.' : newTask.reason ?? 'New Task is currently unavailable.';
  return <><span className="more-wrap" ref={anchorRef}><button className="more icon-button" aria-label="More options" aria-expanded={menuOpen} onClick={toggleMenu}>⋮</button></span>{menuOpen && <FlyoutPortal onDismiss={() => setMenuOpen(false)}><div className="more-menu flyout-menu pr-switch-menu" ref={flyoutRef} style={style} aria-busy={loadingPrSwitch || loadingGithubActions || loadingNewTask}><div className="pr-switch-summary"><button className="pr-switch-heading" type="button" aria-label="Pull requests" disabled>{loadingPrSwitch ? <span className="spinner" /> : <MoreMenuIcon name="pull-request" />}Pull requests</button>{pullRequestReason !== undefined && <span className={`more-menu-reason${prSwitchError === undefined ? '' : ' pr-switch-error'}`} role={prSwitchError === undefined ? 'status' : 'alert'} aria-label={pullRequestReason}>{pullRequestReason}</span>}</div>{prSwitch?.pullRequests.map(pullRequest => <SwitchPullRequestOption key={pullRequest.number} pullRequest={pullRequest} enabled={prSwitch.enabled} loading={loadingPrSwitch} refreshFailed={prSwitchError !== undefined} switchingPr={switchingPr} movingPr={movingPr} onSwitch={switchPullRequest} onMove={movePullRequest} onSelectTarget={selectWorktree} />)}{prSwitch !== undefined && otherPullRequestCount > 0 && <details className="other-pull-requests"><summary>Pull requests by others <span>{otherPullRequestCount}</span></summary><div>{prSwitch.otherPullRequests.map(pullRequest => <SwitchPullRequestOption key={pullRequest.number} pullRequest={pullRequest} enabled={prSwitch.enabled} loading={loadingPrSwitch} refreshFailed={prSwitchError !== undefined} switchingPr={switchingPr} movingPr={movingPr} onSwitch={switchPullRequest} onMove={movePullRequest} onSelectTarget={selectWorktree} />)}</div></details>}<hr className="more-menu-divider" /><button disabled={onSwap === undefined || swapDisabled} onClick={swapToTerminal}><MoreMenuIcon name="swap" />Swap to terminal</button><button disabled={promptPending} onClick={() => void queuePush()}>{promptPending ? <span className="spinner" /> : <MoreMenuIcon name="push" />}{pushAction.label}</button><button disabled={onAttach === undefined || attachDisabled} onClick={attachFiles}><MoreMenuIcon name="attachment" />Attach files</button>{loadingGithubActions ? <button className="github-actions-loading" type="button" disabled><span className="spinner" />GitHub Actions</button> : githubActionsUrl === undefined ? <button type="button" disabled title="GitHub Actions unavailable"><MoreMenuIcon name="actions" />GitHub Actions</button> : <a className="more-menu-link" href={githubActionsUrl} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}><MoreMenuIcon name="actions" />GitHub Actions</a>}<div className="new-task-option"><button disabled={!newTaskConfigured || loadingNewTask || !newTask?.enabled || startingNewTask} onClick={() => void startNewTask()}>{loadingNewTask || startingNewTask ? <><span className="spinner" />{startingNewTask ? 'Starting New Task' : 'New Task'}</> : <><MoreMenuIcon name="new-task" />New Task</>}</button><span className="more-menu-reason" role="status">{newTaskReason}</span></div></div></FlyoutPortal>}</>;
}

// render an active agent
function AgentCard({ agent, active, tabBar, cleanupControl, reviewCapability, review, onReview, onDeleted, onSelectTarget, onPromptFocus, onOperationFeedback }: { agent: Agent; active: boolean; tabBar: ReactNode; cleanupControl?: ReactNode; reviewCapability?: ReviewTourCapability; review?: ReviewButtonState; onReview: (launch: ReviewLaunch) => void; onDeleted: () => Promise<void>; onSelectTarget: (target: DashboardTarget) => void; onPromptFocus: () => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const [paneMode, setPaneMode] = useState<'agent'|'terminal'>('agent');
  const terminalTransition = useRef<'agent'|'backgrounding'|'terminal'|'returning'>('agent');
  const mounted = useRef(true);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [sleeping, setSleeping] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [question, setQuestion] = useState<ChoiceQuestion>();
  const promptHistory = usePromptHistory(agent.id);
  const projectBrowser = useProjectBrowser(agent.projectUrl, agent.worktreeId);
  const startingNewTask = usePendingOperation(newTaskOperationKey(agent.worktreeId ?? agent.id));
  // cancel active agent work
  const cancel = async () => { if (cancelling) return; setCancelling(true); try { await request(`/api/agents/${encodeURIComponent(agent.id)}/cancel`, { method: 'POST' }); } finally { setCancelling(false); } };
  // close one scratch agent
  const remove = async () => {
    // prevent duplicate closure
    if (deleting) return;
    setDeleting(true);
    onOperationFeedback({ tone: 'pending', message: 'Closing scratch agent…', detail: 'The session is being stopped and removed from the console.' });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' });
      // surface failed closure
      if (!response.ok) return onOperationFeedback({ tone: 'error', message: 'Scratch agent could not be closed', detail: await launchError(response) });
      await onDeleted();
      onOperationFeedback({ tone: 'success', message: 'Scratch agent closed', detail: 'The session was removed successfully.' });
    } catch { onOperationFeedback({ tone: 'error', message: 'Scratch agent could not be closed', detail: 'The console could not be reached. The agent may still be running.' }); }
    finally { setDeleting(false); }
  };
  // deactivate one configured agent
  const deactivate = async () => {
    // require an idle configured target
    if (deactivating || agent.worktreeId === undefined || !beginPendingOperation(deactivateOperationKey(agent.worktreeId))) return;
    setDeactivating(true);
    const label = agent.worktreeLabel ?? agentLabel(agent);
    onOperationFeedback({ tone: 'pending', message: `Turning off ${label}…`, detail: 'Stopping the agent while keeping the worktree available to start again.', worktreeId: agent.worktreeId });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/deactivate`, { method: 'POST' });
      // surface failed deactivation
      if (!response.ok) return onOperationFeedback({ tone: 'error', message: `${label} could not be turned off`, detail: await launchError(response), worktreeId: agent.worktreeId });
      await onDeleted();
      onOperationFeedback({ tone: 'success', message: `${label} is off`, detail: 'The worktree is still available. Use Launch agent whenever you want to turn it back on.', worktreeId: agent.worktreeId });
    } catch { onOperationFeedback({ tone: 'error', message: `${label} could not be turned off`, detail: 'The console could not be reached. The agent may still be running.', worktreeId: agent.worktreeId }); }
    finally {
      setPendingOperation(deactivateOperationKey(agent.worktreeId), false);
      setDeactivating(false);
    }
  };
  // restart one configured agent
  const restart = async () => {
    // require an idle configured target
    if (restarting || agent.worktreeId === undefined || !beginPendingOperation(restartOperationKey(agent.worktreeId))) return;
    const operationKey = restartOperationKey(agent.worktreeId);
    pendingWorktreeLaunches.set(agent.worktreeId, { operationKey, sourceAgentId: agent.id });
    setRestarting(true);
    const label = agent.worktreeLabel ?? agentLabel(agent);
    onOperationFeedback({ tone: 'pending', message: `Restarting ${label}…`, detail: 'Closing the agent, running the resume alias, and waiting for the conversation to reconnect.', worktreeId: agent.worktreeId });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/restart`, { method: 'POST' });
      // surface failed restarts after refreshing the closed agent
      if (!response.ok) {
        const message = await launchError(response);
        await onDeleted();
        return onOperationFeedback({ tone: 'error', message: `${label} could not restart`, detail: message, worktreeId: agent.worktreeId });
      }
      const payload = await response.json() as { agentId?: unknown };
      // require the discovered replacement agent
      if (typeof payload.agentId !== 'string') {
        await onDeleted();
        return onOperationFeedback({ tone: 'error', message: `${label} could not restart`, detail: 'The resume alias ran, but the replacement agent could not be opened.', worktreeId: agent.worktreeId });
      }
      pendingWorktreeLaunches.set(agent.worktreeId, { operationKey, sourceAgentId: agent.id, agentId: payload.agentId });
      await onDeleted();
      onOperationFeedback({ tone: 'success', message: `${label} restarted`, detail: 'The previous Codex conversation resumed and its output is reconnecting.', worktreeId: agent.worktreeId });
    } catch {
      await onDeleted().catch(() => undefined);
      onOperationFeedback({ tone: 'error', message: `${label} could not restart`, detail: 'The console could not confirm the restart. Check the retained worktree state before trying again.', worktreeId: agent.worktreeId });
    }
    finally {
      pendingWorktreeLaunches.delete(agent.worktreeId);
      setPendingOperation(operationKey, false);
      // avoid updating an unmounted agent card
      if (mounted.current) setRestarting(false);
    }
  };
  // clear one configured agent conversation
  const clear = async () => {
    const operationKey = clearOperationKey(agent.id);
    // serialize clear requests
    if (clearing || !beginPendingOperation(operationKey)) return;
    setClearing(true);
    const label = agent.worktreeLabel ?? agentLabel(agent);
    onOperationFeedback({ tone: 'pending', message: `Clearing ${label}…`, detail: 'Sending /clear to reset the current Codex conversation.', worktreeId: agent.worktreeId });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '/clear', attachments: [] }) });
      // surface failed clears
      if (!response.ok) return onOperationFeedback({ tone: 'error', message: `${label} could not clear`, detail: await launchError(response), worktreeId: agent.worktreeId });
      await promptHistory.refresh();
      onOperationFeedback({ tone: 'success', message: `${label} cleared`, detail: 'The /clear command was sent and the conversation is resetting.', worktreeId: agent.worktreeId });
    } catch {
      onOperationFeedback({ tone: 'error', message: `${label} could not clear`, detail: 'The console could not be reached. The conversation was not cleared.', worktreeId: agent.worktreeId });
    }
    finally {
      setPendingOperation(operationKey, false);
      // avoid updating an unmounted agent card
      if (mounted.current) setClearing(false);
    }
  };
  // sleep one configured agent
  const sleep = async () => {
    // require an idle configured target
    if (sleeping || agent.worktreeId === undefined || !beginPendingOperation(sleepOperationKey(agent.worktreeId))) return;
    setSleeping(true);
    const label = agent.worktreeLabel ?? agentLabel(agent);
    onOperationFeedback({ tone: 'pending', message: `Putting ${label} to sleep…`, detail: 'Stopping the agent while keeping this tab ready to wake.', worktreeId: agent.worktreeId });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/sleep`, { method: 'POST' });
      // surface failed sleep
      if (!response.ok) return onOperationFeedback({ tone: 'error', message: `${label} could not sleep`, detail: await launchError(response), worktreeId: agent.worktreeId });
      await onDeleted();
      onOperationFeedback({ tone: 'success', message: `${label} is sleeping`, detail: 'Use Wake up to resume the previous Codex conversation.', worktreeId: agent.worktreeId });
    } catch { onOperationFeedback({ tone: 'error', message: `${label} could not sleep`, detail: 'The console could not be reached. The agent may still be running.', worktreeId: agent.worktreeId }); }
    finally {
      setPendingOperation(sleepOperationKey(agent.worktreeId), false);
      setSleeping(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    // restore terminal state on unmount
    return () => {
      mounted.current = false;
      // ignore normal agent output
      if (terminalTransition.current !== 'terminal') return;
      terminalTransition.current = 'returning';
      void request(`/api/agents/${encodeURIComponent(agent.id)}/foreground`, { method: 'POST' }).catch(() => undefined).finally(() => { terminalTransition.current = 'agent'; });
    };
  }, [agent.id]);
  // toggle the interactive terminal
  const changePaneMode = async () => {
    // serialize terminal transitions
    if (swapping) return;
    setSwapping(true);
    try {
      // return an active terminal
      if (paneMode === 'terminal') {
        terminalTransition.current = 'returning';
        const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/foreground`, { method: 'POST' });
        // publish successful restoration
        if (response.ok) {
          terminalTransition.current = 'agent';
          if (mounted.current) setPaneMode('agent');
        } else terminalTransition.current = 'terminal';
        return;
      }
      terminalTransition.current = 'backgrounding';
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/background`, { method: 'POST' });
      // restore failed transitions
      if (!response.ok) { terminalTransition.current = 'agent'; return; }
      // immediately foreground after unmount races
      if (!mounted.current) {
        terminalTransition.current = 'returning';
        await request(`/api/agents/${encodeURIComponent(agent.id)}/foreground`, { method: 'POST' });
        terminalTransition.current = 'agent';
        return;
      }
      terminalTransition.current = 'terminal';
      setPaneMode('terminal');
    } catch { terminalTransition.current = paneMode; }
    finally { if (mounted.current) setSwapping(false); }
  };
  const swapped = paneMode === 'terminal';
  // explain review availability
  const reviewUnavailable = agent.worktreeId === undefined
    ? 'Guided review requires a configured worktree'
    : reviewCapability?.available === true
      ? undefined
      : reviewCapability?.reason === 'authentication_required'
        ? 'Authenticate Codex to use guided review'
        : 'Guided review unavailable on this server';
  // the inline question the dashboard reported for this agent (OMX files); the
  // Log socket supplies the parsed one, and the dashboard's takes precedence
  const dashboardQuestion = agent.question === undefined ? undefined : choiceQuestionFromInline(agent.question);
  const rebaseUpstream = agent.gitUpstream?.upstream;
  const queueRebase = rebaseUpstream === undefined ? undefined : async () => {
    const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: `$rebase ${rebaseUpstream}`, attachments: [] }) });
    if (response.ok) await promptHistory.refresh();
    return response.ok;
  };
  // reserve Remote Agents repository updates for the reviewed host update flow
  const upstreamRebase = agent.worktreeId === 'remoteagents' ? null : <UpstreamRebaseBanner summary={agent.gitUpstream} onRebase={queueRebase} />;
  return <article className="agent-view"><Log id={agent.id} worktreeId={agent.worktreeId} branch={agent.branch} gitStatus={agent.gitStatus} gitPrStatus={agent.gitPrStatus} history={promptHistory.history} refreshHistory={promptHistory.refresh} onQuestion={setQuestion} cleanupControl={cleanupControl} browserUrl={projectBrowser.url} browserHomeUrl={projectBrowser.homeUrl} browserNavigationRequest={projectBrowser.navigationRequest} onBrowserNavigate={projectBrowser.navigate} onBrowserOpen={projectBrowser.openUrl} onBrowserClose={projectBrowser.close} terminalMode={swapped} onReview={agent.worktreeId === undefined ? undefined : review === undefined ? scope => onReview({ agentId: agent.id, worktreeId: agent.worktreeId!, scope }) : () => review.onOpen()} reviewOpen={review !== undefined} reviewUnavailable={review === undefined ? reviewUnavailable : undefined} processingLabel={startingNewTask ? 'Starting new task…' : undefined} processingDetail={startingNewTask ? 'Closing this session and preparing a fresh agent. This can take a few seconds.' : undefined} />{tabBar}{upstreamRebase}<PullRequestCard pullRequest={agent.pullRequest} onFixup={agent.pullRequest === undefined ? undefined : async () => { const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '$fixup', attachments: [] }) }); if (response.ok) await promptHistory.refresh(); return response.ok; }} /><Prompt id={agent.id} history={promptHistory.history} onHistoryChanged={promptHistory.refresh} canCancel={active} cancelling={cancelling} deleting={deleting} restarting={restarting} clearing={clearing} deactivating={deactivating} sleeping={sleeping} swapping={swapping} swapped={swapped} onCancel={() => void cancel()} onDelete={!active && agent.worktreeId === undefined ? () => void remove() : undefined} onRestart={!active && agent.worktreeId !== undefined ? () => void restart() : undefined} onClear={!active && agent.worktreeId !== undefined ? () => void clear() : undefined} onDeactivate={!active && agent.worktreeId !== undefined ? () => void deactivate() : undefined} onSleep={!active && agent.worktreeId !== undefined ? () => void sleep() : undefined} onSwap={() => void changePaneMode()} onSelectTarget={onSelectTarget} onPromptFocus={onPromptFocus} onOperationFeedback={onOperationFeedback} projectUrl={agent.projectUrl} browserOpen={projectBrowser.open} onBrowserToggle={projectBrowser.toggle} question={dashboardQuestion ?? question} worktreeId={agent.worktreeId} newTaskConfigured={agent.newTaskConfigured} pushAction={agent.push} stack={agent.stack} review={review} /></article>;
}

function launchError(response: Response): Promise<string> {
  return response.json().then((body: { error?: unknown }) => typeof body.error === 'string' ? body.error : `Launch failed (${response.status}).`).catch(() => `Launch failed (${response.status}).`);
}

type InactiveWorktreePresentation = { ariaLabel?: string; heading: string; detail: string; status: string; buttonLabel: string };
// describe one inactive worktree state
const inactiveWorktreePresentation = (label: string, state: { startingNewTask: boolean; restarting: boolean; turningOff: boolean; waking: boolean; launching: boolean; sleeping: boolean }): InactiveWorktreePresentation => {
  // describe a fresh conversation
  if (state.startingNewTask) return { ariaLabel: 'Starting new task', heading: 'Starting new task…', detail: 'Waiting for the fresh agent session to become ready.', status: 'Starting', buttonLabel: 'Starting new task' };
  // describe a restarted conversation
  if (state.restarting) return { ariaLabel: `Restarting ${label}`, heading: 'Restarting agent…', detail: 'Running the resume alias and reconnecting the previous conversation.', status: 'Restarting', buttonLabel: 'Restarting' };
  // describe sleeping-tab shutdown
  if (state.turningOff) return { ariaLabel: `Turning off ${label}`, heading: 'Turning off…', detail: 'Removing the retained sleeping tab.', status: 'Turning off', buttonLabel: 'Turning off' };
  // describe a waking conversation
  if (state.waking) return { ariaLabel: `Waking ${label}`, heading: 'Waking up…', detail: 'Running the resume alias and reconnecting the previous conversation.', status: 'Waking', buttonLabel: 'Wake up' };
  // describe a fresh launch
  if (state.launching) return { ariaLabel: `Starting ${label}`, heading: 'Starting Codex…', detail: 'Creating the agent session and connecting its output.', status: 'Starting', buttonLabel: 'Launching' };
  // describe retained sleep
  if (state.sleeping) return { ariaLabel: `${label} sleeping`, heading: 'Agent is sleeping', detail: 'The agent process is closed, but this tab is waiting for you.', status: 'Sleep', buttonLabel: 'Wake up' };
  return { heading: 'Agent is off', detail: 'This worktree is available. Launch an agent when you are ready to continue.', status: 'Off', buttonLabel: 'Launch agent' };
};

// render an inactive worktree
function WorktreeCard({ worktree, tabBar, cleanupControl, onLaunched, onTurnedOff, onOperationFeedback }: { worktree: Worktree; tabBar: ReactNode; cleanupControl?: ReactNode; onLaunched: (agentId: string, worktree: Worktree, operationKey: string) => void; onTurnedOff: () => Promise<void>; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const launchKey = launchOperationKey(worktree.id);
  const restartKey = restartOperationKey(worktree.id);
  const deactivateKey = deactivateOperationKey(worktree.id);
  const wakeKey = wakeOperationKey(worktree.id);
  const launching = usePendingOperation(launchKey);
  const restarting = usePendingOperation(restartKey);
  const turningOff = usePendingOperation(deactivateKey);
  const waking = usePendingOperation(wakeKey);
  const startingNewTask = usePendingOperation(newTaskOperationKey(worktree.id));
  const sleeping = worktree.sleeping === true;
  const processing = launching || restarting || turningOff || waking || startingNewTask;
  const presentation = inactiveWorktreePresentation(worktree.label, { startingNewTask, restarting, turningOff, waking, launching, sleeping });
  const worktreeBookmarks = useWorktreeBookmarks(worktree.id);
  const worktreeNotes = useWorktreeNotes(worktree.id);
  const projectBrowser = useProjectBrowser(worktree.projectUrl, worktree.id);
  const filePreview = useFilePreview(`/api/worktrees/${encodeURIComponent(worktree.id)}/file-preview`);
  const [gitExpanded, setGitExpanded] = useState(false);
  const [error, setError] = useState('');
  // preview one inactive worktree file
  const openGitFile = (path: string) => {
    setGitExpanded(false);
    void filePreview.openFile(path);
  };
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 5_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  // start or resume one inactive worktree
  const start = async () => {
    const operationKey = worktreeLaunchOperationKey(worktree);
    const action = sleeping ? 'wake' : 'launch';
    // serialize inactive worktree actions
    if (!worktree.available || processing || !beginPendingOperation(operationKey)) return;
    pendingWorktreeLaunches.set(worktree.id, { operationKey });
    let handedOff = false;
    setError('');
    onOperationFeedback({ tone: 'pending', message: `${sleeping ? 'Waking' : 'Starting'} ${worktree.label}…`, detail: sleeping ? 'Running the resume alias and waiting for the previous conversation.' : 'Launching Codex and waiting for the agent session to become ready.', worktreeId: worktree.id });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/${action}`, { method: 'POST' });
      // surface failed starts
      if (!response.ok) {
        const message = await launchError(response);
        setError(message);
        return onOperationFeedback({ tone: 'error', message: `${worktree.label} could not ${sleeping ? 'wake up' : 'start'}`, detail: message, worktreeId: worktree.id });
      }
      const payload = await response.json() as { agentId?: unknown };
      // require the discovered replacement agent
      if (typeof payload.agentId !== 'string') {
        const message = `The agent ${sleeping ? 'woke up' : 'started'} but could not be opened.`;
        setError(message);
        return onOperationFeedback({ tone: 'error', message: `${worktree.label} could not be opened`, detail: message, worktreeId: worktree.id });
      }
      onLaunched(payload.agentId, worktree, operationKey);
      handedOff = true;
      onOperationFeedback({ tone: 'success', message: `${worktree.label} ${sleeping ? 'is awake' : 'is starting'}`, detail: sleeping ? 'The previous Codex conversation resumed and its output is connecting.' : 'The new agent session is ready and its output is connecting.', worktreeId: worktree.id });
    } catch {
      const message = `Unable to reach the console while ${sleeping ? 'waking' : 'launching'} the agent.`;
      setError(message);
      onOperationFeedback({ tone: 'error', message: `${worktree.label} could not ${sleeping ? 'wake up' : 'start'}`, detail: message, worktreeId: worktree.id });
    }
    finally {
      // preserve successful handoffs until dashboard confirmation
      if (!handedOff) {
        pendingWorktreeLaunches.delete(worktree.id);
        setPendingOperation(operationKey, false);
      }
    }
  };
  // forget one retained sleeping tab
  const turnOff = async () => {
    // serialize sleeping worktree actions
    if (!sleeping || processing || !beginPendingOperation(deactivateKey)) return;
    setError('');
    onOperationFeedback({ tone: 'pending', message: `Turning off ${worktree.label}…`, detail: 'Removing the retained sleeping tab while leaving the worktree available.', worktreeId: worktree.id });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/deactivate`, { method: 'POST' });
      // surface failed shutdowns
      if (!response.ok) {
        const message = await launchError(response);
        setError(message);
        return onOperationFeedback({ tone: 'error', message: `${worktree.label} could not be turned off`, detail: message, worktreeId: worktree.id });
      }
      await onTurnedOff();
      onOperationFeedback({ tone: 'success', message: `${worktree.label} is off`, detail: 'The worktree remains available from the launcher.' });
    } catch {
      const message = 'Unable to reach the console while turning off the sleeping agent.';
      setError(message);
      onOperationFeedback({ tone: 'error', message: `${worktree.label} could not be turned off`, detail: message, worktreeId: worktree.id });
    } finally {
      setPendingOperation(deactivateKey, false);
    }
  };
  // retain the normal left-side power placement
  const sleepingPowerMenu = sleeping ? <AgentPowerMenu mode="sleeping" pending={!worktree.available || processing} onWake={() => void start()} onTurnOff={() => void turnOff()} /> : null;
  const output = <div className="log-output"><ServerSwitcher className="output-server-switcher" /><div className={`log-loading inactive${sleeping ? ' sleeping' : ''}`} role={processing || sleeping ? 'status' : undefined} aria-label={presentation.ariaLabel}>{processing ? <span className="spinner" /> : sleeping ? <svg className="sleeping-agent-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 15.5A8 8 0 0 1 8.5 5 8 8 0 1 0 19 15.5Z" /></svg> : null}<strong>{presentation.heading}</strong><span>{presentation.detail}</span>{sleeping && !processing && <button className="wake-agent" type="button" disabled={!worktree.available} onClick={() => void start()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z" /></svg>Wake up</button>}</div><span className={`status log-status ${processing ? 'connecting' : sleeping ? 'sleeping' : 'inactive'}`}>{presentation.status}</span><div className="log-footer"><div className="log-controls-bottom"><div className="page-controls">{cleanupControl}{worktreeBookmarks.control}{worktreeNotes.control}<button className="log-control page-arrow" aria-label="Page up" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button className="log-control page-arrow" aria-label="Page down" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div></div></div></div>;
  const browserPane = projectBrowser.url === undefined || projectBrowser.homeUrl === undefined ? null : <ProjectBrowserPane url={projectBrowser.url} homeUrl={projectBrowser.homeUrl} worktreeId={worktree.id} onNavigate={projectBrowser.navigate} onClose={projectBrowser.close} />;
  return <article className="agent-view"><section className="log-shell"><div className="log inactive-log"><ResizableLogSplit worktreeId={worktree.id} output={output} note={worktreeNotes.pane} browser={browserPane} /></div>{filePreview.dialog}<div className={`log-topbar${gitExpanded ? ' expanded' : ''}`}><GitStatus branch={worktree.branch} summary={worktree.gitStatus} prSummary={worktree.gitPrStatus} expanded={gitExpanded} onToggle={() => setGitExpanded(value => !value)} onOpenFile={openGitFile} reviewUnavailable="Launch agent to review" /></div></section>{tabBar}<UpstreamRebaseBanner summary={worktree.gitUpstream} /><PullRequestCard pullRequest={worktree.pullRequest} /><section className="prompt"><textarea aria-label="Prompt" disabled />{error && <p className="launch-error" role="alert">{error}</p>}<div className="prompt-actions">{sleepingPowerMenu}<span className="prompt-actions-spacer" aria-hidden="true" /><ProjectOpen url={worktree.projectUrl} stack={worktree.stack} browserOpen={projectBrowser.open} onBrowserToggle={projectBrowser.toggle} onStackAction={action => request(`/api/worktrees/${encodeURIComponent(worktree.id)}/commands/${action}`, { method: 'POST' })} onStackLog={() => stackLog(worktree.id)} />{!sleeping && <button className="queue" disabled={!worktree.available || processing} onClick={() => void start()}>{processing && <span className="spinner" />}{presentation.buttonLabel}</button>}</div></section></article>;
}

// render browser notification enrollment
function NotificationControl() {
  const supported = 'Notification' in window;
  const [permission, setPermission] = useState<NotificationPermission | undefined>(() => supported ? Notification.permission : undefined);
  const [publicKey, setPublicKey] = useState<string>();
  useEffect(() => { void request('/api/push/public-key').then(response => response.ok ? response.json() : undefined).then((value: { publicKey?: unknown } | undefined) => typeof value?.publicKey === 'string' && setPublicKey(value.publicKey)); }, []);
  const syncSubscription = async () => {
    if (!publicKey || !('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await request('/api/push/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) });
  };
  useEffect(() => { if (permission === 'granted') void syncSubscription(); }, [permission, publicKey]);
  const enable = async () => {
    if (!supported || permission !== 'default' || !publicKey || !('serviceWorker' in navigator)) return;
    const next = await Notification.requestPermission();
    setPermission(next);
    if (next === 'granted') { await syncSubscription(); await showNotification('system', 'Alerts enabled', 'You will be notified when agents and guided reviews are ready.', 'rac-alerts-enabled'); }
  };
  if (!supported || !publicKey || permission === 'granted') return null;
  if (permission === 'denied') return <span className="notification-status" title="Enable notifications for this site in your browser settings">Alerts blocked</span>;
  return <button className="notification-control" type="button" onClick={() => void enable()}>Enable alerts</button>;
}

function OperationFeedbackBanner({ feedback, onDismiss }: { feedback: OperationFeedback; onDismiss: () => void }) {
  const role = feedback.tone === 'error' ? 'alert' : 'status';
  return <div className={`operation-feedback ${feedback.tone}`} role={role} aria-live={feedback.tone === 'error' ? 'assertive' : 'polite'}>
    <span className="operation-feedback-icon" aria-hidden="true">{feedback.tone === 'pending' ? <span className="spinner" /> : feedback.tone === 'success' ? '✓' : '!'}</span>
    <span className="operation-feedback-copy"><strong>{feedback.message}</strong><span>{feedback.detail}</span></span>
    {feedback.tone !== 'pending' && <button type="button" aria-label="Dismiss operation status" title="Dismiss" onClick={onDismiss}>×</button>}
  </div>;
}

// render the active console dashboard
function DashboardView({ onUnauthorized, onInactive, updateControl, updateError }: { onUnauthorized: () => void; onInactive: () => void; updateControl?: UpdateControl; updateError?: string }) {
  const serverInfo = useContext(ServerContext) ?? fallbackServerInfo();
  const [data, setData] = useState<Dashboard>();
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceCallRequest, setVoiceCallRequest] = useState(0);
  // close only the voice surface
  const closeVoice = useCallback(() => setVoiceOpen(false), []);
  // open, call, or reveal the shared voice surface
  const openVoice = useCallback(() => {
    // toggle only an ongoing mobile call
    if (voiceActive) {
      if (window.matchMedia('(max-width: 600px)').matches) setVoiceOpen(current => !current);
      else setVoiceOpen(true);
      return;
    }
    setVoiceOpen(true);
    setVoiceCallRequest(current => current + 1);
  }, [voiceActive]);
  // retain one stable voice trigger context
  const voiceTrigger = useMemo(() => ({ open: openVoice, active: voiceActive, visible: voiceOpen }), [openVoice, voiceActive, voiceOpen]);
  const [reviewLaunch, setReviewLaunch] = useState<ReviewLaunch>();
  const [reviewInitialTour, setReviewInitialTour] = useState<ReviewTour>();
  const [reviewMinimized, setReviewMinimized] = useState(false);
  const [reviewIndicator, setReviewIndicator] = useState<ReviewTourIndicator>({ generating: false, stale: false });
  const [reviewRestoringWorktreeId, setReviewRestoringWorktreeId] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  const [active, setActive] = useState(0);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const tabsRef = useRef<HTMLElement | null>(null);
  const { anchorRef: launcherRef, flyoutRef: launcherMenuRef, style: launcherStyle } = useViewportFlyout(launcherOpen);
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const [plusAlone, setPlusAlone] = useState(false);
  const [launchErrorMessage, setLaunchErrorMessage] = useState('');
  const [operationFeedback, setOperationFeedback] = useState<OperationFeedback>();
  const operationFeedbackId = useRef(0);
  const [activateAgentId, setActivateAgentId] = useState<string>();
  const [activateWorktreeId, setActivateWorktreeId] = useState<string>();
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupTargets, setCleanupTargets] = useState<CleanupTarget[]>([]);
  const [cleanupChecked, setCleanupChecked] = useState<Set<string>>(() => new Set());
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupError, setCleanupError] = useState('');
  const cleanupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousCleanupCount = useRef(0);
  const refreshInFlight = useRef(false);
  const dashboardPushFreshUntil = useRef(0);
  const dashboardPushSynchronized = useRef(false);
  const dashboardContent = useRef('');
  const dashboardSnapshot = useRef<Dashboard | undefined>(undefined);
  const latestDashboardServerStartedAt = useRef<number | undefined>(undefined);
  const latestDashboardGeneration = useRef<number | undefined>(undefined);
  const selectedItemKey = useRef<string | undefined>(undefined);
  const dashboardMounted = useRef(true);
  const showOperationFeedback = useCallback((feedback: Omit<OperationFeedback, 'id'>) => {
    operationFeedbackId.current += 1;
    setOperationFeedback({ ...feedback, id: operationFeedbackId.current });
  }, []);
  const viewAgent = useCallback((agent: Pick<Agent, 'id' | 'worktreeId'>) => {
    setData(current => {
      if (current === undefined || !current.agents.some(candidate => candidate.id === agent.id && candidate.unread)) return current;
      return { ...current, agents: current.agents.map(candidate => candidate.id === agent.id ? { ...candidate, unread: false } : candidate) };
    });
    dismissAgentNotifications(agent);
  }, []);
  useEffect(() => {
    if (!launchErrorMessage) return;
    const timer = window.setTimeout(() => setLaunchErrorMessage(''), 5_000);
    return () => window.clearTimeout(timer);
  }, [launchErrorMessage]);
  useEffect(() => {
    if (operationFeedback?.tone !== 'success') return;
    const id = operationFeedback.id;
    const timer = window.setTimeout(() => setOperationFeedback(current => current?.id === id ? undefined : current), 5_000);
    return () => window.clearTimeout(timer);
  }, [operationFeedback]);
  const agentStates = useRef(new Map<string, AgentState>());
  const pendingCompletions = useRef(new Map<string, { due: number; timer: number }>());
  // release launch state when the dashboard leaves
  useEffect(() => () => {
    dashboardMounted.current = false;
    // clear every dashboard-owned launch
    for (const pendingLaunch of pendingWorktreeLaunches.values()) {
      // cancel confirmation recovery
      if (pendingLaunch.confirmationTimer !== undefined) window.clearTimeout(pendingLaunch.confirmationTimer);
      setPendingOperation(pendingLaunch.operationKey, false);
    }
    pendingWorktreeLaunches.clear();
  }, []);
  const applyDashboard = useCallback((payload: Dashboard) => {
    const latestServerStartedAt = latestDashboardServerStartedAt.current;
    // reject snapshots from an older server process
    if (payload.serverStartedAt !== undefined && latestServerStartedAt !== undefined && payload.serverStartedAt < latestServerStartedAt) return;
    // reject legacy snapshots after a scoped server snapshot arrives
    if (payload.serverStartedAt === undefined && latestServerStartedAt !== undefined) return;
    // reset generation ordering across server processes
    if (payload.serverStartedAt !== undefined && payload.serverStartedAt !== latestServerStartedAt) {
      latestDashboardServerStartedAt.current = payload.serverStartedAt;
      latestDashboardGeneration.current = undefined;
    }
    // reject stale HTTP snapshots that finish after newer pushes
    if (payload.generation !== undefined && latestDashboardGeneration.current !== undefined && payload.generation < latestDashboardGeneration.current) return;
    // retain the newest ordered snapshot boundary
    if (payload.generation !== undefined) latestDashboardGeneration.current = payload.generation;
    const retainedWorktrees: Worktree[] = [];
    const pendingWorktreeIds = new Set([...pendingNewTaskSources.keys(), ...pendingWorktreeLaunches.keys()]);
    // preserve every pending handoff workspace
    for (const worktreeId of pendingWorktreeIds) {
      const visible = payload.agents.some(agent => agent.worktreeId === worktreeId) || payload.worktrees.some(worktree => worktree.id === worktreeId);
      // keep server-provided workspace entries
      if (visible) continue;
      const priorWorktree = dashboardSnapshot.current?.worktrees.find(worktree => worktree.id === worktreeId);
      const sourceAgentId = pendingNewTaskSources.get(worktreeId) ?? pendingWorktreeLaunches.get(worktreeId)?.sourceAgentId;
      const sourceAgent = dashboardSnapshot.current?.agents.find(agent => agent.id === sourceAgentId && agent.worktreeId === worktreeId);
      const retained = priorWorktree ?? (sourceAgent === undefined ? undefined : { id: worktreeId, label: sourceAgent.worktreeLabel ?? agentLabel(sourceAgent), path: sourceAgent.workspace, branch: sourceAgent.branch, gitStatus: sourceAgent.gitStatus, gitPrStatus: sourceAgent.gitPrStatus, gitUpstream: sourceAgent.gitUpstream, available: false, pinned: false, order: sourceAgent.worktreeOrder ?? Number.MAX_SAFE_INTEGER, projectUrl: sourceAgent.projectUrl, pullRequest: sourceAgent.pullRequest, stack: sourceAgent.stack });
      // retain the last known workspace shape
      if (retained !== undefined) retainedWorktrees.push({ ...retained, available: false, pinned: false });
    }
    const nextPayload = retainedWorktrees.length === 0 ? payload : { ...payload, worktrees: [...payload.worktrees, ...retainedWorktrees] };
    dashboardSnapshot.current = nextPayload;
    const activeAgentIds = new Set(nextPayload.agents.map(agent => agent.id));
    logSnapshots.retain(activeAgentIds);
    for (const id of lastPrompts.keys()) if (!activeAgentIds.has(id)) lastPrompts.delete(id);
    for (const id of latestQuestions.keys()) if (!activeAgentIds.has(id)) latestQuestions.delete(id);
    // retire optimistic dismissals for removed agents
    for (const id of dismissedQuestionIds.keys()) if (!activeAgentIds.has(id)) dismissedQuestionIds.delete(id);
    for (const id of latestAssistantMessages.keys()) if (!activeAgentIds.has(id)) latestAssistantMessages.delete(id);
    for (const id of overflowingLatestAssistantMessages) if (!activeAgentIds.has(id)) overflowingLatestAssistantMessages.delete(id);
    for (const id of promptDrafts.keys()) if (!activeAgentIds.has(id)) promptDrafts.delete(id);
    const activeWorktreeIds = new Set(nextPayload.worktrees.map(worktree => worktree.id));
    for (const [worktreeId, sourceAgentId] of pendingNewTaskSources) {
      const replacement = nextPayload.agents.find(agent => agent.worktreeId === worktreeId && agent.id !== sourceAgentId);
      const sourceStillActive = nextPayload.agents.some(agent => agent.id === sourceAgentId);
      // wait through both handoff sides
      if (replacement === undefined && (sourceStillActive || activeWorktreeIds.has(worktreeId))) continue;
      pendingNewTaskSources.delete(worktreeId);
      setPendingOperation(newTaskOperationKey(worktreeId), false);
      if (replacement !== undefined) showOperationFeedback({ tone: 'success', message: 'New task is ready', detail: `${replacement.worktreeLabel ?? agentLabel(replacement)} is ready for a fresh prompt.`, worktreeId });
    }
    // finish launches only after their dashboard agent appears
    for (const [worktreeId, pendingLaunch] of pendingWorktreeLaunches) {
      const replacement = pendingLaunch.agentId === undefined
        ? nextPayload.agents.find(agent => agent.worktreeId === worktreeId && agent.id !== pendingLaunch.sourceAgentId)
        : nextPayload.agents.find(agent => agent.id === pendingLaunch.agentId && agent.worktreeId === worktreeId);
      // wait for the matching agent identity
      if (replacement === undefined) continue;
      const shouldActivate = selectedItemKey.current === `worktree-${worktreeId}`;
      // cancel confirmation recovery
      if (pendingLaunch.confirmationTimer !== undefined) window.clearTimeout(pendingLaunch.confirmationTimer);
      pendingWorktreeLaunches.delete(worktreeId);
      setPendingOperation(pendingLaunch.operationKey, false);
      // preserve newer navigation choices
      if (shouldActivate) setActivateAgentId(replacement.id);
    }
    const content = JSON.stringify([nextPayload.agents, nextPayload.worktrees, nextPayload.cleanupPending ?? 0, nextPayload.reviewTour, nextPayload.reviews]);
    if (content !== dashboardContent.current || pendingCompletions.current.size > 0) {
      dashboardContent.current = content;
      setData(nextPayload);
    }
    setUnavailable(false);
  }, [showOperationFeedback]);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const response = await request('/api/dashboard', { signal: AbortSignal.timeout(8_000) });
      if (response.status === 401) return onUnauthorized();
      if (response.status === 423) return onInactive();
      if (!response.ok) throw new Error('dashboard unavailable');
      const payload: unknown = await response.json();
      if (!isDashboard(payload)) throw new Error('invalid dashboard response');
      applyDashboard(payload);
      if (dashboardPushSynchronized.current) dashboardPushFreshUntil.current = Date.now() + 60_000;
    } catch { setUnavailable(true); }
    finally { refreshInFlight.current = false; }
  }, [applyDashboard, onInactive, onUnauthorized]);
  useEffect(() => {
    // wait for an active review binding
    if (reviewLaunch === undefined || data === undefined) return;
    const current = data.agents.find(agent => agent.worktreeId === reviewLaunch.worktreeId);
    // clear replaced or removed agent bindings
    if (current?.id !== reviewLaunch.agentId) { setReviewLaunch(undefined); setReviewInitialTour(undefined); setReviewIndicator({ generating: false, stale: false }); }
  }, [data, reviewLaunch]);
  const closeCleanup = useCallback(() => {
    setCleanupOpen(false);
    setCleanupError('');
    if (location.hash === '#cleanup') history.replaceState(null, '', `${location.pathname}${location.search}`);
    void dismissNotification('runtime-cleanup');
    window.requestAnimationFrame(() => cleanupTriggerRef.current?.focus());
  }, []);
  const openCleanup = useCallback(async () => {
    setCleanupOpen(true);
    setCleanupLoading(true);
    setCleanupError('');
    try {
      const response = await request('/api/cleanup');
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      const targets = payload !== null && typeof payload === 'object' && Array.isArray((payload as { targets?: unknown }).targets)
        ? (payload as { targets: unknown[] }).targets.filter(isCleanupTarget)
        : undefined;
      if (targets === undefined || targets.length !== (payload as { targets: unknown[] }).targets.length) throw new Error();
      setCleanupTargets(targets);
      setCleanupChecked(new Set(targets.map(target => target.id)));
    } catch {
      setCleanupTargets([]);
      setCleanupChecked(new Set());
      setCleanupError('Unable to load cleanup targets.');
    } finally {
      setCleanupLoading(false);
    }
  }, []);
  const resolveCleanup = useCallback(async () => {
    if (cleanupLoading) return;
    setCleanupLoading(true);
    setCleanupError('');
    try {
      const response = await request('/api/cleanup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetIds: [...cleanupChecked] }) });
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      const targets = payload !== null && typeof payload === 'object' && Array.isArray((payload as { targets?: unknown }).targets)
        ? (payload as { targets: unknown[] }).targets.filter(isCleanupTarget)
        : undefined;
      if (targets === undefined || targets.length !== (payload as { targets: unknown[] }).targets.length) throw new Error();
      if (targets.length === 0) closeCleanup();
      else {
        setCleanupTargets(targets);
        setCleanupChecked(new Set(targets.map(target => target.id)));
        setCleanupError('Some selected targets could not be cleaned up.');
      }
      await refresh();
    } catch {
      setCleanupError('Cleanup failed. No unresolved targets were dismissed.');
    } finally {
      setCleanupLoading(false);
    }
  }, [cleanupChecked, cleanupLoading, closeCleanup, refresh]);
  useEffect(() => {
    const count = data?.cleanupPending ?? 0;
    if (count > 0 && previousCleanupCount.current === 0) void showNotification('system', 'Runtime cleanup available', `${count} stale runtime ${count === 1 ? 'target is' : 'targets are'} ready to clean up.`, 'runtime-cleanup', '/#cleanup');
    if (count === 0 && previousCleanupCount.current > 0) void dismissNotification('runtime-cleanup');
    previousCleanupCount.current = count;
  }, [data?.cleanupPending]);
  useEffect(() => {
    const openFromHash = () => {
      if (location.hash === '#cleanup' && (data?.cleanupPending ?? 0) > 0 && !cleanupOpen) void openCleanup();
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, [cleanupOpen, data?.cleanupPending, openCleanup]);
  useEffect(() => {
    if (!cleanupOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (isPromptKeyboardTarget(event.target) || event.key !== 'Escape' || cleanupLoading) return;
      event.preventDefault();
      closeCleanup();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [cleanupLoading, cleanupOpen, closeCleanup]);
  useEffect(() => pollWhileVisible(() => Date.now() < dashboardPushFreshUntil.current ? undefined : refresh(), 5_000, true, 30_000), [refresh]);
  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let retryDelay = 500;
    const reconnect = () => {
      if (closed || retry !== undefined) return;
      retry = window.setTimeout(() => {
        retry = undefined;
        void connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15_000);
    };
    const connect = async () => {
      if (closed) return;
      try {
        const response = await request('/api/dashboard/ticket', { method: 'POST' }, false);
        if (!response.ok) return reconnect();
        const payload = await response.json() as { ticket?: unknown };
        if (closed || typeof payload.ticket !== 'string') return reconnect();
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/dashboard`, ['rac', payload.ticket]);
        socket = ws;
        ws.onmessage = event => {
          if (closed || socket !== ws) return;
          try {
            const frame: unknown = JSON.parse(event.data);
            if (!isDashboardFrame(frame)) throw new Error();
            dashboardPushSynchronized.current = true;
            dashboardPushFreshUntil.current = Date.now() + 60_000;
            retryDelay = 500;
            applyDashboard(frame.dashboard);
          } catch { ws.close(); }
        };
        ws.onclose = () => {
          if (socket !== ws) return;
          socket = undefined;
          dashboardPushSynchronized.current = false;
          dashboardPushFreshUntil.current = 0;
          reconnect();
        };
        ws.onerror = () => ws.close();
      } catch { reconnect(); }
    };
    void connect();
    return () => {
      closed = true;
      dashboardPushSynchronized.current = false;
      dashboardPushFreshUntil.current = 0;
      if (retry !== undefined) window.clearTimeout(retry);
      socket?.close();
    };
  }, [applyDashboard]);
  useEffect(() => () => {
    for (const pending of pendingCompletions.current.values()) window.clearTimeout(pending.timer);
    pendingCompletions.current.clear();
  }, []);
  useEffect(() => {
    if (!data) return;
    const next = new Map<string, AgentState>();
    const observed = new Set<string>();
    for (const agent of data.agents) {
      const state = agentState(agent);
      const previous = agentStates.current.get(agent.id);
      const tag = agentNotificationTag(agent);
      const label = agent.worktreeLabel ?? agent.displayLabel ?? agent.title;
      const focused = selectedItemKey.current === `agent-${agent.id}` && pageFocused();
      const hasQueuedPrompt = agent.queuedPromptCount > 0;
      observed.add(agent.id);
      const pendingCompletion = pendingCompletions.current.get(agent.id);
      // cancel intermediate queue completions
      if ((state !== 'prompt-done' || hasQueuedPrompt) && pendingCompletion !== undefined) {
        window.clearTimeout(pendingCompletion.timer);
        pendingCompletions.current.delete(agent.id);
      }
      if (previous !== undefined && previous !== 'action-required' && state === 'action-required') {
        const body = agent.question === undefined ? `${label} is waiting for your response.` : `${label}: ${agent.question.text}`;
        if (focused) dismissAgentNotifications(agent);
        else void showNotification('question', 'Agent has a question', body, tag, `/#agent=${encodeURIComponent(agent.id)}`, agent.worktreeId);
      }
      if (previous === 'working' && state === 'prompt-done' && !hasQueuedPrompt) {
        const delay = 2_000;
        const timer = window.setTimeout(() => void refresh(), delay);
        pendingCompletions.current.set(agent.id, { due: Date.now() + delay, timer });
      } else if (state === 'prompt-done' && !hasQueuedPrompt && pendingCompletion !== undefined && Date.now() >= pendingCompletion.due) {
        window.clearTimeout(pendingCompletion.timer);
        pendingCompletions.current.delete(agent.id);
        void showNotification('finished', 'Agent finished', `${label} is ready for another prompt.`, tag, `/#agent=${encodeURIComponent(agent.id)}`, agent.worktreeId);
      }
      if (previous === 'action-required' && state === 'working') void dismissNotification(tag);
      next.set(agent.id, state);
    }
    for (const [agentId, pending] of pendingCompletions.current) {
      if (observed.has(agentId)) continue;
      window.clearTimeout(pending.timer);
      pendingCompletions.current.delete(agentId);
    }
    agentStates.current = next;
  }, [data, viewAgent]);
  const agentIds = data?.agents.map(agent => agent.id).join('\u0000') ?? '';
  useEffect(() => {
    if (!data) return;
    let closed = false;
    const sockets: WebSocket[] = [];
    for (const agent of data.agents) {
      if (logSnapshots.has(agent.id)) continue;
      void request(`/api/agents/${encodeURIComponent(agent.id)}/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'logs' }) }).then(async response => {
        if (!response.ok || closed) return;
        const { ticket } = await response.json();
        if (closed) return;
        const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/logs/${encodeURIComponent(agent.id)}`, ['rac', ticket]);
        sockets.push(socket);
        socket.onmessage = event => { if (!closed) cacheLogFrame(agent.id, JSON.parse(event.data) as LogFrame); socket.close(); };
      }).catch(() => {});
    }
    return () => { closed = true; sockets.forEach(socket => socket.close()); };
  }, [agentIds]);
  const items: DashboardItem[] = data === undefined ? [] : [
    ...data.agents.filter(agent => !isEmbeddedUpdateAdvisor(agent)).map(agent => {
      const operation = agentPendingOperation(agent);
      return { key: `agent-${agent.id}`, label: agentLabel(agent), state: agentState(agent), order: agent.worktreeOrder ?? Number.MAX_SAFE_INTEGER, unread: agent.unread === true, operation, agent };
    }),
    ...data.worktrees.filter(worktree => {
      // retain pending and explicitly visible tabs
      return worktree.pinned || worktree.sleeping === true || pendingNewTaskSources.has(worktree.id) || pendingWorktreeLaunches.has(worktree.id);
    }).map(worktree => {
      const operation = worktreePendingOperation(worktree);
      return { key: `worktree-${worktree.id}`, label: worktree.label, state: worktree.sleeping === true ? 'sleeping' as const : 'closed' as const, order: worktree.order, unread: false, operation, worktree };
    })
  ].sort((left, right) => left.order - right.order);
  const activeItemKey = items[active]?.key;
  selectedItemKey.current = activeItemKey;
  useEffect(() => { setActive(current => Math.min(current, Math.max(items.length - 1, 0))); }, [items.length]);
  const tabKey = items.map(item => item.key).join('\u0000');
  useEffect(() => {
    // activate initial and same-document links
    const activateLinkedItem = () => {
      const hash = location.hash;
      const encoded = hash.startsWith('#worktree=') ? hash.slice(10) : hash.startsWith('#agent=') ? hash.slice(7) : hash.startsWith('#tab=') ? hash.slice(5) : '';
      let target = '';
      try { target = decodeURIComponent(encoded); } catch { /* retain the current tab */ }
      const linked = hash.startsWith('#worktree=')
        ? items.findIndex(item => item.agent?.worktreeId === target || item.worktree?.id === target)
        : hash.startsWith('#agent=')
          ? items.findIndex(item => item.agent?.id === target)
          : items.findIndex(item => item.label === target);
      // ignore unavailable destinations
      if (linked < 0) return;
      const linkedItem = items[linked];
      setActive(linked);
      // clear the selected notification state
      if (linkedItem?.agent !== undefined) viewAgent(linkedItem.agent);
    };
    activateLinkedItem();
    window.addEventListener('hashchange', activateLinkedItem);
    return () => window.removeEventListener('hashchange', activateLinkedItem);
  }, [tabKey, viewAgent]);
  const select = (index: number) => { const item = items[index]; if (!item) return; const changed = selectedItemKey.current !== item.key; selectedItemKey.current = item.key; if (changed && item.agent !== undefined) viewAgent(item.agent); const target = item.agent === undefined ? `tab=${encodeURIComponent(item.label)}` : `agent=${encodeURIComponent(item.agent.id)}`; history.replaceState(null, '', `${location.pathname}${location.search}#${target}`); setActive(index); };
  // select one canonical worktree from Davo
  const selectVoiceWorktree = (worktreeId: string) => {
    const index = items.findIndex(candidate => candidate.agent?.worktreeId === worktreeId || candidate.worktree?.id === worktreeId);
    // reject worktrees without a visible tab
    if (index < 0) return undefined;
    const selected = items[index];
    // retain the canonical dashboard label
    if (selected === undefined) return undefined;
    select(index);
    return { worktreeId, worktreeLabel: selected.agent?.worktreeLabel ?? selected.worktree?.label ?? selected.label };
  };
  useShiftArrowTabCycling(active, items.length, select);
  useEffect(() => {
    if (activateAgentId === undefined) return;
    const index = items.findIndex(candidate => candidate.agent?.id === activateAgentId);
    if (index < 0) return;
    select(index);
    setActivateAgentId(undefined);
  }, [activateAgentId, tabKey]);
  // activate one newly opened worktree tab
  useEffect(() => {
    // wait for the pending tab
    if (activateWorktreeId === undefined) return;
    const index = items.findIndex(candidate => candidate.worktree?.id === activateWorktreeId);
    // wait for the matching item
    if (index < 0) return;
    select(index);
    setActivateWorktreeId(undefined);
  }, [activateWorktreeId, tabKey]);
  // open one scratch agent
  const launched = (agentId: string) => {
    setLaunchErrorMessage('');
    setActivateAgentId(agentId);
    void refresh();
  };
  // complete one dashboard-confirmed worktree launch
  const worktreeLaunched = (agentId: string, worktree: Worktree, operationKey: string) => {
    // ignore callbacks after dashboard teardown
    if (!dashboardMounted.current) return;
    setLaunchErrorMessage('');
    const visible = dashboardSnapshot.current?.agents.some(agent => agent.id === agentId && agent.worktreeId === worktree.id) === true;
    const action = worktree.sleeping === true ? 'wake' : 'launch';
    const existing = pendingWorktreeLaunches.get(worktree.id);
    // replace one prior confirmation timer
    if (existing?.confirmationTimer !== undefined) window.clearTimeout(existing.confirmationTimer);
    // retain the placeholder through dashboard propagation
    if (!visible) {
      const confirmationTimer = window.setTimeout(() => {
        const pendingLaunch = pendingWorktreeLaunches.get(worktree.id);
        // ignore replaced or completed handoffs
        if (!dashboardMounted.current || pendingLaunch?.agentId !== agentId) return;
        pendingWorktreeLaunches.delete(worktree.id);
        setPendingOperation(operationKey, false);
        const detail = `${worktree.label} ${action === 'wake' ? 'woke up' : 'started'}, but its agent did not remain discoverable. Try again.`;
        setLaunchErrorMessage(detail);
        showOperationFeedback({ tone: 'error', message: `${worktree.label} did not finish ${action === 'wake' ? 'waking up' : 'starting'}`, detail, worktreeId: worktree.id });
        void refresh();
      }, worktreeLaunchConfirmationMs);
      pendingWorktreeLaunches.set(worktree.id, { operationKey, agentId, confirmationTimer });
    }
    else {
      pendingWorktreeLaunches.delete(worktree.id);
      setPendingOperation(operationKey, false);
      // preserve newer navigation choices
      if (selectedItemKey.current === `worktree-${worktree.id}`) setActivateAgentId(agentId);
    }
    void refresh();
  };
  const createAgent = async () => {
    if (creatingAgent) return;
    setLaunchErrorMessage('');
    setLauncherOpen(false);
    setCreatingAgent(true);
    showOperationFeedback({ tone: 'pending', message: 'Starting scratch agent…', detail: 'Creating a new temporary session and waiting for it to become ready.' });
    try {
      const response = await request('/api/agents/launch', { method: 'POST' });
      if (!response.ok) {
        const message = await launchError(response);
        setLaunchErrorMessage(message);
        return showOperationFeedback({ tone: 'error', message: 'Scratch agent could not start', detail: message });
      }
      const payload = await response.json() as { agentId?: unknown };
      if (typeof payload.agentId !== 'string') {
        const message = 'The agent started but could not be opened.';
        setLaunchErrorMessage(message);
        return showOperationFeedback({ tone: 'error', message: 'Scratch agent could not be opened', detail: message });
      }
      launched(payload.agentId);
      showOperationFeedback({ tone: 'success', message: 'Scratch agent started', detail: 'The new session is ready and its output is connecting.' });
    } catch {
      const message = 'Unable to reach the console while launching the agent.';
      setLaunchErrorMessage(message);
      showOperationFeedback({ tone: 'error', message: 'Scratch agent could not start', detail: message });
    }
    finally { setCreatingAgent(false); }
  };
  useLayoutEffect(() => {
    const measure = () => {
      const tabs = tabsRef.current; const plus = plusRef.current;
      if (!tabs || !plus) return;
      const siblings = Array.from(tabs.children).filter(node => !node.contains(plus) && !(node as HTMLElement).classList.contains('tab-spacer')) as HTMLElement[];
      setPlusAlone(!siblings.some(node => node.offsetTop === plus.offsetTop));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (tabsRef.current) observer.observe(tabsRef.current);
    return () => observer.disconnect();
  }, [items.length, launcherOpen, activeItemKey]);
  // start or resume from the launcher
  const launchWorktree = async (worktree: Worktree) => {
    const waking = worktree.sleeping === true;
    const key = worktreeLaunchOperationKey(worktree);
    // prevent duplicate worktree launches
    if (!beginPendingOperation(key)) return;
    pendingWorktreeLaunches.set(worktree.id, { operationKey: key });
    let handedOff = false;
    setLauncherOpen(false);
    setActivateWorktreeId(worktree.id);
    setLaunchErrorMessage('');
    showOperationFeedback({ tone: 'pending', message: `${waking ? 'Waking' : 'Starting'} ${worktree.label}…`, detail: waking ? 'Running the resume alias and waiting for the previous conversation.' : 'Launching Codex and waiting for the agent session to become ready.', worktreeId: worktree.id });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/${waking ? 'wake' : 'launch'}`, { method: 'POST' });
      // surface failed starts
      if (!response.ok) {
        const message = await launchError(response);
        setLaunchErrorMessage(message);
        return showOperationFeedback({ tone: 'error', message: `${worktree.label} could not ${waking ? 'wake up' : 'start'}`, detail: message, worktreeId: worktree.id });
      }
      const payload = await response.json() as { agentId?: unknown };
      // require the discovered replacement agent
      if (typeof payload.agentId !== 'string') {
        const message = `The agent ${waking ? 'woke up' : 'started'} but could not be opened.`;
        setLaunchErrorMessage(message);
        return showOperationFeedback({ tone: 'error', message: `${worktree.label} could not be opened`, detail: message, worktreeId: worktree.id });
      }
      worktreeLaunched(payload.agentId, worktree, key);
      handedOff = true;
      showOperationFeedback({ tone: 'success', message: `${worktree.label} ${waking ? 'is awake' : 'started'}`, detail: waking ? 'The previous Codex conversation resumed and its output is connecting.' : 'The new agent session is ready and its output is connecting.', worktreeId: worktree.id });
    } catch {
      const message = `Unable to reach the console while ${waking ? 'waking' : 'launching'} the agent.`;
      setLaunchErrorMessage(message);
      showOperationFeedback({ tone: 'error', message: `${worktree.label} could not ${waking ? 'wake up' : 'start'}`, detail: message, worktreeId: worktree.id });
    } finally {
      // preserve successful handoffs until dashboard confirmation
      if (!handedOff) {
        pendingWorktreeLaunches.delete(worktree.id);
        setPendingOperation(key, false);
      }
    }
  };
  const selectTarget = (target: DashboardTarget) => {
    const index = items.findIndex(candidate => (target.agentId !== undefined && candidate.agent?.id === target.agentId) || candidate.agent?.worktreeId === target.worktreeId || candidate.worktree?.id === target.worktreeId);
    if (index >= 0) return select(index);
    const worktree = data?.worktrees.find(candidate => candidate.id === target.worktreeId);
    if (worktree !== undefined) void launchWorktree(worktree);
  };
  // open a cached review or replace it with a new scope
  const launchReview = (launch: ReviewLaunch) => {
    const cached = reviewLaunch?.worktreeId === launch.worktreeId && reviewLaunch.scope === launch.scope;
    if (!cached) setReviewIndicator({ generating: true, stale: false });
    setReviewInitialTour(undefined);
    setReviewLaunch(launch);
    setReviewMinimized(true);
  };
  // restore one durable review without starting generation
  const openStoredReview = async (agent: Agent, stored: StoredReviewSummary) => {
    // prevent duplicate restore requests
    if (reviewRestoringWorktreeId !== undefined) return;
    void dismissNotification(reviewNotificationTag(stored.worktreeId));
    setReviewRestoringWorktreeId(stored.worktreeId);
    setReviewIndicator({ generating: true, stale: false });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(stored.worktreeId)}/review-tour`);
      const payload: unknown = await response.json().catch(() => undefined);
      const review = payload !== null && typeof payload === 'object' && (payload as { review?: unknown }).review !== null && typeof (payload as { review?: unknown }).review === 'object' ? (payload as { review: { worktreeId?: unknown; branch?: unknown; tour?: unknown } }).review : undefined;
      // require the dashboard-bound worktree and branch
      if (!response.ok || review?.worktreeId !== stored.worktreeId || review.branch !== stored.branch || !isReviewTour(review.tour)) throw new Error('invalid stored review');
      setReviewInitialTour(review.tour);
      setReviewLaunch({ agentId: agent.id, worktreeId: stored.worktreeId, scope: review.tour.scope });
      setReviewIndicator({ generating: false, stale: false });
      setReviewMinimized(false);
    } catch {
      setReviewIndicator({ generating: false, stale: false });
      await refresh();
    } finally { setReviewRestoringWorktreeId(undefined); }
  };
  // remove one durable review and its local surface
  const dismissReview = async (): Promise<boolean> => {
    // require a bound review
    if (reviewLaunch === undefined) return false;
    const response = await request(`/api/worktrees/${encodeURIComponent(reviewLaunch.worktreeId)}/review-tour`, { method: 'DELETE' }).catch(() => undefined);
    // retain local state after a failed dismissal
    if (response === undefined || !response.ok) return false;
    setData(current => current === undefined ? current : { ...current, reviews: current.reviews?.filter(review => review.worktreeId !== reviewLaunch.worktreeId) });
    setReviewLaunch(undefined);
    setReviewInitialTour(undefined);
    setReviewIndicator({ generating: false, stale: false });
    setReviewMinimized(false);
    void dismissNotification(reviewNotificationTag(reviewLaunch.worktreeId));
    return true;
  };
  if (data === undefined) return <LoadingScreen label={unavailable ? 'Reconnecting to console' : 'Syncing console state'} />;
  const item = items[active];
  const cleanupCount = data.cleanupPending ?? 0;
  const cleanupControl = cleanupCount === 0 ? null : <button ref={cleanupTriggerRef} className="log-control page-arrow cleanup-toggle" aria-label={`Review ${cleanupCount} cleanup ${cleanupCount === 1 ? 'target' : 'targets'}`} title="Review runtime cleanup" aria-haspopup="dialog" aria-expanded={cleanupOpen} onPointerDown={event => event.preventDefault()} onClick={() => void openCleanup()}><svg className="broom-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m19.36 2.72 1.42 1.42-5.72 5.71c1.07 1.54 1.22 3.39.32 4.59L9.06 8.12c1.2-.9 3.05-.75 4.59.32l5.71-5.72ZM5.93 17.57c-2.01-2.01-3.24-4.41-3.58-6.65l4.88-2.09 7.44 7.44-2.09 4.88c-2.24-.34-4.64-1.57-6.65-3.58Z" /></svg><span className="saved-prompts-count cleanup-count" aria-hidden="true">{cleanupCount}</span></button>;
  const cleanupKindLabel: Record<CleanupTarget['kind'], string> = {
    'orphan-worker': 'Orphaned worker',
    'stale-agent': 'Stale agent',
    'hud-pane': 'HUD watcher window',
    'hud-process': 'HUD watcher'
  };
  const cleanupDialog = !cleanupOpen ? null : createPortal(<div className="dialog cleanup-dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title"><div><header className="cleanup-header"><div><h2 id="cleanup-title">Runtime cleanup</h2><p>Select the stale runtime items to clean up. Unchecked items will be dismissed.</p></div><button className="cleanup-close" type="button" aria-label="Close cleanup" disabled={cleanupLoading} onClick={closeCleanup}>×</button></header>{cleanupLoading && cleanupTargets.length === 0 ? <p className="cleanup-loading" role="status"><span className="spinner" />Searching for cleanup targets…</p> : cleanupTargets.length === 0 ? <p className="cleanup-empty">No cleanup targets remain.</p> : <fieldset className="cleanup-targets" disabled={cleanupLoading}><legend className="sr-only">Cleanup targets</legend>{cleanupTargets.map(target => <label key={target.id} className="cleanup-target"><input type="checkbox" checked={cleanupChecked.has(target.id)} onChange={event => setCleanupChecked(current => { const next = new Set(current); if (event.target.checked) next.add(target.id); else next.delete(target.id); return next; })} /><span><strong><small>{cleanupKindLabel[target.kind]}</small>{target.label}</strong><span>{target.detail}</span></span></label>)}</fieldset>}{cleanupError && <p className="cleanup-error" role="alert">{cleanupError}</p>}<footer className="cleanup-actions"><span>{cleanupTargets.length === 0 ? 'Nothing selected' : `${cleanupChecked.size} of ${cleanupTargets.length} selected`}</span><button type="button" disabled={cleanupLoading || cleanupError === 'Unable to load cleanup targets.'} onClick={() => void resolveCleanup()}>{cleanupLoading ? <><span className="spinner" />Working…</> : cleanupChecked.size === 0 ? 'Dismiss all' : 'Cleanup'}</button></footer></div></div>, document.body);
  const stateLabel: Record<AgentState, string> = { working: 'Working', 'prompt-done': 'Prompt done', 'action-required': 'Action required', closed: 'Agent closed', sleeping: 'Sleeping' };
  const activeWorktreeId = item?.agent?.worktreeId ?? item?.worktree?.id;
  const voiceContext = { server: serverInfo.name, serverUrl: serverInfo.url, openWorktrees: otherOpenWorktrees(data.agents, activeWorktreeId), ...(activeWorktreeId === undefined ? {} : { worktreeId: activeWorktreeId, worktree: item?.agent?.worktreeLabel ?? data.worktrees.find(worktree => worktree.id === activeWorktreeId)?.label ?? activeWorktreeId }), ...(item?.agent === undefined ? {} : { agentId: item.agent.id, agent: agentLabel(item.agent) }) };
  const voiceDialog = <VoiceDialog open={voiceOpen} callRequest={voiceCallRequest} context={voiceContext} request={request} onClose={closeVoice} onSelectWorktree={selectVoiceWorktree} onActiveChange={setVoiceActive} />;
  const visibleOperationFeedback = operationFeedback?.worktreeId === undefined || operationFeedback.worktreeId === activeWorktreeId ? operationFeedback : undefined;
  // minimize without discarding the cached review
  const minimizeReview = () => {
    setReviewMinimized(true);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.review-tour-toggle')?.focus());
  };
  // announce a newly generated review
  const notifyReviewReady = (tour: ReviewTour) => {
    // require the matching active review
    if (reviewLaunch === undefined) return;
    const agent = data.agents.find(candidate => candidate.id === reviewLaunch.agentId);
    const label = agent === undefined ? reviewLaunch.worktreeId : agentLabel(agent);
    const scope = tour.scope === 'working' ? 'working changes' : 'pull request';
    void showNotification('system', 'Guided review ready', `${label}'s ${scope} guided review is ready.`, reviewNotificationTag(reviewLaunch.worktreeId), `/#agent=${encodeURIComponent(reviewLaunch.agentId)}`, reviewLaunch.worktreeId);
  };
  // open and acknowledge the local review
  const openLocalReview = () => {
    // require the matching active review
    if (reviewLaunch === undefined) return;
    void dismissNotification(reviewNotificationTag(reviewLaunch.worktreeId));
    setReviewMinimized(false);
  };
  const reviewDialog = reviewLaunch === undefined ? null : <ReviewTourDialog key={`${reviewLaunch.worktreeId}:${reviewLaunch.scope}:${reviewInitialTour?.fingerprint ?? 'generated'}`} launch={reviewLaunch} request={request} minimized={reviewMinimized} initialTour={reviewInitialTour} onMinimize={minimizeReview} onDismiss={dismissReview} onIndicatorChange={setReviewIndicator} onReady={notifyReviewReady} />;
  const storedReview = item?.agent?.worktreeId === undefined ? undefined : data.reviews?.find(review => review.worktreeId === item.agent!.worktreeId);
  const localReview = item?.agent?.worktreeId !== undefined && item.agent.worktreeId === reviewLaunch?.worktreeId;
  const activeReview = localReview ? { ...reviewIndicator, onOpen: openLocalReview } : item?.agent !== undefined && storedReview !== undefined ? { generating: reviewRestoringWorktreeId === storedReview.worktreeId, stale: false, onOpen: () => void openStoredReview(item.agent!, storedReview) } : undefined;
  const tabBar = <><nav className="tabs" ref={tabsRef} role="tablist" aria-label="Agents and worktrees">{items.map((entry, index) => {
    const transition = dashboardOperationLabel(entry.operation);
    const label = transition ?? stateLabel[entry.state];
    return <button key={entry.key} id={`tab-${index}`} role="tab" aria-selected={index === active} aria-controls={`panel-${index}`} tabIndex={index === active ? 0 : -1} className={`${index === active ? 'active ' : ''}${transition === undefined ? `status-${entry.state}` : 'status-transitioning'}${entry.unread ? ' unread' : ''}`} title={`${label}${entry.unread ? ' — Unread' : ''}`} aria-label={`${entry.label} — ${label}${entry.unread ? ' — Unread' : ''}`} aria-busy={transition !== undefined} onClick={() => select(index)}>{transition !== undefined ? <span className="tab-transition-label"><span><span className="spinner" aria-hidden="true" />{entry.label}</span><small>{transition}…</small></span> : entry.state === 'working' ? <span className="tab-label" aria-hidden="true">{entry.label}</span> : entry.label}</button>;
  })}<NotificationControl />{updateControl !== undefined && <button className="update-ready" type="button" onClick={updateControl.onClick}>{updateControl.label} <span>{updateControl.action}</span></button>}<span className="launcher" ref={launcherRef}><button ref={plusRef} className="new-agent-tab" type="button" disabled={creatingAgent} aria-label={creatingAgent ? 'Starting agent' : 'Launch agent'} aria-expanded={launcherOpen} onClick={() => setLauncherOpen(value => !value)}>{creatingAgent ? <span className="spinner" /> : '+'}</button></span>{launcherOpen && <FlyoutPortal onDismiss={() => setLauncherOpen(false)}><div className="launcher-menu more-menu flyout-menu" ref={launcherMenuRef} style={launcherStyle} role="group" aria-label="Agent launcher"><button disabled={creatingAgent} onClick={() => void createAgent()}>~ Scratch</button>{data.worktrees.map(worktree => <button key={worktree.id} disabled={creatingAgent || pendingOperations.has(worktreeLaunchOperationKey(worktree))} onClick={() => void launchWorktree(worktree)}>{worktree.label}</button>)}</div></FlyoutPortal>}{plusAlone && <span className="tab-spacer" aria-hidden="true" />}</nav>{visibleOperationFeedback && <OperationFeedbackBanner feedback={visibleOperationFeedback} onDismiss={() => setOperationFeedback(undefined)} />}{updateError && <p className="launch-error launch-error-global" role="alert">{updateError}</p>}{launchErrorMessage && visibleOperationFeedback?.tone !== 'error' && <p className="launch-error launch-error-global" role="alert">{launchErrorMessage}</p>}</>;
  const consoleClass = `console${voiceOpen ? ' voice-visible' : ''}`;
  if (items.length === 0) return <VoiceTriggerContext.Provider value={voiceTrigger}><main className={consoleClass}>{voiceDialog}<article className="worktree-view cleanup-empty-view">{tabBar}<h2>No sessions</h2>{cleanupCount > 0 && <div className="page-controls cleanup-standalone">{cleanupControl}</div>}{cleanupDialog}{reviewDialog}</article></main></VoiceTriggerContext.Provider>;
  return <VoiceTriggerContext.Provider value={voiceTrigger}><main className={consoleClass}>{voiceDialog}<section className="panel" role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} tabIndex={0}>{item?.agent && <AgentCard key={item.agent.id} agent={item.agent} active={item.state === 'working'} tabBar={tabBar} cleanupControl={cleanupControl} reviewCapability={data.reviewTour} review={activeReview} onReview={launchReview} onDeleted={refresh} onSelectTarget={selectTarget} onPromptFocus={() => viewAgent(item.agent!)} onOperationFeedback={showOperationFeedback} />}{item?.worktree && <WorktreeCard key={item.worktree.id} worktree={item.worktree} tabBar={tabBar} cleanupControl={cleanupControl} onLaunched={worktreeLaunched} onTurnedOff={refresh} onOperationFeedback={showOperationFeedback} />}</section>{cleanupDialog}{reviewDialog}</main></VoiceTriggerContext.Provider>;
}

// coordinate console session and update lifecycle
function App() {
  const [state, setState] = useState<'checking' | 'login' | 'naming' | 'ready' | 'inactive'>('checking');
  const [sessionInfo, setSessionInfo] = useState<SessionInfo>();
  const [serverInfo, setServerInfo] = useState<ServerInfo>(fallbackServerInfo);
  const [serverStatuses, setServerStatuses] = useState<Record<string, InstanceAttention>>({});
  const [error, setError] = useState('');
  const [clientUpdateAvailable, setClientUpdateAvailable] = useState(false);
  const [serverUpdateAvailable, setServerUpdateAvailable] = useState(false);
  const [serverUpdateOpen, setServerUpdateOpen] = useState(false);
  const [serverUpdateMinimized, setServerUpdateMinimized] = useState(false);
  const [reconnecting, setReconnecting] = useState(!consoleReachable);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const applySession = useCallback((current: SessionInfo) => {
    csrf = current.csrfToken;
    // retain validated server identity
    if (isServerInfo(current.server)) setServerInfo(current.server);
    setSessionInfo(current);
    setState(current.active ? current.deviceName === undefined ? 'naming' : 'ready' : 'inactive');
  }, []);
  // rename the current browser client
  const renameClient = useCallback(async (deviceName: string): Promise<string | undefined> => {
    const response = await request('/api/auth/device-name', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceName }) });
    // surface the server validation message
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      return typeof payload?.error === 'string' ? payload.error : 'Unable to rename this client.';
    }
    applySession(await response.json() as SessionInfo);
    return undefined;
  }, [applySession]);
  // rename the current server
  const renameServer = useCallback(async (name: string): Promise<string | undefined> => {
    const response = await request('/api/server/name', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    // surface the server validation message
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      return typeof payload?.error === 'string' ? payload.error : 'Unable to rename this server.';
    }
    const payload = await response.json() as { server?: unknown };
    // publish only validated identity
    if (isServerInfo(payload.server)) setServerInfo(payload.server);
    return undefined;
  }, []);
  // open or restore one shared update review
  const openServerUpdate = useCallback(() => {
    setServerUpdateOpen(true);
    setServerUpdateMinimized(false);
  }, []);
  // hide one update review without stopping it
  const minimizeServerUpdate = useCallback(() => {
    setServerUpdateMinimized(true);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.update-ready')?.focus());
  }, []);
  // discard one inactive update review
  const closeServerUpdate = useCallback(() => {
    setServerUpdateOpen(false);
    setServerUpdateMinimized(false);
  }, []);
  // load every configured Codex account and its limits
  const codexAccounts = useCallback(async (): Promise<{ accounts?: CodexAccount[]; error?: string }> => {
    const response = await request('/api/codex/accounts');
    const payload = await response.json().catch(() => undefined) as { accounts?: unknown; error?: unknown } | undefined;
    // require one sanitized account list
    if (!response.ok || !Array.isArray(payload?.accounts) || !payload.accounts.every(isCodexAccount)) return { error: typeof payload?.error === 'string' ? payload.error : 'Unable to load ChatGPT accounts.' };
    return { accounts: payload.accounts };
  }, []);
  // switch the active Codex account and restart idle worktrees
  const switchCodexAccount = useCallback(async (id: string): Promise<{ account?: CodexAccount; restarts?: CodexAccountRestart[]; error?: string }> => {
    const response = await request('/api/codex/accounts/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    const payload = await response.json().catch(() => undefined) as { account?: unknown; restarts?: unknown; error?: unknown } | undefined;
    // require one sanitized switch result
    if (!response.ok || !isCodexAccount(payload?.account) || !Array.isArray(payload?.restarts) || !payload.restarts.every(isCodexAccountRestart)) return { error: typeof payload?.error === 'string' ? payload.error : 'Unable to switch ChatGPT accounts.' };
    return { account: payload.account, restarts: payload.restarts };
  }, []);
  // redeem one ChatGPT rate-limit reset credit
  const resetCodexAccount = useCallback(async (id: string): Promise<{ outcome?: CodexAccountResetOutcome; account?: CodexAccount; error?: string }> => {
    const response = await request(`/api/codex/accounts/${encodeURIComponent(id)}/reset`, { method: 'POST' });
    const payload = await response.json().catch(() => undefined) as { outcome?: unknown; account?: unknown; error?: unknown } | undefined;
    // require one documented reset outcome
    if (!response.ok || !isCodexAccountResetOutcome(payload?.outcome) || payload?.account !== undefined && !isCodexAccount(payload.account)) return { error: typeof payload?.error === 'string' ? payload.error : 'Unable to use the ChatGPT reset.' };
    return { outcome: payload.outcome, ...(payload.account === undefined ? {} : { account: payload.account }) };
  }, []);
  // start one ChatGPT device-code login
  const startCodexAccountLogin = useCallback(async (repairAccountId?: string): Promise<{ login?: CodexAccountLogin; error?: string }> => {
    const response = await request('/api/codex/accounts/login', {
      method: 'POST',
      ...(repairAccountId === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repairAccountId }) })
    });
    const payload = await response.json().catch(() => undefined) as { login?: unknown; error?: unknown } | undefined;
    // require a safe HTTPS login target
    if (!response.ok || !isCodexAccountLogin(payload?.login)) return { error: typeof payload?.error === 'string' ? payload.error : 'Unable to start ChatGPT login.' };
    return { login: payload.login };
  }, []);
  // read one account-login state
  const codexAccountLoginStatus = useCallback(async (id: string): Promise<CodexAccountLoginStatus | undefined> => {
    const response = await request(`/api/codex/accounts/login/${encodeURIComponent(id)}`);
    const payload = await response.json().catch(() => undefined) as { status?: unknown; account?: unknown; error?: unknown } | undefined;
    const status = payload?.status;
    // retry transient failures through the polling loop
    if (!response.ok || status !== 'pending' && status !== 'succeeded' && status !== 'failed') return undefined;
    // reject malformed completed accounts
    if (payload?.account !== undefined && !isCodexAccount(payload.account)) return undefined;
    return { status, ...(payload?.account === undefined ? {} : { account: payload.account }), ...(typeof payload?.error === 'string' ? { error: payload.error } : {}) };
  }, []);
  // cancel one abandoned account login
  const cancelCodexAccountLogin = useCallback(async (id: string): Promise<void> => {
    await request(`/api/codex/accounts/login/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }, []);
  const refreshSession = useCallback(async () => {
    try {
      const response = await consoleFetch('/api/auth/session', { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) });
      if (response.status === 401) {
        setSessionInfo(undefined);
        setState('login');
        return;
      }
      if (response.ok) applySession(await response.json() as SessionInfo);
    } catch { /* keep the current screen while the reconnect overlay handles availability */ }
  }, [applySession]);
  // return an expired session to login
  const handleUnauthorized = useCallback(() => {
    setSessionInfo(undefined);
    setState('login');
  }, []);
  // refresh ownership after losing control
  const handleInactive = useCallback(() => {
    setState('checking');
    void refreshSession();
  }, [refreshSession]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let unobstructedHeight = Math.max(window.innerHeight, root.clientHeight, viewport?.height ?? 0);
    const editableFocused = () => {
      const element = document.activeElement;
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return !element.disabled;
      if (element instanceof HTMLInputElement) return !element.disabled && !element.readOnly && !['button', 'checkbox', 'file', 'hidden', 'radio', 'range', 'reset', 'submit'].includes(element.type);
      return element instanceof HTMLElement && element.isContentEditable;
    };
    const updateHeight = () => {
      const visibleHeight = viewport?.height ?? window.innerHeight;
      const focused = editableFocused();
      const currentLayoutHeight = Math.max(window.innerHeight, root.clientHeight);
      if (!focused) unobstructedHeight = Math.max(currentLayoutHeight, visibleHeight);
      const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
      const layoutHeight = Math.max(currentLayoutHeight, touchDevice ? unobstructedHeight : 0);
      const keyboardInset = layoutHeight - visibleHeight;
      root.style.setProperty('--app-height', `${visibleHeight}px`);
      root.classList.toggle('software-keyboard-open', focused && keyboardInset >= Math.max(120, layoutHeight * .15));
    };
    const updateAfterFocus = () => window.requestAnimationFrame(updateHeight);
    updateHeight();
    window.addEventListener('resize', updateHeight);
    viewport?.addEventListener('resize', updateHeight);
    viewport?.addEventListener('scroll', updateHeight);
    document.addEventListener('focusin', updateAfterFocus);
    document.addEventListener('focusout', updateAfterFocus);
    return () => {
      window.removeEventListener('resize', updateHeight);
      viewport?.removeEventListener('resize', updateHeight);
      viewport?.removeEventListener('scroll', updateHeight);
      document.removeEventListener('focusin', updateAfterFocus);
      document.removeEventListener('focusout', updateAfterFocus);
      root.classList.remove('software-keyboard-open');
    };
  }, []);
  useEffect(() => {
    return subscribeToConsoleConnection(reachable => {
      setReconnecting(!reachable);
      if (reachable) setReconnectAttempt(attempt => attempt + 1);
    });
  }, []);
  // poll cross-instance attention for authenticated screens
  useEffect(() => {
    // clear stale attention after logout
    if (state === 'checking' || state === 'login') {
      setServerStatuses({});
      return;
    }
    // avoid an unnecessary poll on single-instance consoles
    if (serverInfo.remotes.length === 0) {
      setServerStatuses(current => sameServerStatuses(current, {}) ? current : {});
      return;
    }
    let active = true;
    // refresh the sanitized aggregate
    const refreshServerStatuses = async () => {
      try {
        const response = await request('/api/server-statuses', { signal: AbortSignal.timeout(8_000) }, false);
        // reject unsuccessful aggregate responses
        if (!response.ok) throw new Error('status aggregate unavailable');
        const snapshot = serverStatusesFrom(await response.json());
        // reject malformed aggregate responses
        if (snapshot === undefined) throw new Error('invalid status aggregate');
        // ignore a response after cleanup
        if (!active) return;
        setServerStatuses(current => sameServerStatuses(current, snapshot.attention) ? current : snapshot.attention);
        const local = snapshot.servers.find(candidate => candidate.url === serverInfo.url);
        // refresh names and icons published by every server
        if (local !== undefined) {
          const remotes = snapshot.servers.filter(candidate => candidate.url !== serverInfo.url).map(({ name, url, icon }) => ({ name, url, ...(icon === undefined ? {} : { icon }) }));
          setServerInfo(current => {
            const unchanged = current.name === local.name && current.url === local.url && current.icon === local.icon && current.remotes.length === remotes.length && remotes.every((remote, index) => current.remotes[index]?.name === remote.name && current.remotes[index]?.url === remote.url && current.remotes[index]?.icon === remote.icon);
            return unchanged ? current : { name: local.name, url: local.url, ...(local.icon === undefined ? {} : { icon: local.icon }), remotes };
          });
        }
      } catch {
        // replace stale remote attention with explicit unavailability
        if (active) {
          const unavailable: Record<string, InstanceAttention> = Object.fromEntries([[serverInfo.url, 'idle'], ...serverInfo.remotes.map(remote => [remote.url, 'unavailable'] as const)]);
          setServerStatuses(current => sameServerStatuses(current, unavailable) ? current : unavailable);
        }
      }
    };
    const stopPolling = pollWhileVisible(refreshServerStatuses, 5_000, true, 30_000);
    // stop updates after screen changes
    return () => {
      active = false;
      stopPolling();
    };
  }, [reconnectAttempt, serverInfo, state]);
  useEffect(() => {
    if (!reconnecting) return;
    let closed = false;
    let timer: number | undefined;
    const probe = async () => {
      try {
        const response = await fetch('/healthz', { cache: 'no-store', signal: AbortSignal.timeout(4_000) });
        if (response.ok) {
          setConsoleReachable(true);
          return;
        }
      } catch { /* Keep the overlay visible and retry. */ }
      if (!closed) timer = window.setTimeout(() => void probe(), 1_000);
    };
    void probe();
    return () => {
      closed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [reconnecting]);
  useEffect(() => {
    if (currentUiVersion === undefined) return;
    let closed = false;
    const checkForUpdate = async () => {
      try {
        const response = await consoleFetch('/api/ui-version', { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
        if (!response.ok || closed) return;
        const payload = await response.json() as { version?: unknown };
        if (typeof payload.version === 'string' && payload.version !== currentUiVersion) setClientUpdateAvailable(true);
      } catch { /* Retry at the next interval. */ }
    };
    const stopPolling = pollWhileVisible(checkForUpdate, 30_000, false);
    return () => { closed = true; stopPolling(); };
  }, []);
  // check origin main while the controlling console is open
  useEffect(() => {
    // avoid host fetches before authentication
    if (state !== 'ready') return;
    let closed = false;
    const checkForServerUpdate = async () => {
      const response = await request('/api/server/update-available', { signal: AbortSignal.timeout(30_000) }, false);
      // retry unavailable checks later
      if (!response.ok || closed) return;
      const payload: unknown = await response.json().catch(() => undefined);
      // latch a discovered upstream update
      if (isServerUpdateAvailability(payload) && payload.available) setServerUpdateAvailable(true);
    };
    const stopPolling = pollWhileVisible(checkForServerUpdate, 300_000, true, 1_800_000);
    return () => {
      closed = true;
      stopPolling();
    };
  }, [reconnectAttempt, state]);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (active) setError('');
      try {
        const session = await consoleFetch('/api/auth/session', { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) });
        if (session.ok) {
          const current = await session.json() as SessionInfo;
          if (active) applySession(current);
          return;
        }
        const bootstrap = await consoleFetch('/api/auth/bootstrap', { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) });
        if (!bootstrap.ok) throw new Error('bootstrap unavailable');
        const payload = await bootstrap.json() as { csrfToken?: unknown; server?: unknown };
        if (typeof payload.csrfToken !== 'string') throw new Error('invalid bootstrap');
        csrf = payload.csrfToken;
        // publish unauthenticated server identity
        if (isServerInfo(payload.server)) setServerInfo(payload.server);
      } catch {
        if (active) setError('Unable to connect to the console');
      }
      if (active) setState('login');
    })();
    return () => { active = false; };
  }, [applySession, reconnectAttempt]);
  useEffect(() => {
    if (state === 'checking' || state === 'login') return;
    const checkControl = () => void refreshSession();
    window.addEventListener('focus', checkControl);
    return () => window.removeEventListener('focus', checkControl);
  }, [refreshSession, state]);
  let updateControl: UpdateControl | undefined;
  // prioritize restoring one minimized server update
  if (serverUpdateMinimized) updateControl = { label: 'Server update', action: 'Reopen', onClick: openServerUpdate };
  // reload a stale browser bundle next
  else if (clientUpdateAvailable) updateControl = { label: 'Local update', action: 'Reload', onClick: () => location.reload() };
  // expose one reviewed upstream update
  else if (serverUpdateAvailable) updateControl = { label: 'Upstream update', action: 'View', onClick: openServerUpdate };
  const screen = state === 'checking'
      ? <LoadingScreen />
      : state === 'ready'
        ? <DashboardView onUnauthorized={handleUnauthorized} onInactive={handleInactive} updateControl={updateControl} />
        : (state === 'inactive' || state === 'naming') && sessionInfo !== undefined
          ? <ControlScreen session={sessionInfo} claimed={applySession} />
          : <Login initialError={error} done={applySession} />;
  // expose settings without a manual server update bypass
  const clientSettings = useMemo<ClientSettings | undefined>(() => state === 'ready' && sessionInfo?.deviceName !== undefined ? { deviceName: sessionInfo.deviceName, serverName: serverInfo.name, serverUrl: serverInfo.url, renameClient, renameServer, codexAccounts, switchCodexAccount, resetCodexAccount, startCodexAccountLogin, codexAccountLoginStatus, cancelCodexAccountLogin } : undefined, [cancelCodexAccountLogin, codexAccountLoginStatus, codexAccounts, renameClient, renameServer, resetCodexAccount, serverInfo.name, serverInfo.url, sessionInfo?.deviceName, startCodexAccountLogin, state, switchCodexAccount]);
  return <ServerContext.Provider value={serverInfo}><ServerStatusContext.Provider value={serverStatuses}><ClientSettingsContext.Provider value={clientSettings}>{screen}<ServerUpdateDialog open={serverUpdateOpen} minimized={serverUpdateMinimized} onMinimize={minimizeServerUpdate} onClose={closeServerUpdate} />{reconnecting && <ReconnectingOverlay />}</ClientSettingsContext.Provider></ServerStatusContext.Provider></ServerContext.Provider>;
}
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
createRoot(document.getElementById('root')!).render(<ConsoleBoundary><App /></ConsoleBoundary>);
