import { Component, type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { BoundedTextCache, nextLiveSnapshot } from './client-cache.js';
import { createAnimationFrameTextBatcher, pollWhileVisible } from './client-scheduling.js';
import { createOutputLinkOverlays } from './output-links.js';
import { containOutputScroll } from './output-scroll.js';
import { preserveOutputLongPressSelection } from './output-touch.js';
import { NoteMarkdown } from './note-markdown.js';
import { ProjectOpen } from './project-open.js';
import { PullRequestCard, PullRequestIndicators, PullRequestStatusIcon, type PullRequestSummary } from './pull-request-card.js';
import { type StackAction } from './stack-operations.js';
import { isPromptKeyboardTarget, useShiftArrowTabCycling } from './tab-navigation.js';
import { useViewportFlyout } from './viewport-flyout.js';
import './styles.css';

type OmxQuestion = { id: string; text: string; choices: string[]; paneId: string };
type Stack = { actions: StackAction[]; running?: boolean; transition?: 'starting'|'migrating'; operation?: StackAction; tunnel?: boolean };
type PullRequestChoice = { number: number; title: string; branch: string; draft: boolean; url: string } & Pick<PullRequestSummary, 'checks' | 'issues'>;
type PullRequestWorktree = { worktreeId: string; worktreeName: string; agentId?: string };
type SwitchablePullRequest = PullRequestChoice & { checkedOut: boolean; openIn?: PullRequestWorktree };
type PullRequestSwitchAvailability = { enabled: boolean; pullRequests: SwitchablePullRequest[] };
type DashboardTarget = { worktreeId: string; agentId?: string };
type PromptAction = { label: string; prompt: string };
type GitStatusChange = { code: string; path: string; originalPath?: string; additions?: number; deletions?: number };
type GitStatusSummary = { files: number; staged: number; unstaged: number; untracked: number; conflicted: number; changes?: GitStatusChange[] };
type NewTaskAvailability = { enabled: boolean; reason?: string };
type OperationFeedback = { id: number; tone: 'pending'|'success'|'error'; message: string; detail: string };
type CleanupTarget = { id: string; kind: 'orphan-worker'|'stale-agent'|'hud-pane'|'hud-process'; label: string; detail: string };
type Agent = { id: string; sessionId: string; workspace: string; branch?: string; gitStatus?: GitStatusSummary; title: string; displayLabel?: string; worktreeId?: string; worktreeLabel?: string; worktreeOrder?: number; newTaskConfigured?: boolean; push?: PromptAction; projectUrl?: string; pullRequest?: PullRequestSummary; question?: OmxQuestion; stack?: Stack; unread?: boolean };
type Worktree = { id: string; label: string; path: string; branch?: string; gitStatus?: GitStatusSummary; available: boolean; pinned: boolean; order: number; projectUrl?: string; pullRequest?: PullRequestSummary; stack?: Stack };
type Dashboard = { generation?: number; agents: Agent[]; worktrees: Worktree[]; cleanupPending?: number };
const isDashboard = (value: unknown): value is Dashboard => {
  if (value === null || typeof value !== 'object') return false;
  const dashboard = value as { agents?: unknown; worktrees?: unknown; cleanupPending?: unknown };
  return Array.isArray(dashboard.agents) && Array.isArray(dashboard.worktrees) && (dashboard.cleanupPending === undefined || (Number.isInteger(dashboard.cleanupPending) && (dashboard.cleanupPending as number) >= 0));
};
const isDashboardFrame = (value: unknown): value is { v: 1; type: 'dashboard'; dashboard: Dashboard } => value !== null && typeof value === 'object' && (value as { v?: unknown }).v === 1 && (value as { type?: unknown }).type === 'dashboard' && isDashboard((value as { dashboard?: unknown }).dashboard);
const isCleanupTarget = (value: unknown): value is CleanupTarget => value !== null && typeof value === 'object'
  && typeof (value as CleanupTarget).id === 'string'
  && ['orphan-worker', 'stale-agent', 'hud-pane', 'hud-process'].includes((value as CleanupTarget).kind)
  && typeof (value as CleanupTarget).label === 'string'
  && typeof (value as CleanupTarget).detail === 'string';
type AgentState = 'working' | 'prompt-done' | 'action-required' | 'closed';
type DashboardItem = { key: string; label: string; state: AgentState; order: number; unread: boolean; operation?: 'launching'|'deactivating'|'new-task'; agent?: Agent; worktree?: Worktree };
type LogFrame = { type: 'append' | 'reset'; text?: string; older?: boolean; newer?: boolean; lastPrompt?: string; latestAssistantMessage?: string };
type ChoiceQuestion = { text: string; choices: string[]; omxId?: string };
type SavedPromptAttachment = { name: string; size?: number; data?: string };
type SavedPrompt = { id: string; text: string; attachments?: SavedPromptAttachment[] };
type QueuedPrompt = { id: string; text: string; createdAt: string; attachments?: Array<{ name: string; size: number }> };
type PromptHistoryEntry = { id: string; text: string; createdAt: string };
const isSavedPrompt = (value: unknown): value is SavedPrompt => {
  if (value === null || typeof value !== 'object' || typeof (value as SavedPrompt).id !== 'string' || typeof (value as SavedPrompt).text !== 'string') return false;
  const attachments = (value as SavedPrompt).attachments;
  return attachments === undefined || Array.isArray(attachments) && attachments.every(attachment => attachment !== null && typeof attachment === 'object'
    && typeof attachment.name === 'string'
    && (attachment.size === undefined || Number.isInteger(attachment.size) && attachment.size >= 0)
    && (attachment.data === undefined || typeof attachment.data === 'string'));
};
const isPromptHistoryEntry = (value: unknown): value is PromptHistoryEntry => value !== null
  && typeof value === 'object'
  && typeof (value as PromptHistoryEntry).id === 'string'
  && typeof (value as PromptHistoryEntry).text === 'string'
  && typeof (value as PromptHistoryEntry).createdAt === 'string';
const isQueuedPrompt = (value: unknown): value is QueuedPrompt => value !== null
  && typeof value === 'object'
  && typeof (value as QueuedPrompt).id === 'string'
  && typeof (value as QueuedPrompt).text === 'string'
  && typeof (value as QueuedPrompt).createdAt === 'string'
  && ((value as QueuedPrompt).attachments === undefined || Array.isArray((value as QueuedPrompt).attachments) && (value as QueuedPrompt).attachments!.every(attachment => attachment !== null && typeof attachment === 'object' && typeof attachment.name === 'string' && Number.isInteger(attachment.size) && attachment.size >= 0));
type WorktreeNote = { id: string; text: string };
type SessionInfo = { csrfToken: string; active: boolean; deviceName?: string; controllingDeviceName?: string };
type PromptCommand = { value: string; description: string };
type CommandToken = { start: number; end: number; prefix: '$'|'/'; query: string };
const skillCommands: PromptCommand[] = [
  ['address', 'Address unresolved pull-request review threads'], ['ai-slop-cleaner', 'Clean up AI-generated code'], ['analyze', 'Run read-only repository analysis'], ['ask', 'Ask a local external advisor'], ['autopilot', 'Run the autonomous delivery workflow'], ['autoresearch', 'Run validator-gated research'], ['autoresearch-goal', 'Run durable goal-based research'], ['best-practice-research', 'Research upstream best practices'],
  ['brooks-audit', 'Audit architecture and module dependencies'], ['brooks-debt', 'Assess and prioritize technical debt'], ['brooks-health', 'Create a codebase health dashboard'], ['brooks-review', 'Review code for maintainability decay'], ['brooks-sweep', 'Review and remediate codebase quality'], ['brooks-test', 'Review test quality'], ['cancel', 'Cancel an active OMX workflow'], ['cherry-pick', 'Cherry-pick commits onto this branch'],
  ['code-review', 'Run a comprehensive code review'], ['commit', 'Commit current changes'], ['configure-notifications', 'Configure OMX notifications'], ['deep-interview', 'Clarify requirements through an interview'], ['deploy-notes', 'Generate deploy changelogs and test plans'], ['design', 'Create or update the repo design document'], ['doctor', 'Diagnose and repair OMX installation'], ['finish', 'Run the finish-PR workflow'],
  ['fixup', 'Inspect and repair the current pull request'], ['full-review', 'Run the full review and remediation workflow'], ['github:gh-address-comments', 'Address GitHub PR review feedback'], ['github:gh-fix-ci', 'Fix failing GitHub Actions checks'], ['github:github', 'Triage GitHub repositories, PRs, and issues'], ['github:yeet', 'Commit, push, and open a draft PR'], ['hud', 'Show or configure the OMX HUD'], ['imagegen', 'Generate or edit raster images'],
  ['merge', 'Merge a branch into the current branch'], ['omx-setup', 'Set up and configure OMX'], ['openai-docs', 'Find current OpenAI and Codex documentation'], ['performance-goal', 'Run goal-based performance optimization'], ['pipeline', 'Run a configurable workflow pipeline'], ['plan', 'Create a strategic implementation plan'], ['plugin-creator', 'Create or update a Codex plugin'], ['pr-ci-fix', 'Fix current PR CI failures'],
  ['pr-cleanup-review', 'Review changed code for cleanup issues'], ['pr-draft', 'Create or update a GitHub draft PR'], ['prometheus-strict', 'Run interview-driven clean-room planning'], ['query', 'Answer with read-only investigation'], ['ralph', 'Run a completion and verification loop'], ['ralplan', 'Create a consensus implementation plan'], ['rebase', 'Rebase this branch onto another branch'], ['release', 'Build and release to target environments'],
  ['resolve', 'Resolve a merge, rebase, or cherry-pick'], ['review-and-fix', 'Review, fix, commit, and push findings'], ['review-cockpit', 'Generate Neovim review artifacts'], ['sentry:sentry', 'Inspect Sentry issues and events'], ['skill', 'Manage local skills'], ['skill-creator', 'Create or update a Codex skill'], ['skill-installer', 'Install a curated or repository skill'], ['team', 'Coordinate a shared multi-agent task list'],
  ['test-urls', 'Generate local browser test URLs'], ['ultragoal', 'Run durable repo-native goals'], ['ultraqa', 'Run adversarial end-to-end QA'], ['ultrawork', 'Run high-throughput parallel execution'], ['visual-ralph', 'Iterate a UI against visual references'], ['wiki', 'Manage the persistent project wiki']
].map(([name, description]) => ({ value: `$${name}`, description }));
const slashCommands: PromptCommand[] = [
  { value: '/help', description: 'Show available commands' }, { value: '/skills', description: 'Browse available skills' }, { value: '/status', description: 'Show the current session status' }, { value: '/model', description: 'Choose a model' }, { value: '/compact', description: 'Compact the conversation' }, { value: '/new', description: 'Start a new conversation' }, { value: '/resume', description: 'Resume a conversation' }, { value: '/review', description: 'Review the current changes' }, { value: '/diff', description: 'Show the current diff' }, { value: '/init', description: 'Initialize project guidance' }, { value: '/clear', description: 'Clear the conversation' }, { value: '/quit', description: 'Exit the session' }
];
const mergeSkillCommands = (additional: PromptCommand[]) => {
  const commands = new Map(skillCommands.map(command => [command.value, command]));
  for (const command of additional) commands.set(command.value, command);
  return [...commands.values()].sort((left, right) => left.value.localeCompare(right.value));
};
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

const actionRequired = (agent: Agent) => agent.question !== undefined || /action required/i.test(agent.title);
const agentState = (agent: Agent): AgentState => actionRequired(agent) ? 'action-required' : /^[\u2800-\u28ff]/u.test(agent.title) ? 'working' : 'prompt-done';
const agentLabel = (agent: Agent) => (agent.worktreeLabel ?? agent.displayLabel ?? (actionRequired(agent) ? agent.title.replace(/(?:\[\s*.\s*\]\s*)?action required\s*\|?\s*/i, '🚨 ') : agent.title)) || agent.workspace;
type SpeechRecognitionResult = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type SpeechRecognitionInstance = { continuous: boolean; interimResults: boolean; lang: string; start: () => void; abort: () => void; onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechRecognitionResult> }) => void) | null; onend: (() => void) | null; onerror: ((event: { error?: string }) => void) | null };
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

const logSnapshots = new BoundedTextCache(64, 64 * 1024);
const lastPrompts = new Map<string, string>();
const latestAssistantMessages = new Map<string, string>();
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
const mobileModifiers = new Map<string, { alt: boolean; ctrl: boolean; shift: boolean }>();
const retainedReviewAgents = new Set<string>();
const retainedWorktreeNoteViews = new Map<string, { noteId: string; expanded: boolean }>();
const pendingOperations = new Set<string>();
const pendingOperationListeners = new Map<string, Set<() => void>>();
const pendingNewTaskSources = new Map<string, string>();
const newTaskOperationKey = (worktreeId: string) => `new-task:${worktreeId}`;
const launchOperationKey = (worktreeId: string) => `worktree-launch:${worktreeId}`;
const deactivateOperationKey = (worktreeId: string) => `deactivate:${worktreeId}`;
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
const cacheLogFrame = (id: string, frame: LogFrame) => {
  const text = frame.text ?? '';
  if (frame.type === 'reset') logSnapshots.set(id, text);
  else logSnapshots.append(id, text);
  if (frame.lastPrompt !== undefined) lastPrompts.set(id, frame.lastPrompt);
  if (frame.latestAssistantMessage === undefined) latestAssistantMessages.delete(id);
  else latestAssistantMessages.set(id, frame.latestAssistantMessage);
};

const questionFromOutput = (output: string): ChoiceQuestion | undefined => {
  const lines = output.slice(-32_768).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  for (let start = Math.max(0, lines.length - 20); start < lines.length; start += 1) {
    const choices: string[] = [];
    let end = start;
    while (end < lines.length) { const match = /^(?:[›❯>]\s*)?(\d+)[.)]\s+(.+)$/.exec(lines[end]!); if (!match) break; choices.push(match[2]!); end += 1; }
    if (choices.length < 2) continue;
    const question = lines.slice(Math.max(0, start - 4), start).reverse().find(line => /[?]$|^(?:question|select|choose)\b/i.test(line));
    if (question) return { text: question.replace(/^[›❯>]\s*/, ''), choices };
  }
  return undefined;
};

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
const pageFocused = () => document.visibilityState === 'visible' && document.hasFocus();

const showNotification = async (kind: 'question' | 'finished' | 'system', title: string, body: string, tag: string, url = '/', worktreeId?: string) => {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body, tag, icon: '/favicon.svg', badge: '/notification-badge.png', requireInteraction: kind === 'question', data: { url, kind, worktreeId } };
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
  return <main className="auth-screen"><div className="auth-glow" /><form className="auth-card" onSubmit={login}><div className="auth-mark" aria-hidden="true"><span>&gt;_</span></div><div className="auth-heading"><p>REMOTE // AGENTS</p><h1>Console access</h1></div><label className="sr-only">Username<input type="text" name="username" autoComplete="username" tabIndex={-1} /></label><label>Password<input autoFocus type="password" name="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="auth-submit">Authenticate <span aria-hidden="true">↗</span></button></form></main>;
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
  return <main className="auth-screen loading-screen" aria-live="polite"><div className="auth-glow" /><section className="loading-console console-recovery"><strong className={namingOnly ? undefined : 'control-owner'}>{namingOnly ? 'Name this device.' : `${controller} is active`}</strong>{namingOnly && <span>Give this device a name before continuing.</span>}{needsName && <label>Device name<input autoFocus type="text" value={deviceName} maxLength={64} autoComplete="nickname" placeholder="e.g. Kitchen iPad" onChange={event => setDeviceName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && deviceName.trim()) void takeControl(); }} /></label>}{error && <span className="auth-error" role="alert">{error}</span>}<button type="button" disabled={pending || (needsName && !deviceName.trim())} onClick={() => void takeControl()}>{pending ? <><span className="spinner" />{namingOnly ? 'Saving name' : 'Taking control'}</> : namingOnly ? 'Save device name' : 'Take control'}</button><NotificationControl /></section></main>;
}

class ConsoleBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="auth-screen loading-screen" role="alert"><div className="auth-glow" /><section className="loading-console console-recovery"><strong>Console needs to reconnect</strong><span>The interface hit a temporary problem.</span><button type="button" onClick={() => location.reload()}>Reload console</button></section></main>;
  }
}

function Prompt({ id, history, onHistoryChanged, canCancel, cancelling, deleting, deactivating, swapping, swapped, reviewing, onCancel, onDelete, onDeactivate, onSwap, onReview, onSelectTarget, onPromptFocus, onOperationFeedback, projectUrl, question, worktreeId, newTaskConfigured, pushAction, stack }: { id: string; history: PromptHistoryEntry[]; onHistoryChanged: () => Promise<void>; canCancel: boolean; cancelling: boolean; deleting: boolean; deactivating: boolean; swapping: boolean; swapped: boolean; reviewing: boolean; onCancel: () => void; onDelete?: () => void; onDeactivate?: () => void; onSwap: () => void; onReview: () => void; onSelectTarget: (target: DashboardTarget) => void; onPromptFocus: () => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void; projectUrl?: string; question?: ChoiceQuestion; worktreeId?: string; newTaskConfigured?: boolean; pushAction?: PromptAction; stack?: Stack }) {
  const [value, setValue] = usePromptDraft(id);
  const [commandToken, setCommandToken] = useState<CommandToken>();
  const [activeCommand, setActiveCommand] = useState(0);
  const [projectSkillCommands, setProjectSkillCommands] = useState<PromptCommand[]>([]);
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
  const [queuedPromptAction, setQueuedPromptAction] = useState<{ id: string; kind: 'cancel' | 'edit' | 'move' }>();
  const [queuedPromptEdit, setQueuedPromptEdit] = useState<{ id: string; text: string }>();
  const [queuedPromptError, setQueuedPromptError] = useState<string>();
  const savedConfirmationTimer = useRef<number | undefined>(undefined);
  const copiedSelectionTimer = useRef<number | undefined>(undefined);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const promptInput = useRef<HTMLTextAreaElement | null>(null);
  const historyIndex = useRef<number | undefined>(undefined);
  const historyDraft = useRef('');
  const focusPromptAtEnd = useRef(false);
  const savedPromptGroupRef = useRef<HTMLSpanElement | null>(null);
  const { anchorRef: savedPromptAnchorRef, flyoutRef: savedPromptFlyoutRef, style: savedPromptFlyoutStyle } = useViewportFlyout(savedPromptsOpen);
  const queuedPromptGroupRef = useRef<HTMLSpanElement | null>(null);
  const { anchorRef: queuedPromptAnchorRef, flyoutRef: queuedPromptFlyoutRef, style: queuedPromptFlyoutStyle } = useViewportFlyout(queuedPromptsOpen);
  const promptCommands = useMemo(() => [...mergeSkillCommands(projectSkillCommands), ...slashCommands], [projectSkillCommands]);
  const commandOptions = commandToken === undefined ? [] : promptCommands.filter(command => command.value.startsWith(commandToken.prefix) && command.value.slice(1).toLocaleLowerCase().includes(commandToken.query.toLocaleLowerCase()));
  useEffect(() => { historyIndex.current = undefined; historyDraft.current = ''; }, [id]);
  useEffect(() => {
    let cancelled = false;
    setProjectSkillCommands([]);
    void request(`/api/agents/${encodeURIComponent(id)}/skills`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled || payload === null || typeof payload !== 'object' || !Array.isArray((payload as { skills?: unknown }).skills)) return;
      const commands = (payload as { skills: unknown[] }).skills.flatMap(skill => {
        if (skill === null || typeof skill !== 'object') return [];
        const { name, description } = skill as { name?: unknown; description?: unknown };
        return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(name) && typeof description === 'string' ? [{ value: `$${name}`, description }] : [];
      });
      setProjectSkillCommands(commands);
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
  useEffect(() => {
    if (!savedPromptsOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!savedPromptGroupRef.current?.contains(target) && !savedPromptFlyoutRef.current?.contains(target)) setSavedPromptsOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [savedPromptsOpen, savedPromptFlyoutRef]);
  useEffect(() => {
    if (!queuedPromptsOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!queuedPromptGroupRef.current?.contains(target) && !queuedPromptFlyoutRef.current?.contains(target)) setQueuedPromptsOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [queuedPromptsOpen, queuedPromptFlyoutRef]);
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
  const [ctrlActive, setCtrlActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
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
  useEffect(() => { mobileModifiers.set(id, { alt: altActive, ctrl: ctrlActive, shift: shiftActive }); return () => { mobileModifiers.delete(id); }; }, [id, altActive, ctrlActive, shiftActive]);
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
      } else await Promise.all([onHistoryChanged(), refreshQueuedPrompts()]);
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
  const saveQueuedPrompt = async (queued: QueuedPrompt) => {
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
  const answer = async (index: number) => { if (pending || !beginPendingOperation(pendingKey)) return; try { const url = question?.omxId === undefined ? `/api/agents/${encodeURIComponent(id)}/question` : `/api/agents/${encodeURIComponent(id)}/omx-question`; const body = question?.omxId === undefined ? { index } : { index, questionId: question.omxId }; await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } finally { setPendingOperation(pendingKey, false); } };
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
  const toggleModifier = (name: 'alt'|'ctrl'|'shift') => {
    const setters = { alt: setAltActive, ctrl: setCtrlActive, shift: setShiftActive };
    const current = mobileModifiers.get(id) ?? { alt: false, ctrl: false, shift: false };
    mobileModifiers.set(id, { ...current, [name]: !current[name] });
    setters[name](value => !value);
  };
  const mobileKey = (key: 'tab'|'up'|'down'|'left'|'right'|'dollar'|'slash') => {
    const { alt, ctrl, shift } = mobileModifiers.get(id) ?? { alt: false, ctrl: false, shift: false };
    const arrows = { up: 'A', down: 'B', right: 'C', left: 'D' };
    let value = key === 'tab' ? (shift ? '\x1b[Z' : '\t') : key === 'dollar' ? '$' : key === 'slash' ? '/' : (ctrl || shift || alt ? `\x1b[1;${ctrl && shift ? 6 : ctrl && alt ? 7 : shift && alt ? 4 : ctrl ? 5 : shift ? 2 : 3}${arrows[key]}` : `\x1b[${arrows[key]}`);
    if (alt && (key === 'dollar' || key === 'slash' || key === 'tab')) value = `\x1b${value}`;
    terminalInputs.get(id)?.(value);
  };
  const mobileKeys = <div className="mobile-terminal-keys" aria-label="Terminal keys"><div className="mobile-key-modifiers"><button type="button" aria-label="Tab" onPointerDown={event => { event.preventDefault(); mobileKey('tab'); }}>Tab</button><button type="button" className={shiftActive ? 'active' : ''} aria-pressed={shiftActive} onPointerDown={event => { event.preventDefault(); toggleModifier('shift'); }}>Shift</button><button type="button" className={ctrlActive ? 'active' : ''} aria-pressed={ctrlActive} onPointerDown={event => { event.preventDefault(); toggleModifier('ctrl'); }}>Ctrl</button><button type="button" className={altActive ? 'active' : ''} aria-pressed={altActive} onPointerDown={event => { event.preventDefault(); toggleModifier('alt'); }}>Alt</button></div><div className="mobile-arrow-keys"><button type="button" aria-label="Slash" onPointerDown={event => { event.preventDefault(); mobileKey('slash'); }}>/</button><button type="button" aria-label="Up arrow" onPointerDown={event => { event.preventDefault(); mobileKey('up'); }}><MobileKeyIcon name="up" /></button><button type="button" aria-label="Dollar" onPointerDown={event => { event.preventDefault(); mobileKey('dollar'); }}>$</button><button type="button" aria-label="Left arrow" onPointerDown={event => { event.preventDefault(); mobileKey('left'); }}><MobileKeyIcon name="left" /></button><button type="button" aria-label="Down arrow" onPointerDown={event => { event.preventDefault(); mobileKey('down'); }}><MobileKeyIcon name="down" /></button><button type="button" aria-label="Right arrow" onPointerDown={event => { event.preventDefault(); mobileKey('right'); }}><MobileKeyIcon name="right" /></button></div></div>;
  const cancelButton = <button className="danger icon-button cancel-agent" disabled={!canCancel || cancelling} aria-label="Cancel agent" title="Cancel agent" onClick={onCancel}>{cancelling ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>}</button>;
  const deleteButton = <button className="danger icon-button delete-agent" disabled={deleting} aria-label="Delete agent" title="Delete agent" onClick={onDelete}>{deleting ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-8 0 1 13h8l1-13" /></svg>}</button>;
  const offButton = <button className="danger icon-button deactivate-agent" disabled={deactivating} aria-label="Turn off worktree agent" title="Turn off worktree agent" onClick={onDeactivate}>{deactivating ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9m5.7-5.7a8 8 0 1 1-11.4 0" /></svg>}</button>;
  const stop = onDeactivate !== undefined ? offButton : onDelete === undefined ? cancelButton : deleteButton;
  const swapLabel = reviewing ? 'Close review' : swapped ? 'Return to agent output' : 'Swap to terminal';
  const swap = <button className={`swap-agent icon-button${swapped ? ' active' : ''}`} disabled={swapping} aria-label={swapLabel} title={reviewing ? 'Close review and foreground agent' : swapped ? 'Return to agent output' : 'Background agent and show terminal'} onClick={onSwap}>{swapping ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h13m0 0-4-4m4 4-4 4M19 17H6m0 0 4 4m-4-4 4-4" /></svg>}</button>;
  const selectCommand = (command: PromptCommand) => {
    if (commandToken === undefined) return;
    const next = `${value.slice(0, commandToken.start)}${command.value}${value.slice(commandToken.end)}`;
    const cursor = commandToken.start + command.value.length;
    setValue(next);
    setCommandToken(undefined);
    window.requestAnimationFrame(() => { promptInput.current?.focus(); promptInput.current?.setSelectionRange(cursor, cursor); });
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
  const composer = <div className="prompt-composer"><textarea ref={promptInput} className={listening ? 'voice-listening' : undefined} aria-label="Prompt" aria-description={supportsSpeechRecognition ? 'Press and hold to start dictation. Tap again to stop.' : undefined} aria-autocomplete="list" aria-expanded={commandToken !== undefined} aria-controls={commandToken === undefined ? undefined : `prompt-commands-${id}`} aria-activedescendant={commandOptions[activeCommand] === undefined ? undefined : `prompt-command-${id}-${activeCommand}`} value={value} onFocus={() => { exitTerminalInput.get(id)?.(); onPromptFocus(); }} onBlur={() => setCommandToken(undefined)} onCopy={flashCopiedPromptSelection} onPaste={pasteAttachments} onPointerDown={beginVoiceHold} onPointerUp={endVoiceHold} onPointerCancel={endVoiceHold} onLostPointerCapture={endVoiceHold} onContextMenu={event => { if (voiceHoldStarted.current) event.preventDefault(); }} onKeyDown={event => { const plainArrow = !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey; if (commandOptions.length > 0 && plainArrow && event.key === 'ArrowDown') { event.preventDefault(); setActiveCommand(current => (current + 1) % commandOptions.length); } else if (commandOptions.length > 0 && plainArrow && event.key === 'ArrowUp') { event.preventDefault(); setActiveCommand(current => (current + commandOptions.length - 1) % commandOptions.length); } else if (commandOptions.length > 0 && plainArrow && event.key === 'Enter') { event.preventDefault(); selectCommand(commandOptions[activeCommand] ?? commandOptions[0]!); } else if (plainArrow && event.key === 'ArrowUp' && (historyIndex.current !== undefined || event.currentTarget.selectionStart === event.currentTarget.selectionEnd && !value.slice(0, event.currentTarget.selectionStart).includes('\n'))) { event.preventDefault(); recallPrompt(-1); } else if (plainArrow && event.key === 'ArrowDown' && historyIndex.current !== undefined) { event.preventDefault(); recallPrompt(1); } else if (event.key === 'Escape' && commandToken !== undefined) { event.preventDefault(); setCommandToken(undefined); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveCurrentPrompt(); } else if (event.key === 'Tab') { event.preventDefault(); setValue(current => current + '\t'); } else if (event.key === 'Enter') { event.preventDefault(); if (event.ctrlKey || event.shiftKey || window.matchMedia('(max-width: 600px)').matches) setValue(current => current + '\n'); else void submit(); } }} onChange={updatePrompt} />{commandToken !== undefined && <div className="command-menu" id={`prompt-commands-${id}`} role="listbox" aria-label={`${commandToken.prefix} commands`}>{commandOptions.length > 0 ? commandOptions.map((command, index) => <button key={command.value} id={`prompt-command-${id}-${index}`} type="button" role="option" aria-selected={index === activeCommand} className={index === activeCommand ? 'active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => selectCommand(command)}><code>{command.value}</code><span>{command.description}</span></button>) : <span className="command-menu-empty">No matching commands</span>}</div>}</div>;
  const savedPanel = savedPromptsOpen && createPortal(<section className="saved-prompts-panel more-menu flyout-menu" ref={savedPromptFlyoutRef} style={savedPromptFlyoutStyle} aria-label="Saved prompts"><header><strong>Saved prompts</strong></header><div className="saved-prompts-list">{savedPrompts.map(saved => { const label = saved.text || saved.attachments?.map(attachment => attachment.name).join(', ') || 'Attachments only'; return <div className="saved-prompt-item" key={saved.id}><button className="saved-prompt-restore" type="button" disabled={savedPromptAction !== undefined} title={label} onClick={() => void useSavedPrompt(saved)}>{savedPromptAction?.id === saved.id && savedPromptAction.kind === 'restore' ? <span className="spinner" /> : null}<span className="saved-prompt-copy"><span>{saved.text || 'Attachments only'}</span>{saved.attachments?.length ? <small>{saved.attachments.map(attachment => attachment.name).join(', ')}</small> : null}</span></button><span className="saved-prompt-actions"><button className="saved-prompt-send" type="button" disabled={savedPromptAction !== undefined} aria-label={`Queue saved draft: ${label}`} title="Queue saved draft" onClick={() => void sendSavedPrompt(saved)}>{savedPromptAction?.id === saved.id && savedPromptAction.kind === 'send' ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" /></svg>}</button><button className="saved-prompt-delete" type="button" disabled={savedPromptAction !== undefined} aria-label={`Delete saved draft: ${label}`} title="Delete saved draft" onClick={() => void removeSavedPrompt(saved)}>{savedPromptAction?.id === saved.id && savedPromptAction.kind === 'delete' ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6" /></svg>}</button></span></div>; })}</div></section>, document.body);
  const savedToggle = savedPrompts.length > 0 ? <button className={`saved-prompts-toggle icon-button${savedPromptsOpen ? ' active' : ''}`} type="button" disabled={pending} aria-label={`Saved prompts (${savedPrompts.length})`} aria-expanded={savedPromptsOpen} title={`${savedPrompts.length} saved prompt${savedPrompts.length === 1 ? '' : 's'}`} onClick={() => setSavedPromptsOpen(open => !open)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg><span className="saved-prompts-count" aria-hidden="true">{savedPrompts.length}</span></button> : null;
  const saveLabel = savingPrompt ? 'Saving' : savedConfirmation ? 'Saved' : 'Save';
  const saveButton = <button className={`save-prompt outline-button icon-button${savedConfirmation ? ' saved' : ''}`} type="button" disabled={pending || savingPrompt || (!value.trim() && attachments.length === 0)} aria-label={saveLabel} title={saveLabel} onClick={() => void saveCurrentPrompt()}>{savingPrompt ? <span className="spinner" /> : savedConfirmation ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11l3 3v15H5V3Zm3 0v6h8V3M8 21v-7h8v7" /></svg>}</button>;
  const saveControls = <><span className={`save-prompt-group${savedToggle === null ? '' : ' has-saved-prompts'}`} ref={element => { savedPromptGroupRef.current = element; savedPromptAnchorRef.current = element; }} role="group" aria-label="Saved prompt controls">{saveButton}{savedToggle}</span>{savedPanel}</>;
  if (question) return <section className="prompt question-prompt"><div className="question-copy"><strong>Agent question</strong><span>{question.text}</span></div><div className="question-choices">{question.choices.map((choice, index) => <button key={`${index}-${choice}`} className="question-choice" disabled={pending} onClick={() => void answer(index)}><b>{index + 1}</b>{choice}</button>)}</div><div className="prompt-actions">{stop}{swapped && swap}<span className="prompt-actions-spacer" aria-hidden="true" /><More id={id} worktreeId={worktreeId} newTaskConfigured={newTaskConfigured} pushAction={pushAction} swapDisabled={swapping} onSwap={swapped ? undefined : onSwap} onReview={swapped ? undefined : onReview} onPromptQueued={onHistoryChanged} onSelectTarget={onSelectTarget} onOperationFeedback={onOperationFeedback} /></div></section>;
  const queueLabel = swapped ? 'Enter' : pending ? 'Queueing' : 'Queue';
  const queuePanel = queuedPromptsOpen && createPortal(<section className="queued-prompts-panel more-menu flyout-menu" ref={queuedPromptFlyoutRef} style={queuedPromptFlyoutStyle} aria-label="Queued prompts"><header><strong>Queued prompts</strong></header>{queuedPromptError && <p className="queued-prompt-error" role="alert">{queuedPromptError}</p>}<div className="queued-prompts-list">{queuedPrompts.map((queued, index) => { const label = queued.text || queued.attachments?.map(attachment => attachment.name).join(', ') || 'Attachments only'; const editing = queuedPromptEdit?.id === queued.id; const busy = queuedPromptAction !== undefined; return <div className={`queued-prompt-item${editing ? ' editing' : ''}`} key={queued.id}><span className="queued-prompt-order"><strong className="queued-prompt-position" aria-label={`Queue position ${index + 1}`}>{index + 1}</strong><span className="queued-prompt-order-buttons"><button type="button" disabled={busy || index === 0} aria-label={`Move queued prompt earlier: ${label}`} title="Move earlier" onClick={() => void moveQueuedPrompt(queued, 'earlier')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button type="button" disabled={busy || index === queuedPrompts.length - 1} aria-label={`Move queued prompt later: ${label}`} title="Move later" onClick={() => void moveQueuedPrompt(queued, 'later')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></span></span>{editing ? <textarea aria-label={`Edit queued prompt: ${label}`} value={queuedPromptEdit.text} maxLength={32_000} autoFocus onChange={event => setQueuedPromptEdit({ id: queued.id, text: event.target.value })} /> : <button className="queued-prompt-copy" type="button" disabled={busy} title={label} onClick={() => setQueuedPromptEdit({ id: queued.id, text: queued.text })}><span>{queued.text || 'Attachments only'}</span>{queued.attachments?.length ? <small>{queued.attachments.map(attachment => attachment.name).join(', ')}</small> : null}</button>}<span className="queued-prompt-actions">{editing ? <><button type="button" disabled={busy || !queuedPromptEdit.text.trim() && queued.attachments === undefined} aria-label={`Save queued prompt: ${label}`} title="Save changes" onClick={() => void saveQueuedPrompt(queued)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></button><button type="button" disabled={busy} aria-label={`Stop editing queued prompt: ${label}`} title="Stop editing" onClick={() => setQueuedPromptEdit(undefined)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></> : <button type="button" disabled={busy} aria-label={`Edit queued prompt: ${label}`} title="Edit prompt" onClick={() => setQueuedPromptEdit({ id: queued.id, text: queued.text })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4Zm10-13 3 3" /></svg></button>}<button className="queued-prompt-cancel" type="button" disabled={busy} aria-label={`Cancel queued prompt: ${label}`} title="Cancel queued prompt" onClick={() => void cancelQueuedPrompt(queued)}>{queuedPromptAction?.id === queued.id && queuedPromptAction.kind === 'cancel' ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-8 0 1 13h8l1-13" /></svg>}</button></span></div>; })}</div></section>, document.body);
  const queuedToggle = !swapped && queuedPrompts.length > 0 ? <button className={`queued-prompts-toggle icon-button${queuedPromptsOpen ? ' active' : ''}`} type="button" disabled={pending} aria-label={`Queued prompts (${queuedPrompts.length})`} aria-expanded={queuedPromptsOpen} title={`${queuedPrompts.length} queued prompt${queuedPrompts.length === 1 ? '' : 's'}`} onClick={() => setQueuedPromptsOpen(open => !open)}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg><span className="saved-prompts-count queued-prompts-count" aria-hidden="true">{queuedPrompts.length}</span></button> : null;
  const queueControls = <><span className={`queue-prompt-group${queuedToggle === null ? '' : ' has-queued-prompts'}`} ref={element => { queuedPromptGroupRef.current = element; queuedPromptAnchorRef.current = element; }} role="group" aria-label="Queue controls"><button className="queue icon-button" disabled={pending || (!swapped && !value && attachments.length === 0)} aria-label={queueLabel} title={queueLabel} onClick={() => void submit()}>{pending ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" /></svg>}</button>{queuedToggle}</span>{queuePanel}</>;
  return <section className="prompt">{composer}{attachments.length > 0 && <div className="prompt-attachments" aria-label="Selected attachments">{attachments.map((file, index) => <span key={`${file.name}-${index}`} title={file.name}>{file.name}<button type="button" disabled={pending} aria-label={`Remove ${file.name}`} onClick={() => setAttachments(current => current.filter((_, candidate) => candidate !== index))}>×</button></span>)}</div>}{attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}{savedPromptError && <p className="saved-prompt-error" role="alert">{savedPromptError}</p>}{queuedPromptError && !queuedPromptsOpen && <p className="queued-prompt-error" role="alert">{queuedPromptError}</p>}<input ref={attachmentInput} className="attachment-input" type="file" multiple onChange={event => { chooseAttachments(event.target.files); event.target.value = ''; }} /><div className="prompt-actions">{stop}{swapped && swap}<span className="prompt-actions-spacer" aria-hidden="true" /><More id={id} worktreeId={worktreeId} newTaskConfigured={newTaskConfigured} pushAction={pushAction} attachDisabled={pending} onAttach={swapped ? undefined : () => attachmentInput.current?.click()} swapDisabled={swapping} onSwap={swapped ? undefined : onSwap} onReview={swapped ? undefined : onReview} onPromptQueued={onHistoryChanged} onSelectTarget={onSelectTarget} onOperationFeedback={onOperationFeedback} /><ProjectOpen url={projectUrl} stack={stack} onStackAction={worktreeId === undefined ? undefined : action => request(`/api/worktrees/${encodeURIComponent(worktreeId)}/commands/${action}`, { method: 'POST' })} />{saveControls}{queueControls}</div>{mobileKeys}</section>;
}

type MobileKeyIconName = 'control'|'shift'|'tab'|'up'|'down'|'left'|'right';
function MobileKeyIcon({ name }: { name: MobileKeyIconName }) {
  const paths: Record<MobileKeyIconName, string> = { control: 'M8 5h8v4h3v6h-3v4H8v-4H5V9h3zm2 2v4H7v2h3v4h4v-4h3v-2h-3V7z', shift: 'm12 4 6 6h-4v8h-4v-8H6z', tab: 'M4 8h11m0 0-3-3m3 3-3 3M20 16H9m0 0 3 3m-3-3 3-3', up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6', left: 'm15 6-6 6 6 6', right: 'm9 6 6 6-6 6' };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

const isWorktreeNote = (value: unknown): value is WorktreeNote => value !== null && typeof value === 'object' && typeof (value as WorktreeNote).id === 'string' && typeof (value as WorktreeNote).text === 'string';
const notePreview = (text: string) => {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return `${words.length === 0 ? 'Blank note' : words.slice(0, 6).join(' ')}…`;
};
const appendTextBlock = (current: string, text: string) => `${current}${current ? current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n' : ''}${text}`;
const bottomAlignedSnapshot = (value: string, rows: number) => {
  const renderedRows = value ? value.split('\n').length : 0;
  return `${'\n'.repeat(Math.max(0, rows - renderedRows))}${value}`;
};

function useWorktreeNotes(worktreeId?: string, agentId?: string, latestAssistantMessage?: string, onPromptQueued?: () => void | Promise<void>) {
  const [notes, setNotes] = useState<WorktreeNote[]>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeNote, setActiveNote] = useState<WorktreeNote>();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copyState, setCopyState] = useState<'idle'|'copied'|'error'>('idle');
  const [sendState, setSendState] = useState<'idle'|'sending'|'queued'|'error'>('idle');
  const [dirtyCount, setDirtyCount] = useState(0);
  const [saveStatus, setSaveStatus] = useState<'saved'|'saving'|'error'>('saved');
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
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
    if (worktreeId === undefined || (!immediate && queuedTexts.current.get(noteId) === text)) return;
    queuedTexts.current.set(noteId, text);
    const version = (saveVersions.current.get(noteId) ?? 0) + 1;
    saveVersions.current.set(noteId, version);
    if (activeNoteRef.current?.id === noteId) setSaveStatus('saving');
    const save = async () => {
      if (!immediate && saveVersions.current.get(noteId) !== version) return;
      try {
        const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/notes/${encodeURIComponent(noteId)}`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
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
  }, [worktreeId]);

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
  }, []);
  useEffect(() => {
    const retained = worktreeId === undefined ? undefined : retainedWorktreeNoteViews.get(worktreeId);
    setNotes(undefined);
    setMenuOpen(false);
    setActiveNote(undefined);
    setExpanded(retained?.expanded ?? false);
    setEditing(false);
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
  }, [worktreeId]);
  useEffect(() => {
    if (worktreeId === undefined) return;
    let cancelled = false;
    setLoading(true);
    void request(`/api/worktrees/${encodeURIComponent(worktreeId)}/notes`).then(async response => {
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { notes?: unknown }).notes)) throw new Error();
      const loaded = (payload as { notes: unknown[] }).notes.filter(isWorktreeNote);
      if (cancelled) return;
      for (const note of loaded) acknowledgedTexts.current.set(note.id, note.text);
      setNotes(loaded);
      const retained = retainedWorktreeNoteViews.get(worktreeId);
      if (retained !== undefined) {
        const note = loaded.find(candidate => candidate.id === retained.noteId);
        if (note === undefined) retainedWorktreeNoteViews.delete(worktreeId);
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
  }, [worktreeId]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => { if (!anchorRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);
  useLayoutEffect(() => { if (activeNote !== undefined && editing) editorRef.current?.focus(); }, [activeNote?.id, editing]);

  const restoreTriggerFocus = () => window.requestAnimationFrame(() => triggerRef.current?.focus());
  const open = (note: WorktreeNote, edit?: boolean) => {
    flush();
    const text = dirtyTexts.current.get(note.id) ?? note.text;
    const opened = { ...note, text };
    activeNoteRef.current = opened;
    draftRef.current = text;
    if (!acknowledgedTexts.current.has(note.id)) acknowledgedTexts.current.set(note.id, note.text);
    setDraft(text);
    setActiveNote(opened);
    setExpanded(false);
    if (worktreeId !== undefined) retainedWorktreeNoteViews.set(worktreeId, { noteId: note.id, expanded: false });
    setEditing(edit ?? !text.trim());
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
    if (worktreeId === undefined) return undefined;
    if (notes !== undefined) return notes;
    setLoading(true);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/notes`);
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
  const create = async (text = '') => {
    if (worktreeId === undefined || loading) return;
    setLoading(true);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/notes`, { method: 'POST' });
      const note: unknown = response.ok ? await response.json() : undefined;
      if (!isWorktreeNote(note)) throw new Error();
      acknowledgedTexts.current.set(note.id, note.text);
      setNotes(current => [note, ...(current ?? [])]);
      open(note, !text.trim());
      if (text) updateDraft(note, text);
    } catch { setSaveStatus('error'); }
    finally { setLoading(false); }
  };
  const toggle = async () => {
    if (menuOpen) return setMenuOpen(false);
    const loaded = await load();
    if (loaded === undefined) return;
    const latestAvailable = latestAssistantMessage !== undefined && latestAssistantMessage.length <= 30_000 && !loaded.some(note => note.text === latestAssistantMessage);
    if (loaded.length === 0 && !latestAvailable) return await create();
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
      await onPromptQueued?.();
      clearActionStatusLater();
    } catch {
      setSendState('error');
    } finally {
      setPendingOperation(promptPendingKey, false);
    }
  };
  const remove = () => {
    const note = activeNoteRef.current;
    if (worktreeId === undefined || note === undefined || deleting) return;
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    setDeleting(true);
    saveQueue.current = saveQueue.current.then(async () => {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/notes/${encodeURIComponent(note.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      acknowledgedTexts.current.delete(note.id);
      dirtyTexts.current.delete(note.id);
      queuedTexts.current.delete(note.id);
      failedNotes.current.delete(note.id);
      saveVersions.current.delete(note.id);
      setDirtyCount(dirtyTexts.current.size);
      setNotes(current => current?.filter(candidate => candidate.id !== note.id));
      activeNoteRef.current = undefined;
      retainedWorktreeNoteViews.delete(worktreeId);
      setActiveNote(undefined);
      setExpanded(false);
      setEditing(false);
      restoreTriggerFocus();
    }).catch(() => {
      if (dirtyTexts.current.has(note.id)) failedNotes.current.add(note.id);
      setDirtyCount(dirtyTexts.current.size);
      setSaveStatus('error');
    }).finally(() => setDeleting(false));
  };
  const close = () => {
    if (!draftRef.current.trim()) {
      remove();
      return;
    }
    flush();
    activeNoteRef.current = undefined;
    if (worktreeId !== undefined) retainedWorktreeNoteViews.delete(worktreeId);
    setActiveNote(undefined);
    setExpanded(false);
    setEditing(false);
    restoreTriggerFocus();
  };

  if (worktreeId === undefined) return { active: false, appendToActive, canAppendToActive, canCreate: false, control: null, createWithText: create, pane: null };
  const noteCount = notes?.length ?? 0;
  const latestResponseAvailable = notes !== undefined && latestAssistantMessage !== undefined && latestAssistantMessage.length <= 30_000 && !notes.some(note => note.text === latestAssistantMessage);
  const notesLabel = dirtyCount === 0 ? `Notes (${noteCount})` : `Notes (${noteCount}; ${dirtyCount} unsaved)`;
  const control = <div className="notes-control" ref={anchorRef}><button ref={triggerRef} className={`log-control page-arrow notes-toggle${menuOpen || activeNote !== undefined ? ' active' : ''}${dirtyCount > 0 ? ' unsaved' : ''}${latestResponseAvailable ? ' latest-response-available' : ''}`} aria-label={notesLabel} title={notesLabel} aria-expanded={menuOpen} disabled={loading} onPointerDown={event => event.preventDefault()} onClick={() => void toggle()}>{loading ? <span className="spinner" /> : <svg className="notes-icon" viewBox="0 0 24 24" aria-hidden="true"><path className="notes-icon-sheet" d="M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M15 21v-6h6" /></svg>}{noteCount > 0 && <span className="saved-prompts-count notes-count" aria-hidden="true">{noteCount}</span>}</button>{menuOpen && <div className="notes-menu" aria-label="Worktree notes">{latestResponseAvailable && <button className="log-control save-latest-response" onClick={() => void create(latestAssistantMessage)}>Save latest response</button>}{notes?.map(note => <button key={note.id} className="log-control note-choice" title={note.text || 'Blank note'} onClick={() => open(note)}>{notePreview(note.text)}</button>)}<button className="log-control new-note" onClick={() => void create()}>+ New note</button></div>}</div>;
  const actionStatus = copyState === 'error' ? 'Copy failed' : sendState === 'queued' ? 'Queued' : sendState === 'error' ? 'Queue failed' : '';
  const toggleExpanded = () => setExpanded(value => {
    const next = !value;
    if (worktreeId !== undefined && activeNote !== undefined) retainedWorktreeNoteViews.set(worktreeId, { noteId: activeNote.id, expanded: next });
    return next;
  });
  const pane = activeNote === undefined ? null : <section className={`note-pane${expanded ? ' expanded' : ''}`} role="dialog" aria-label="Worktree note" onKeyDown={event => { if (event.key === 'Escape' && !deleting && sendState !== 'sending') { event.preventDefault(); close(); } }}><header><strong>Worktree note</strong><span className={`note-save-status ${saveStatus}`} role={saveStatus === 'error' ? 'alert' : 'status'} aria-live={saveStatus === 'error' ? 'assertive' : 'polite'}>{saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Unable to save' : 'Saved'}</span>{actionStatus && <span className={`note-action-status${copyState === 'error' || sendState === 'error' ? ' error' : ''}`} role={copyState === 'error' || sendState === 'error' ? 'alert' : 'status'}>{actionStatus}</span>}<button className={`note-copy${copyState === 'copied' ? ' copied' : ''}`} type="button" disabled={deleting} aria-label={copyState === 'copied' ? 'Note copied' : 'Copy note'} title={copyState === 'copied' ? 'Copied' : 'Copy note'} onClick={() => void copy()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={copyState === 'copied' ? 'm5 12 4 4L19 6' : 'M9 9h10v10H9zM5 15H4V5h10v1'} /></svg></button><button className="note-send" type="button" disabled={agentId === undefined || deleting || promptPending || !draft.trim()} aria-label="Send note as prompt" title={agentId === undefined ? 'Launch an agent to send this note' : 'Send note as prompt'} onClick={() => void send()}>{sendState === 'sending' ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" /></svg>}</button><button className="note-delete" type="button" disabled={deleting || sendState === 'sending'} aria-label="Delete note" title="Delete note" onClick={remove}>{deleting ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-8 0 1 13h8l1-13" /></svg>}</button><button className="note-expand" type="button" disabled={deleting || sendState === 'sending'} aria-label={expanded ? 'Restore note' : 'Expand note'} title={expanded ? 'Restore note' : 'Expand note'} aria-pressed={expanded} onClick={toggleExpanded}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={expanded ? 'M9 3v6H3m18 6h-6v6M3 9l6-6m6 18 6-6' : 'M9 3H3v6m18 6v6h-6M3 3l6 6m6 6 6 6'} /></svg></button><button className="note-close" type="button" disabled={deleting || sendState === 'sending'} aria-label="Close note" title="Close note" onClick={close}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>{editing ? <textarea ref={editorRef} aria-label="Note content" value={draft} maxLength={30_000} disabled={deleting} onChange={event => changeDraft(event.target.value)} onBlur={() => { flush(); if (draftRef.current.trim()) setEditing(false); }} /> : <NoteMarkdown text={draft} onEdit={() => setEditing(true)} />}</section>;
  return { active: activeNote !== undefined, appendToActive, canAppendToActive, canCreate: !loading, control, createWithText: create, pane };
}

const gitCountLabel = (count: number, label: string) => `${count} ${label}${count === 1 ? '' : 's'}`;
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
const gitLineTotals = (changes: GitStatusChange[]) => changes.reduce((totals, change) => ({ additions: totals.additions + (change.additions ?? 0), deletions: totals.deletions + (change.deletions ?? 0) }), { additions: 0, deletions: 0 });
function GitLineSummary({ additions, deletions, className }: { additions: number; deletions: number; className: string }) {
  return <span className={className} aria-label={`${gitCountLabel(additions, 'line')} added, ${gitCountLabel(deletions, 'line')} removed`}><span className="git-lines-added">+{additions}</span><span className="git-lines-deleted">−{deletions}</span></span>;
}
function GitChangeGroup({ label, changes }: { label: string; changes: GitStatusChange[] }) {
  if (changes.length === 0) return null;
  const totals = gitLineTotals(changes);
  return <span className="git-status-group" role="group" aria-label={`${label} files`}><span className="git-status-group-header"><strong>{label}</strong><span>{gitCountLabel(changes.length, 'file')}</span><GitLineSummary {...totals} className="git-status-group-lines" /></span><span className="git-status-file-list">{changes.map((change, index) => <span className={`git-status-file ${gitChangeState(change.code)}`} key={`${change.code}:${change.path}:${index}`}><span className="git-status-file-code" aria-hidden="true">{change.code}</span><span className="git-status-file-path">{change.originalPath === undefined ? change.path : `${change.originalPath} → ${change.path}`}</span>{change.additions === undefined || change.deletions === undefined ? <span className="git-status-file-lines unavailable">binary</span> : <GitLineSummary additions={change.additions} deletions={change.deletions} className="git-status-file-lines" />}</span>)}</span></span>;
}
function GitStatus({ branch, summary, expanded = false, onToggle }: { branch?: string; summary?: GitStatusSummary; expanded?: boolean; onToggle?: () => void }) {
  const lastTouchToggle = useRef<number | undefined>(undefined);
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
  const implementationChanges = summary?.changes?.filter(change => !gitSupportingFile(change.path)) ?? [];
  const supportingChanges = summary?.changes?.filter(change => gitSupportingFile(change.path)) ?? [];
  const changedFiles = summary?.changes;
  const emptyLabel = summary?.files === 0 ? 'No changed files' : 'Changed-file details unavailable';
  const pointerToggle = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    lastTouchToggle.current = performance.now();
    event.preventDefault();
    onToggle?.();
  };
  const clickToggle = () => {
    if (lastTouchToggle.current === undefined || performance.now() - lastTouchToggle.current > 700) onToggle?.();
  };
  return <span className={`git-status-wrap${expanded ? ' expanded' : ''}`}><button className={`git-status-summary ${state}`} type="button" aria-label={label} aria-expanded={expanded} title={label} onPointerDown={pointerToggle} onClick={clickToggle}><span className="git-branch">{branch}</span><span className="git-status-separator" aria-hidden="true">·</span><span className="git-worktree-state">{stateLabel}</span></button>{expanded && <span className="git-status-panel" role="region" aria-label="Changed files"><span className="git-status-panel-header"><span><strong>Changed files</strong>{details.length > 0 && <small className="git-status-details">{details.join(' · ')}</small>}</span><button className="git-status-close" type="button" aria-label="Collapse git status" title="Collapse git status" onPointerDown={pointerToggle} onClick={clickToggle}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></span>{changedFiles !== undefined && changedFiles.length > 0 ? <span className="git-status-files"><GitChangeGroup label="Implementation" changes={implementationChanges} /><GitChangeGroup label="Tests & documentation" changes={supportingChanges} /></span> : <span className="git-status-empty">{emptyLabel}</span>}</span>}</span>;
}

function Log({ id, worktreeId, branch, gitStatus, history, refreshHistory, onQuestion, cleanupControl, terminalMode = false, reviewMode = false, processingLabel, processingDetail }: { id: string; worktreeId?: string; branch?: string; gitStatus?: GitStatusSummary; history: PromptHistoryEntry[]; refreshHistory: () => Promise<void>; onQuestion: (question: ChoiceQuestion | undefined) => void; cleanupControl?: ReactNode; terminalMode?: boolean; reviewMode?: boolean; processingLabel?: string; processingDetail?: string }) {
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState<'prompt' | 'git'>();
  const { anchorRef: historyAnchorRef, flyoutRef: historyFlyoutRef, style: historyFlyoutStyle } = useViewportFlyout(historyOpen);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [inputActive, setInputActive] = useState(terminalMode);
  const [selectionActive, setSelectionActive] = useState(false);
  const [selectionToolbar, setSelectionToolbar] = useState<{ text: string; top: number }>();
  const copyOutputSelectionRef = useRef<(value: string) => Promise<void>>(copyText);
  const worktreeNotes = useWorktreeNotes(worktreeId, id, latestAssistantMessage, refreshHistory);
  useEffect(() => {
    if (!historyOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!historyAnchorRef.current?.contains(target) && !historyFlyoutRef.current?.contains(target)) setHistoryOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [historyOpen, historyAnchorRef, historyFlyoutRef]);
  useLayoutEffect(() => {
    if (!historyOpen || historyListRef.current === null) return;
    historyListRef.current.scrollTop = historyListRef.current.scrollHeight;
  }, [historyOpen, history]);
  useEffect(() => {
    let socket: WebSocket | undefined;
    let closed = false;
    let retry: number | undefined;
    let snapshot = '';
    let interactiveSocket: WebSocket | undefined;
    let connectingInteractive = false;
    let attemptedLogConnection = false;
    let pendingRender = false;
    let renderingSnapshot = false;
    let flushFrame: number | undefined;
    let resizeFrame: number | undefined;
    let overlayFrame: number | undefined;
    let analysisFrame: number | undefined;
    let copiedSelectionTimer: number | undefined;
    let rerenderAfterResize = () => {};
    const pendingInput: string[] = [];
    setStatus('Connecting');
    setHasRendered(false);
    setLastPrompt(lastPrompts.get(id));
    setToolbarExpanded(undefined);
    setLatestAssistantMessage(latestAssistantMessages.get(id));
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
    const overlays = createOutputLinkOverlays(canvas.current!, () => { suppressOutputFocusUntil = performance.now() + 250; });
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
    const scheduleOutputAnalysis = () => {
      if (terminalMode) return;
      if (analysisFrame !== undefined) return;
      analysisFrame = window.requestAnimationFrame(() => {
        analysisFrame = undefined;
        if (closed) return;
        onQuestion(questionFromOutput(snapshot));
      });
    };
    const appendWrites = createAnimationFrameTextBatcher(text => {
      if (closed || socket === undefined) return;
      if (terminalSelectionActive() || renderingSnapshot) {
        pendingRender = true;
        return;
      }
      terminal.write(text, () => {
        terminal.scrollToBottom();
        scheduleOverlayRender();
        syncScrollState();
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
    const cachedSnapshot = terminalMode ? undefined : logSnapshots.get(id);
    let outputRendered = false;
    const markRendered = () => {
      if (outputRendered) return;
      outputRendered = true;
      setHasRendered(true);
    };
    if (cachedSnapshot) { snapshot = cachedSnapshot; markRendered(); onQuestion(questionFromOutput(cachedSnapshot)); terminal.write(cachedSnapshot, () => { scheduleOverlayRender(); syncScrollState(); }); }
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
          if (snapshot !== renderedSnapshot) pendingRender = true;
          return flushSelectedOutput();
        }
        const previousTerminal = terminal;
        activeFrame = nextFrame;
        terminal = nextTerminal;
        terminalRef.current = terminal;
        scheduleOverlayRender();
        setVisibleFrame(activeFrame);
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
      if (attemptedLogConnection) setStatus('Connecting');
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
          setStatus('Live');
          scheduleViewport();
        };
        ws.onmessage = event => {
          if (closed || socket !== ws) return;
          const frame = JSON.parse(event.data) as LogFrame;
          const text = frame.text ?? '';
          if (!text) return;
          if (frame.newer !== true) historyOffset = 0;
          syncScrollState();
          const latest = historyOffset === 0;
          if (!terminalMode && latest && frame.lastPrompt !== undefined) setLastPrompt(frame.lastPrompt);
          if (!terminalMode && latest) setLatestAssistantMessage(frame.latestAssistantMessage);
          if (!terminalMode && latest) cacheLogFrame(id, frame);
          if (frame.type === 'reset') {
            if (text === snapshot) return;
            appendWrites.clear();
            snapshot = nextLiveSnapshot(snapshot, frame.type, text);
            scheduleOutputAnalysis();
            markRendered();
            if (outputSelectionPresent() || renderingSnapshot) {
              pendingRender = true;
              return;
            }
            return renderSnapshot(ws);
          }
          snapshot = nextLiveSnapshot(snapshot, frame.type, text);
          scheduleOutputAnalysis();
          markRendered();
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
          setStatus('Connecting');
          reconnect();
        };
        ws.onerror = () => ws.close();
      } catch { setStatus('Connecting'); reconnect(); }
    };
    void connect();
    return () => { closed = true; appendWrites.clear(); if (terminalInputs.get(id) === sendInput) terminalInputs.delete(id); if (exitTerminalInput.get(id) === exitInput) exitTerminalInput.delete(id); if (logHistoryRequests.get(id) === moveHistory) logHistoryRequests.delete(id); if (retry !== undefined) window.clearTimeout(retry); if (flushFrame !== undefined) window.cancelAnimationFrame(flushFrame); if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame); if (overlayFrame !== undefined) window.cancelAnimationFrame(overlayFrame); if (analysisFrame !== undefined) window.cancelAnimationFrame(analysisFrame); if (copiedSelectionTimer !== undefined) window.clearTimeout(copiedSelectionTimer); selectionSubscriptions.forEach(subscription => subscription.dispose()); inputSubscriptions.forEach(subscription => subscription.dispose()); window.removeEventListener('resize', scheduleViewport); window.visualViewport?.removeEventListener('resize', scheduleViewport); document.removeEventListener('visibilitychange', syncVisibleViewport); window.removeEventListener('pageshow', scheduleViewport); document.removeEventListener('selectionchange', syncSelectionMode); window.removeEventListener('keydown', interruptOutput, true); document.removeEventListener('keydown', copySelectionShortcut, true); document.removeEventListener('copy', nativeOutputCopied); canvas.current?.closest('.log')?.classList.remove('selection-copied'); canvas.current?.removeEventListener('pointerdown', captureSelectionMode, true); canvas.current?.removeEventListener('click', focus); releaseLongPressSelection(); releaseScrollContainment(); observer.disconnect(); socket?.close(); interactiveSocket?.close(); if (terminalRef.current === terminal) terminalRef.current = undefined; overlays.clear(); terminals.forEach(candidate => candidate.dispose()); };
  }, [id, onQuestion, terminalMode]);
  const processing = processingLabel !== undefined;
  const loading = !hasRendered || processing;
  const visibleStatus = processing ? 'Starting' : terminalMode && status === 'Live' ? 'Terminal' : status;
  const loadingLabel = processingLabel ?? (terminalMode ? 'Connecting to pane' : status === 'Live' ? 'Waiting for output' : status);
  const selectionActions = selectionToolbar === undefined ? null : createPortal(<div className="output-selection-toolbar" role="toolbar" aria-label="Output selection actions" style={{ top: selectionToolbar.top }} onPointerDown={event => event.preventDefault()}>
    <button type="button" disabled={!worktreeNotes.canCreate || selectionToolbar.text.length > 30_000} onClick={() => void worktreeNotes.createWithText(selectionToolbar.text)}>Create note</button>
    {worktreeNotes.active && <button type="button" disabled={!worktreeNotes.canAppendToActive(selectionToolbar.text)} onClick={() => worktreeNotes.appendToActive(selectionToolbar.text)}>Append to note</button>}
    <button type="button" onClick={() => setPromptDraft(id, current => appendTextBlock(current, selectionToolbar.text))}>Add to prompt</button>
    <button type="button" onClick={() => void copyOutputSelectionRef.current(selectionToolbar.text)}>Copy</button>
  </div>, document.body);
  const useHistoryEntry = (entry: PromptHistoryEntry) => {
    setPromptDraft(id, entry.text);
    setHistoryOpen(false);
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  };
  const historyPanel = historyOpen && createPortal(<section className="prompt-history-menu more-menu flyout-menu" ref={historyFlyoutRef} style={historyFlyoutStyle} aria-label="Prompt history"><header><strong>Prompt history</strong><span>{history.length}</span></header><div className="prompt-history-list" ref={historyListRef}>{history.length === 0 ? <p>No prompts have been queued for this worktree yet.</p> : [...history].reverse().map(entry => <button key={entry.id} type="button" title={entry.text} onClick={() => useHistoryEntry(entry)}><span>{entry.text}</span><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></button>)}</div></section>, document.body);
  const historyToggle = !terminalMode ? <><span className="prompt-history-anchor" ref={historyAnchorRef}><button className={`prompt-history-toggle${historyOpen ? ' active' : ''}`} type="button" aria-label={`Prompt history (${history.length})`} title="Prompt history" aria-expanded={historyOpen} onClick={event => { event.stopPropagation(); const open = !historyOpen; setHistoryOpen(open); if (open) void refreshHistory(); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M12 7v5l3 2" /></svg></button></span>{historyPanel}</> : null;
  const promptSection = !terminalMode && toolbarExpanded !== 'git' ? <div className={`toolbar-prompt-group${toolbarExpanded === 'prompt' ? ' expanded' : ''}`}>{historyToggle}{lastPrompt !== undefined && <button className={`toolbar-prompt${toolbarExpanded === 'prompt' ? ' expanded' : ''}`} type="button" aria-label="Last prompt" aria-expanded={toolbarExpanded === 'prompt'} title={lastPrompt} onClick={() => { setHistoryOpen(false); setToolbarExpanded(current => current === 'prompt' ? undefined : 'prompt'); }}><span className="toolbar-prompt-text">{lastPrompt}</span></button>}</div> : null;
  const gitSection = toolbarExpanded !== 'prompt' ? <GitStatus branch={branch} summary={gitStatus} expanded={toolbarExpanded === 'git'} onToggle={() => { setHistoryOpen(false); setToolbarExpanded(current => current === 'git' ? undefined : 'git'); }} /> : null;
  const output = <div className="log-output"><div className="log-canvas" ref={canvas} aria-label={terminalMode ? 'Interactive agent pane' : 'Live log'}><div ref={primaryHost} className={`terminal-frame ${visibleFrame === 0 ? 'active' : ''}`} /><div ref={secondaryHost} className={`terminal-frame ${visibleFrame === 1 ? 'active' : ''}`} /></div>{reviewMode && <div className="review-navigation" role="group" aria-label="Review navigation"><button type="button" onPointerDown={event => event.preventDefault()} onClick={() => terminalInputs.get(id)?.('\x1b[Z')}>Back</button><button type="button" onPointerDown={event => event.preventDefault()} onClick={() => terminalInputs.get(id)?.('\t')}>Next</button></div>}{(status !== 'Live' || processing) && <div className="log-stale-overlay" aria-hidden="true" />}{loading && <div className="log-loading" role={processing ? 'status' : undefined} aria-label={processing ? processingLabel : undefined}><span className="spinner" /><strong>{loadingLabel}</strong>{processingDetail && <span>{processingDetail}</span>}</div>}<span className={`status log-status ${visibleStatus.toLowerCase()}`}>{visibleStatus}</span><div className="log-footer">{(!terminalMode || reviewMode) && <div className="log-controls-bottom"><div className="page-controls">{cleanupControl}{worktreeNotes.control}<button className="log-control page-arrow" aria-label="Page up" title="Page up" onPointerDown={event => event.preventDefault()} onClick={() => logHistoryRequests.get(id)?.(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><div className="page-down-controls">{scrolledUp && <button className="log-control page-arrow back-to-bottom" aria-label="Back to bottom" title="Back to bottom" onPointerDown={event => event.preventDefault()} onClick={() => logHistoryRequests.get(id)?.(0)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h14M6 8l6 6 6-6" /></svg></button>}<button className="log-control page-arrow" aria-label="Page down" title="Page down" onPointerDown={event => event.preventDefault()} onClick={() => logHistoryRequests.get(id)?.(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div></div></div>}</div></div>;
  return <section className="log-shell"><div className={`log${terminalMode ? ' inline-terminal' : ''}${inputActive ? ' input-active' : ''}${selectionActive ? ' selection-active' : ''}`}><div className={`log-split${worktreeNotes.active ? ' has-note' : ''}`}>{output}{worktreeNotes.pane}</div></div>{selectionActions}<div className={`log-topbar${toolbarExpanded === undefined ? '' : ' expanded'}`}>{promptSection}{gitSection}</div></section>;
}

type MoreMenuIconName = 'actions'|'attachment'|'new-task'|'pull-request'|'push'|'review'|'swap';
function MoreMenuIcon({ name }: { name: MoreMenuIconName }) {
  if (name === 'pull-request') return <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M6 8.5v7M18 8.5v2.5a7 7 0 0 1-7 7H8.5M15.5 6H13" /></svg>;
  const paths: Record<Exclude<MoreMenuIconName, 'pull-request'>, string> = {
    actions: 'M8 5v14l11-7L8 5ZM4 5h1M4 12h1M4 19h1',
    attachment: 'm9 12 5.7-5.7a3.5 3.5 0 1 1 5 5L11 20a5 5 0 1 1-7-7l8.3-8.3',
    'new-task': 'M12 5v14M5 12h14',
    push: 'M12 16V4m0 0-5 5m5-5 5 5M5 14v5h14v-5',
    review: 'M4 5h16v14H4V5Zm4 4h8M8 13h5m4.5 1.5 1.5 1.5-3 3',
    swap: 'M5 7h13m0 0-4-4m4 4-4 4M19 17H6m0 0 4 4m-4-4 4-4'
  };
  return <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function More({ id, worktreeId, newTaskConfigured = false, pushAction = defaultPushAction, attachDisabled = false, onAttach, swapDisabled = false, onSwap, onReview, onPromptQueued, onSelectTarget, onOperationFeedback }: { id?: string; worktreeId?: string; newTaskConfigured?: boolean; pushAction?: PromptAction; attachDisabled?: boolean; onAttach?: () => void; swapDisabled?: boolean; onSwap?: () => void; onReview?: () => void; onPromptQueued?: () => void | Promise<void>; onSelectTarget: (target: DashboardTarget) => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const [menuOpen, setMenuOpen] = useState(false); const { anchorRef, flyoutRef, style } = useViewportFlyout(menuOpen);
  const [prSwitch, setPrSwitch] = useState<PullRequestSwitchAvailability>(); const [prSwitchLoaded, setPrSwitchLoaded] = useState(false); const [loadingPrSwitch, setLoadingPrSwitch] = useState(false); const [switchingPr, setSwitchingPr] = useState<number>();
  const [githubActionsUrl, setGithubActionsUrl] = useState<string>(); const [loadingGithubActions, setLoadingGithubActions] = useState(false);
  const [newTask, setNewTask] = useState<NewTaskAvailability>(); const [loadingNewTask, setLoadingNewTask] = useState(false);
  const newTaskKey = newTaskOperationKey(worktreeId ?? id ?? 'unavailable');
  const startingNewTask = usePendingOperation(newTaskKey);
  const promptPendingKey = `prompt:${id ?? 'unavailable'}`;
  const promptPending = usePendingOperation(promptPendingKey);
  useEffect(() => { if (!menuOpen) return; const close = (event: MouseEvent) => { const target = event.target as Node; if (!anchorRef.current?.contains(target) && !flyoutRef.current?.contains(target)) setMenuOpen(false); }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close); }, [menuOpen]);
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
    void request(`/api/agents/${encodeURIComponent(id)}/switch-prs`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled) return;
      if (payload !== null && typeof payload === 'object' && typeof (payload as { enabled?: unknown }).enabled === 'boolean' && Array.isArray((payload as { pullRequests?: unknown }).pullRequests)) {
        const pullRequests = (payload as { pullRequests: unknown[] }).pullRequests.filter((value): value is SwitchablePullRequest => {
          if (value === null || typeof value !== 'object' || !Number.isInteger((value as PullRequestChoice).number) || typeof (value as PullRequestChoice).title !== 'string' || typeof (value as PullRequestChoice).branch !== 'string' || typeof (value as PullRequestChoice).draft !== 'boolean' || typeof (value as PullRequestChoice).url !== 'string' || typeof (value as SwitchablePullRequest).checkedOut !== 'boolean') return false;
          const checks = (value as PullRequestChoice).checks;
          if (checks !== undefined && checks !== 'passed' && checks !== 'pending' && checks !== 'failed') return false;
          const issues = (value as PullRequestChoice).issues;
          if (issues !== undefined && (issues === null || typeof issues !== 'object' || Object.entries(issues).some(([name, enabled]) => !['mergeConflicts', 'failingChecks', 'unresolvedComments'].includes(name) || typeof enabled !== 'boolean'))) return false;
          const openIn = (value as SwitchablePullRequest).openIn;
          return openIn === undefined || (openIn !== null && typeof openIn === 'object' && typeof openIn.worktreeId === 'string' && typeof openIn.worktreeName === 'string' && (openIn.agentId === undefined || typeof openIn.agentId === 'string'));
        });
        setPrSwitch({ enabled: (payload as { enabled: boolean }).enabled, pullRequests });
      }
      setPrSwitchLoaded(true);
      setLoadingPrSwitch(false);
    }).catch(() => { if (!cancelled) { setPrSwitchLoaded(true); setLoadingPrSwitch(false); } });
    setLoadingNewTask(newTaskConfigured);
    if (!newTaskConfigured) setNewTask(undefined);
    if (newTaskConfigured) void request(`/api/agents/${encodeURIComponent(id)}/new-task`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled || payload === null || typeof payload !== 'object' || typeof (payload as { enabled?: unknown }).enabled !== 'boolean') throw new Error('invalid new task availability');
      const availability = payload as { enabled: boolean; reason?: unknown };
      setNewTask({ enabled: availability.enabled, reason: typeof availability.reason === 'string' ? availability.reason : undefined });
    }).catch(() => { if (!cancelled) setNewTask({ enabled: false, reason: 'Unable to check whether a new task can start.' }); }).finally(() => { if (!cancelled) setLoadingNewTask(false); });
    return () => { cancelled = true; };
  }, [menuOpen, id, newTaskConfigured]);
  const swapToTerminal = () => { setMenuOpen(false); onSwap?.(); };
  const startReview = () => { setMenuOpen(false); onReview?.(); };
  const attachFiles = () => { setMenuOpen(false); window.requestAnimationFrame(() => onAttach?.()); };
  const queuePush = async () => {
    if (id === undefined || promptPending || !beginPendingOperation(promptPendingKey)) return;
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: pushAction.prompt, attachments: [] }) });
      if (response.ok) { setMenuOpen(false); await onPromptQueued?.(); }
    } finally { setPendingOperation(promptPendingKey, false); }
  };
  const switchPullRequest = async (number: number) => { if (id === undefined || switchingPr !== undefined) return; setSwitchingPr(number); try { const response = await request(`/api/agents/${encodeURIComponent(id)}/switch-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number }) }); if (response.ok) setMenuOpen(false); } finally { setSwitchingPr(undefined); } };
  const clearNewTask = () => {
    if (worktreeId !== undefined && pendingNewTaskSources.get(worktreeId) === id) pendingNewTaskSources.delete(worktreeId);
    setPendingOperation(newTaskKey, false);
  };
  const startNewTask = async () => {
    if (id === undefined || startingNewTask || !newTask?.enabled || !beginPendingOperation(newTaskKey)) return;
    if (worktreeId !== undefined) pendingNewTaskSources.set(worktreeId, id);
    onOperationFeedback({ tone: 'pending', message: 'Starting a new task…', detail: 'Closing the current session and preparing a fresh agent. You can keep using other tabs.' });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/new-task`, { method: 'POST' });
      if (!response.ok) {
        clearNewTask();
        setNewTask({ enabled: false, reason: 'Unable to start a new task.' });
        onOperationFeedback({ tone: 'error', message: 'New task did not start', detail: await launchError(response) });
        return;
      }
      setMenuOpen(false);
      window.setTimeout(() => {
        if (worktreeId === undefined) return clearNewTask();
        if (pendingNewTaskSources.get(worktreeId) !== id) return;
        clearNewTask();
        onOperationFeedback({ tone: 'error', message: 'New task is taking longer than expected', detail: 'No fresh agent appeared within 30 seconds. Check the worktree status before trying again.' });
      }, 30_000);
    } catch {
      clearNewTask();
      setNewTask({ enabled: false, reason: 'Unable to start a new task.' });
      onOperationFeedback({ tone: 'error', message: 'New task did not start', detail: 'The console could not be reached. The current agent is unchanged.' });
    }
  };
  const toggleMenu = () => {
    if (!menuOpen && id !== undefined) { setLoadingPrSwitch(true); setLoadingGithubActions(true); setLoadingNewTask(newTaskConfigured); }
    setMenuOpen(open => !open);
  };
  const selectWorktree = (target: DashboardTarget) => { setMenuOpen(false); onSelectTarget(target); };
  if (id === undefined) return null;
  const pullRequestReason = loadingPrSwitch ? 'Loading pull requests…' : prSwitchLoaded && prSwitch === undefined ? 'Pull requests unavailable.' : prSwitch?.pullRequests.length === 0 ? 'No open pull requests.' : undefined;
  const newTaskReason = !newTaskConfigured ? 'Not configured for this worktree.' : newTask === undefined ? 'Checking availability…' : newTask.enabled ? 'Start a fresh task for this worktree.' : newTask.reason ?? 'New Task is currently unavailable.';
  return <><span className="more-wrap" ref={anchorRef}><button className="more icon-button" aria-label="More options" aria-expanded={menuOpen} onClick={toggleMenu}>⋮</button></span>{menuOpen && createPortal(<div className="more-menu flyout-menu pr-switch-menu" ref={flyoutRef} style={style} aria-busy={loadingPrSwitch || loadingGithubActions || loadingNewTask}><div className="pr-switch-summary"><button className="pr-switch-heading" type="button" aria-label="Pull requests" disabled>{loadingPrSwitch ? <span className="spinner" /> : <MoreMenuIcon name="pull-request" />}Pull requests</button>{pullRequestReason !== undefined && <span className="more-menu-reason" role="status" aria-label={pullRequestReason}>{pullRequestReason}</span>}</div>{prSwitch?.pullRequests.map(pullRequest => {
    const status = pullRequest.draft ? 'draft' : 'open';
    const label = `#${pullRequest.number}: ${pullRequest.title}`;
    const unavailableReason = pullRequest.checkedOut ? `Already open in ${pullRequest.openIn?.worktreeName ?? 'another worktree'}` : !prSwitch.enabled ? 'Working copy must be clean and pushed' : label;
    return <div key={pullRequest.number} className="switch-pr-option"><button className="switch-pr" disabled={loadingPrSwitch || switchingPr !== undefined || pullRequest.checkedOut || !prSwitch.enabled} title={unavailableReason} aria-label={label} onClick={() => void switchPullRequest(pullRequest.number)}>{switchingPr === pullRequest.number ? <><span className="spinner" />Switching…</> : <span className="switch-pr-copy"><strong className={`status-${status}`}>#{pullRequest.number}</strong><span>: {pullRequest.title}</span></span>}</button><span className="switch-pr-actions"><PullRequestStatusIcon status={status} className="switch-pr-status-icon" /><PullRequestIndicators checks={pullRequest.checks} issues={pullRequest.issues} /><a className="switch-pr-action switch-pr-external outline-button" href={pullRequest.url} target="_blank" rel="noreferrer" aria-label={`Open PR #${pullRequest.number} in GitHub`} title={`Open PR #${pullRequest.number} in GitHub`}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M19 14v5H5V5h5" /></svg><span>Open in GitHub</span></a>{pullRequest.openIn && <button className="switch-pr-action switch-pr-worktree outline-button" onClick={() => selectWorktree(pullRequest.openIn!)}>Switch to {pullRequest.openIn.worktreeName}</button>}</span></div>;
  })}<hr className="more-menu-divider" /><button disabled={onSwap === undefined || swapDisabled} onClick={swapToTerminal}><MoreMenuIcon name="swap" />Swap to terminal</button><button disabled={onReview === undefined || swapDisabled} onClick={startReview}><MoreMenuIcon name="review" />Review</button><button disabled={promptPending} onClick={() => void queuePush()}>{promptPending ? <span className="spinner" /> : <MoreMenuIcon name="push" />}{pushAction.label}</button><button disabled={onAttach === undefined || attachDisabled} onClick={attachFiles}><MoreMenuIcon name="attachment" />Attach files</button>{loadingGithubActions ? <button className="github-actions-loading" type="button" disabled><span className="spinner" />GitHub Actions</button> : githubActionsUrl === undefined ? <button type="button" disabled title="GitHub Actions unavailable"><MoreMenuIcon name="actions" />GitHub Actions</button> : <a className="more-menu-link" href={githubActionsUrl} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}><MoreMenuIcon name="actions" />GitHub Actions</a>}<div className="new-task-option"><button disabled={!newTaskConfigured || loadingNewTask || !newTask?.enabled || startingNewTask} onClick={() => void startNewTask()}>{loadingNewTask || startingNewTask ? <><span className="spinner" />{startingNewTask ? 'Starting New Task' : 'New Task'}</> : <><MoreMenuIcon name="new-task" />New Task</>}</button><span className="more-menu-reason" role="status">{newTaskReason}</span></div></div>, document.body)}</>;
}

function AgentCard({ agent, active, tabBar, cleanupControl, onDeleted, onSelectTarget, onPromptFocus, onOperationFeedback }: { agent: Agent; active: boolean; tabBar: ReactNode; cleanupControl?: ReactNode; onDeleted: () => Promise<void>; onSelectTarget: (target: DashboardTarget) => void; onPromptFocus: () => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const retainedReview = retainedReviewAgents.has(agent.id);
  const [paneMode, setPaneMode] = useState<'agent'|'terminal'|'review'>(retainedReview ? 'review' : 'agent');
  const terminalTransition = useRef<'agent'|'backgrounding'|'terminal'|'review'|'returning'>(retainedReview ? 'review' : 'agent');
  const mounted = useRef(true);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [question, setQuestion] = useState<ChoiceQuestion>();
  const promptHistory = usePromptHistory(agent.id);
  const startingNewTask = usePendingOperation(newTaskOperationKey(agent.worktreeId ?? agent.id));
  const cancel = async () => { if (cancelling) return; setCancelling(true); try { await request(`/api/agents/${encodeURIComponent(agent.id)}/cancel`, { method: 'POST' }); } finally { setCancelling(false); } };
  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    onOperationFeedback({ tone: 'pending', message: 'Closing scratch agent…', detail: 'The session is being stopped and removed from the console.' });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' });
      if (!response.ok) return onOperationFeedback({ tone: 'error', message: 'Scratch agent could not be closed', detail: await launchError(response) });
      retainedReviewAgents.delete(agent.id);
      await onDeleted();
      onOperationFeedback({ tone: 'success', message: 'Scratch agent closed', detail: 'The session was removed successfully.' });
    } catch { onOperationFeedback({ tone: 'error', message: 'Scratch agent could not be closed', detail: 'The console could not be reached. The agent may still be running.' }); }
    finally { setDeleting(false); }
  };
  const deactivate = async () => {
    if (deactivating || agent.worktreeId === undefined || !beginPendingOperation(deactivateOperationKey(agent.worktreeId))) return;
    setDeactivating(true);
    const label = agent.worktreeLabel ?? agentLabel(agent);
    onOperationFeedback({ tone: 'pending', message: `Turning off ${label}…`, detail: 'Stopping the agent while keeping the worktree available to start again.' });
    try {
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/deactivate`, { method: 'POST' });
      if (!response.ok) return onOperationFeedback({ tone: 'error', message: `${label} could not be turned off`, detail: await launchError(response) });
      retainedReviewAgents.delete(agent.id);
      await onDeleted();
      onOperationFeedback({ tone: 'success', message: `${label} is off`, detail: 'The worktree is still available. Use Launch agent whenever you want to turn it back on.' });
    } catch { onOperationFeedback({ tone: 'error', message: `${label} could not be turned off`, detail: 'The console could not be reached. The agent may still be running.' }); }
    finally {
      setPendingOperation(deactivateOperationKey(agent.worktreeId), false);
      setDeactivating(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const mode = terminalTransition.current;
      if (mode === 'review' && retainedReviewAgents.has(agent.id)) return;
      if (mode !== 'terminal' && mode !== 'review') return;
      terminalTransition.current = 'returning';
      const endpoint = mode === 'review' ? 'review/close' : 'foreground';
      void request(`/api/agents/${encodeURIComponent(agent.id)}/${endpoint}`, { method: 'POST' }).catch(() => undefined).finally(() => { terminalTransition.current = 'agent'; });
    };
  }, [agent.id]);
  const changePaneMode = async (nextMode: 'agent'|'terminal'|'review') => {
    if (swapping) return;
    setSwapping(true);
    try {
      if (paneMode !== 'agent') {
        terminalTransition.current = 'returning';
        const endpoint = paneMode === 'review' ? 'review/close' : 'foreground';
        const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/${endpoint}`, { method: 'POST' });
        if (response.ok) {
          retainedReviewAgents.delete(agent.id);
          terminalTransition.current = 'agent';
          if (mounted.current) setPaneMode('agent');
        } else {
          terminalTransition.current = paneMode;
        }
        return;
      }
      if (nextMode === 'agent') return;
      terminalTransition.current = 'backgrounding';
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/${nextMode === 'review' ? 'review' : 'background'}`, { method: 'POST' });
      if (!response.ok) {
        terminalTransition.current = 'agent';
        return;
      }
      if (!mounted.current) {
        if (nextMode === 'review') {
          retainedReviewAgents.add(agent.id);
          terminalTransition.current = 'review';
          return;
        }
        terminalTransition.current = 'returning';
        await request(`/api/agents/${encodeURIComponent(agent.id)}/foreground`, { method: 'POST' });
        terminalTransition.current = 'agent';
        return;
      }
      if (nextMode === 'review') retainedReviewAgents.add(agent.id);
      terminalTransition.current = nextMode;
      setPaneMode(nextMode);
    } catch {
      terminalTransition.current = paneMode;
    } finally {
      if (mounted.current) setSwapping(false);
    }
  };
  const swapped = paneMode !== 'agent';
  const reviewing = paneMode === 'review';
  const omxQuestion = agent.question === undefined ? undefined : { text: agent.question.text, choices: agent.question.choices, omxId: agent.question.id };
  return <article className="agent-view"><Log id={agent.id} worktreeId={agent.worktreeId} branch={agent.branch} gitStatus={agent.gitStatus} history={promptHistory.history} refreshHistory={promptHistory.refresh} onQuestion={setQuestion} cleanupControl={cleanupControl} terminalMode={swapped} reviewMode={reviewing} processingLabel={startingNewTask ? 'Starting new task…' : undefined} processingDetail={startingNewTask ? 'Closing this session and preparing a fresh agent. This can take a few seconds.' : undefined} />{tabBar}<PullRequestCard pullRequest={agent.pullRequest} onFixup={agent.pullRequest === undefined ? undefined : async () => { const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '$fixup', attachments: [] }) }); if (response.ok) await promptHistory.refresh(); return response.ok; }} /><Prompt id={agent.id} history={promptHistory.history} onHistoryChanged={promptHistory.refresh} canCancel={active} cancelling={cancelling} deleting={deleting} deactivating={deactivating} swapping={swapping} swapped={swapped} reviewing={reviewing} onCancel={() => void cancel()} onDelete={!active && agent.worktreeId === undefined ? () => void remove() : undefined} onDeactivate={!active && agent.worktreeId !== undefined ? () => void deactivate() : undefined} onSwap={() => void changePaneMode('terminal')} onReview={() => void changePaneMode('review')} onSelectTarget={onSelectTarget} onPromptFocus={onPromptFocus} onOperationFeedback={onOperationFeedback} projectUrl={agent.projectUrl} question={omxQuestion ?? question} worktreeId={agent.worktreeId} newTaskConfigured={agent.newTaskConfigured} pushAction={agent.push} stack={agent.stack} /></article>;
}

function launchError(response: Response): Promise<string> {
  return response.json().then((body: { error?: unknown }) => typeof body.error === 'string' ? body.error : `Launch failed (${response.status}).`).catch(() => `Launch failed (${response.status}).`);
}

function WorktreeCard({ worktree, tabBar, cleanupControl, onLaunched, onOperationFeedback }: { worktree: Worktree; tabBar: ReactNode; cleanupControl?: ReactNode; onLaunched: (agentId: string, sourceItemKey: string) => void; onOperationFeedback: (feedback: Omit<OperationFeedback, 'id'>) => void }) {
  const launchKey = launchOperationKey(worktree.id);
  const launching = usePendingOperation(launchKey);
  const startingNewTask = usePendingOperation(newTaskOperationKey(worktree.id));
  const processing = launching || startingNewTask;
  const worktreeNotes = useWorktreeNotes(worktree.id);
  const [gitExpanded, setGitExpanded] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 5_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const launch = async () => {
    if (!worktree.available || processing || !beginPendingOperation(launchKey)) return;
    setError('');
    onOperationFeedback({ tone: 'pending', message: `Starting ${worktree.label}…`, detail: 'Launching Codex and waiting for the agent session to become ready.' });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, { method: 'POST' });
      if (!response.ok) {
        const message = await launchError(response);
        setError(message);
        return onOperationFeedback({ tone: 'error', message: `${worktree.label} could not start`, detail: message });
      }
      const payload = await response.json() as { agentId?: unknown };
      if (typeof payload.agentId !== 'string') {
        const message = 'The agent started but could not be opened.';
        setError(message);
        return onOperationFeedback({ tone: 'error', message: `${worktree.label} could not be opened`, detail: message });
      }
      onLaunched(payload.agentId, `worktree-${worktree.id}`);
      onOperationFeedback({ tone: 'success', message: `${worktree.label} is starting`, detail: 'The new agent session is ready and its output is connecting.' });
    } catch {
      const message = 'Unable to reach the console while launching the agent.';
      setError(message);
      onOperationFeedback({ tone: 'error', message: `${worktree.label} could not start`, detail: message });
    }
    finally { setPendingOperation(launchKey, false); }
  };
  const output = <div className="log-output"><div className="log-loading inactive" role={processing ? 'status' : undefined} aria-label={startingNewTask ? 'Starting new task' : launching ? `Starting ${worktree.label}` : undefined}>{processing ? <span className="spinner" /> : null}<strong>{startingNewTask ? 'Starting new task…' : launching ? 'Starting Codex…' : 'Agent is off'}</strong><span>{startingNewTask ? 'Waiting for the fresh agent session to become ready.' : launching ? 'Creating the agent session and connecting its output.' : 'This worktree is available. Launch an agent when you are ready to continue.'}</span></div><span className={`status log-status ${processing ? 'connecting' : 'inactive'}`}>{processing ? 'Starting' : 'Off'}</span><div className="log-footer"><div className="log-controls-bottom"><div className="page-controls">{cleanupControl}{worktreeNotes.control}<button className="log-control page-arrow" aria-label="Page up" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button className="log-control page-arrow" aria-label="Page down" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div></div></div></div>;
  return <article className="agent-view"><section className="log-shell"><div className="log inactive-log"><div className={`log-split${worktreeNotes.active ? ' has-note' : ''}`}>{output}{worktreeNotes.pane}</div></div><div className={`log-topbar${gitExpanded ? ' expanded' : ''}`}><GitStatus branch={worktree.branch} summary={worktree.gitStatus} expanded={gitExpanded} onToggle={() => setGitExpanded(value => !value)} /></div></section>{tabBar}<PullRequestCard pullRequest={worktree.pullRequest} /><section className="prompt"><textarea aria-label="Prompt" disabled />{error && <p className="launch-error" role="alert">{error}</p>}<div className="prompt-actions"><span className="prompt-actions-spacer" aria-hidden="true" /><ProjectOpen url={worktree.projectUrl} stack={worktree.stack} onStackAction={action => request(`/api/worktrees/${encodeURIComponent(worktree.id)}/commands/${action}`, { method: 'POST' })} /><button className="queue" disabled={!worktree.available || processing} onClick={() => void launch()}>{startingNewTask ? <><span className="spinner" />Starting new task</> : launching ? <><span className="spinner" />Launching</> : 'Launch agent'}</button></div></section></article>;
}

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
    if (next === 'granted') { await syncSubscription(); await showNotification('system', 'Alerts enabled', 'You will be notified when an agent is ready.', 'rac-alerts-enabled'); }
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

function DashboardView({ onUnauthorized, onInactive, updateAvailable, onReload }: { onUnauthorized: () => void; onInactive: () => void; updateAvailable: boolean; onReload: () => void }) {
  const [data, setData] = useState<Dashboard>();
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
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupTargets, setCleanupTargets] = useState<CleanupTarget[]>([]);
  const [cleanupChecked, setCleanupChecked] = useState<Set<string>>(() => new Set());
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupError, setCleanupError] = useState('');
  const cleanupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousCleanupCount = useRef(0);
  const tabInitialized = useRef(false);
  const refreshInFlight = useRef(false);
  const dashboardPushFreshUntil = useRef(0);
  const dashboardPushSynchronized = useRef(false);
  const dashboardContent = useRef('');
  const selectedItemKey = useRef<string | undefined>(undefined);
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
  useEffect(() => {
    if (!launcherOpen) return;
    const close = (event: MouseEvent) => { const target = event.target as Node; if (!launcherRef.current?.contains(target) && !launcherMenuRef.current?.contains(target)) setLauncherOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [launcherOpen]);
  const agentStates = useRef(new Map<string, AgentState>());
  const pendingCompletions = useRef(new Map<string, { due: number; timer: number }>());
  const applyDashboard = useCallback((payload: Dashboard) => {
    const activeAgentIds = new Set(payload.agents.map(agent => agent.id));
    logSnapshots.retain(activeAgentIds);
    for (const id of lastPrompts.keys()) if (!activeAgentIds.has(id)) lastPrompts.delete(id);
    for (const id of latestAssistantMessages.keys()) if (!activeAgentIds.has(id)) latestAssistantMessages.delete(id);
    for (const id of promptDrafts.keys()) if (!activeAgentIds.has(id)) promptDrafts.delete(id);
    const activeWorktreeIds = new Set(payload.worktrees.map(worktree => worktree.id));
    for (const [worktreeId, sourceAgentId] of pendingNewTaskSources) {
      const replacement = payload.agents.find(agent => agent.worktreeId === worktreeId && agent.id !== sourceAgentId);
      if (replacement === undefined && activeWorktreeIds.has(worktreeId)) continue;
      pendingNewTaskSources.delete(worktreeId);
      setPendingOperation(newTaskOperationKey(worktreeId), false);
      if (replacement !== undefined) showOperationFeedback({ tone: 'success', message: 'New task is ready', detail: `${replacement.worktreeLabel ?? agentLabel(replacement)} is ready for a fresh prompt.` });
    }
    const content = JSON.stringify([payload.agents, payload.worktrees, payload.cleanupPending ?? 0]);
    if (content !== dashboardContent.current || pendingCompletions.current.size > 0) {
      dashboardContent.current = content;
      setData(payload);
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
      observed.add(agent.id);
      const pendingCompletion = pendingCompletions.current.get(agent.id);
      if (state !== 'prompt-done' && pendingCompletion !== undefined) {
        window.clearTimeout(pendingCompletion.timer);
        pendingCompletions.current.delete(agent.id);
      }
      if (previous !== undefined && previous !== 'action-required' && state === 'action-required') {
        const body = agent.question === undefined ? `${label} is waiting for your response.` : `${label}: ${agent.question.text}`;
        if (focused) dismissAgentNotifications(agent);
        else void showNotification('question', 'Agent has a question', body, tag, `/#agent=${encodeURIComponent(agent.id)}`, agent.worktreeId);
      }
      if (previous === 'working' && state === 'prompt-done') {
        const delay = 2_000;
        const timer = window.setTimeout(() => void refresh(), delay);
        pendingCompletions.current.set(agent.id, { due: Date.now() + delay, timer });
      } else if (state === 'prompt-done' && pendingCompletion !== undefined && Date.now() >= pendingCompletion.due) {
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
    ...data.agents.map(agent => {
      const scope = agent.worktreeId ?? agent.id;
      const operation = pendingOperations.has(newTaskOperationKey(scope)) ? 'new-task' as const : pendingOperations.has(deactivateOperationKey(scope)) ? 'deactivating' as const : undefined;
      return { key: `agent-${agent.id}`, label: agentLabel(agent), state: agentState(agent), order: agent.worktreeOrder ?? Number.MAX_SAFE_INTEGER, unread: agent.unread === true, operation, agent };
    }),
    ...data.worktrees.filter(worktree => worktree.pinned).map(worktree => {
      const operation = pendingOperations.has(newTaskOperationKey(worktree.id)) ? 'new-task' as const : pendingOperations.has(launchOperationKey(worktree.id)) ? 'launching' as const : undefined;
      return { key: `worktree-${worktree.id}`, label: worktree.label, state: 'closed' as const, order: worktree.order, unread: false, operation, worktree };
    })
  ].sort((left, right) => left.order - right.order);
  const activeItemKey = items[active]?.key;
  selectedItemKey.current = activeItemKey;
  useEffect(() => { setActive(current => Math.min(current, Math.max(items.length - 1, 0))); }, [items.length]);
  const tabKey = items.map(item => item.label).join('\u0000');
  useEffect(() => {
    if (tabInitialized.current || items.length === 0) return;
    const hash = location.hash;
    const encoded = hash.startsWith('#agent=') ? hash.slice(7) : hash.startsWith('#tab=') ? hash.slice(5) : '';
    let target = '';
    try { target = decodeURIComponent(encoded); } catch { /* use the current tab */ }
    const linked = hash.startsWith('#agent=') ? items.findIndex(item => item.agent?.id === target) : items.findIndex(item => item.label === target);
    if (linked >= 0) setActive(linked);
    tabInitialized.current = true;
  }, [tabKey]);
  const select = (index: number) => { const item = items[index]; if (!item) return; const changed = selectedItemKey.current !== item.key; selectedItemKey.current = item.key; if (changed && item.agent !== undefined) viewAgent(item.agent); const target = item.agent === undefined ? `tab=${encodeURIComponent(item.label)}` : `agent=${encodeURIComponent(item.agent.id)}`; history.replaceState(null, '', `${location.pathname}${location.search}#${target}`); setActive(index); };
  useShiftArrowTabCycling(active, items.length, select);
  useEffect(() => {
    if (activateAgentId === undefined) return;
    const index = items.findIndex(candidate => candidate.agent?.id === activateAgentId);
    if (index < 0) return;
    select(index);
    setActivateAgentId(undefined);
  }, [activateAgentId, tabKey]);
  const launched = (agentId: string, sourceItemKey?: string) => {
    setLaunchErrorMessage('');
    if (sourceItemKey === undefined || selectedItemKey.current === sourceItemKey) setActivateAgentId(agentId);
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
  const launchWorktree = async (worktree: Worktree) => {
    const key = launchOperationKey(worktree.id);
    if (creatingAgent || !beginPendingOperation(key)) return;
    setLauncherOpen(false);
    setCreatingAgent(true);
    setLaunchErrorMessage('');
    showOperationFeedback({ tone: 'pending', message: `Starting ${worktree.label}…`, detail: 'Launching Codex and waiting for the agent session to become ready.' });
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, { method: 'POST' });
      if (!response.ok) {
        const message = await launchError(response);
        setLaunchErrorMessage(message);
        return showOperationFeedback({ tone: 'error', message: `${worktree.label} could not start`, detail: message });
      }
      const payload = await response.json() as { agentId?: unknown };
      if (typeof payload.agentId !== 'string') {
        const message = 'The agent started but could not be opened.';
        setLaunchErrorMessage(message);
        return showOperationFeedback({ tone: 'error', message: `${worktree.label} could not be opened`, detail: message });
      }
      launched(payload.agentId);
      showOperationFeedback({ tone: 'success', message: `${worktree.label} started`, detail: 'The new agent session is ready and its output is connecting.' });
    } catch {
      const message = 'Unable to reach the console while launching the agent.';
      setLaunchErrorMessage(message);
      showOperationFeedback({ tone: 'error', message: `${worktree.label} could not start`, detail: message });
    } finally {
      setPendingOperation(key, false);
      setCreatingAgent(false);
    }
  };
  const selectTarget = (target: DashboardTarget) => {
    const index = items.findIndex(candidate => (target.agentId !== undefined && candidate.agent?.id === target.agentId) || candidate.agent?.worktreeId === target.worktreeId || candidate.worktree?.id === target.worktreeId);
    if (index >= 0) return select(index);
    const worktree = data?.worktrees.find(candidate => candidate.id === target.worktreeId);
    if (worktree !== undefined) void launchWorktree(worktree);
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
  const stateLabel: Record<AgentState, string> = { working: 'Working', 'prompt-done': 'Prompt done', 'action-required': 'Action required', closed: 'Agent closed' };
  const operationLabel = (operation: DashboardItem['operation']) => operation === 'launching' ? 'Starting agent' : operation === 'deactivating' ? 'Turning off' : operation === 'new-task' ? 'Starting new task' : undefined;
  const tabBar = <><nav className="tabs" ref={tabsRef} role="tablist" aria-label="Agents and worktrees">{items.map((entry, index) => {
    const transition = operationLabel(entry.operation);
    const label = transition ?? stateLabel[entry.state];
    return <button key={entry.key} id={`tab-${index}`} role="tab" aria-selected={index === active} aria-controls={`panel-${index}`} tabIndex={index === active ? 0 : -1} className={`${index === active ? 'active ' : ''}${transition === undefined ? `status-${entry.state}` : 'status-transitioning'}${entry.unread ? ' unread' : ''}`} title={`${label}${entry.unread ? ' — Unread' : ''}`} aria-label={`${entry.label} — ${label}${entry.unread ? ' — Unread' : ''}`} aria-busy={transition !== undefined} onClick={() => select(index)}>{transition !== undefined ? <span className="tab-transition-label"><span>{entry.label}</span><small>{transition}…</small></span> : entry.state === 'working' ? <span className="tab-label" aria-hidden="true">{entry.label}</span> : entry.label}</button>;
  })}<NotificationControl />{updateAvailable && <button className="update-ready" type="button" onClick={onReload}>Update available <span>Reload</span></button>}<span className="launcher" ref={launcherRef}><button ref={plusRef} className="new-agent-tab" type="button" disabled={creatingAgent} aria-label={creatingAgent ? 'Starting agent' : 'Launch agent'} aria-expanded={launcherOpen} onClick={() => setLauncherOpen(value => !value)}>{creatingAgent ? <span className="spinner" /> : '+'}</button></span>{launcherOpen && createPortal(<div className="launcher-menu more-menu flyout-menu" ref={launcherMenuRef} style={launcherStyle}><button disabled={creatingAgent} onClick={() => void createAgent()}>~ Scratch</button>{data.worktrees.map(worktree => <button key={worktree.id} disabled={creatingAgent || pendingOperations.has(launchOperationKey(worktree.id))} onClick={() => void launchWorktree(worktree)}>{worktree.label}</button>)}</div>, document.body)}{plusAlone && <span className="tab-spacer" aria-hidden="true" />}</nav>{operationFeedback && <OperationFeedbackBanner feedback={operationFeedback} onDismiss={() => setOperationFeedback(undefined)} />}{launchErrorMessage && operationFeedback?.tone !== 'error' && <p className="launch-error launch-error-global" role="alert">{launchErrorMessage}</p>}</>;
  if (items.length === 0) return <main className="console"><article className="worktree-view cleanup-empty-view">{tabBar}<h2>No sessions</h2>{cleanupCount > 0 && <div className="page-controls cleanup-standalone">{cleanupControl}</div>}{cleanupDialog}</article></main>;
  return <main className="console"><section className="panel" role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} tabIndex={0}>{item?.agent && <AgentCard key={item.agent.id} agent={item.agent} active={item.state === 'working'} tabBar={tabBar} cleanupControl={cleanupControl} onDeleted={refresh} onSelectTarget={selectTarget} onPromptFocus={() => viewAgent(item.agent!)} onOperationFeedback={showOperationFeedback} />}{item?.worktree && <WorktreeCard key={item.worktree.id} worktree={item.worktree} tabBar={tabBar} cleanupControl={cleanupControl} onLaunched={launched} onOperationFeedback={showOperationFeedback} />}</section>{cleanupDialog}</main>;
}

function App() {
  const [state, setState] = useState<'checking' | 'login' | 'naming' | 'ready' | 'inactive'>('checking');
  const [sessionInfo, setSessionInfo] = useState<SessionInfo>();
  const [error, setError] = useState('');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reconnecting, setReconnecting] = useState(!consoleReachable);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const applySession = useCallback((current: SessionInfo) => {
    csrf = current.csrfToken;
    setSessionInfo(current);
    setState(current.active ? current.deviceName === undefined ? 'naming' : 'ready' : 'inactive');
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
        if (typeof payload.version === 'string' && payload.version !== currentUiVersion) setUpdateAvailable(true);
      } catch { /* Retry at the next interval. */ }
    };
    const stopPolling = pollWhileVisible(checkForUpdate, 30_000, false);
    return () => { closed = true; stopPolling(); };
  }, []);
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
        csrf = (await bootstrap.json()).csrfToken;
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
  const reload = () => {
    if (reloading) return;
    setReloading(true);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => location.reload()));
  };
  const screen = reloading
    ? <LoadingScreen label="Reloading" />
    : state === 'checking'
      ? <LoadingScreen />
      : state === 'ready'
        ? <DashboardView onUnauthorized={() => { setSessionInfo(undefined); setState('login'); }} onInactive={() => { setState('checking'); void refreshSession(); }} updateAvailable={updateAvailable} onReload={reload} />
        : (state === 'inactive' || state === 'naming') && sessionInfo !== undefined
          ? <ControlScreen session={sessionInfo} claimed={applySession} />
          : <Login initialError={error} done={applySession} />;
  return <>{screen}{reconnecting && <ReconnectingOverlay />}</>;
}
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
createRoot(document.getElementById('root')!).render(<ConsoleBoundary><App /></ConsoleBoundary>);
