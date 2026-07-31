import { Component, type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createOutputLinkOverlays } from './output-links.js';
import { containOutputScroll } from './output-scroll.js';
import { preserveOutputLongPressSelection } from './output-touch.js';
import { ProjectOpen } from './project-open.js';
import { PullRequestCard, PullRequestStatusIcon, type PullRequestSummary } from './pull-request-card.js';
import { type StackAction } from './stack-operations.js';
import { useShiftArrowTabCycling } from './tab-navigation.js';
import { useViewportFlyout } from './viewport-flyout.js';
import './styles.css';

type OmxQuestion = { id: string; text: string; choices: string[]; paneId: string };
type Stack = { actions: StackAction[]; running?: boolean; transition?: 'starting'|'migrating'; operation?: StackAction; tunnel?: boolean };
type PullRequestChoice = { number: number; title: string; branch: string; draft: boolean; url: string };
type PullRequestWorktree = { worktreeId: string; worktreeName: string; agentId?: string };
type SwitchablePullRequest = PullRequestChoice & { checkedOut: boolean; openIn?: PullRequestWorktree };
type PullRequestSwitchAvailability = { enabled: boolean; pullRequests: SwitchablePullRequest[] };
type DashboardTarget = { worktreeId: string; agentId?: string };
type NewTaskAvailability = { enabled: boolean; reason?: string };
type Agent = { id: string; sessionId: string; workspace: string; branch?: string; title: string; displayLabel?: string; worktreeId?: string; worktreeLabel?: string; worktreeOrder?: number; newTaskConfigured?: boolean; projectUrl?: string; pullRequest?: PullRequestSummary; question?: OmxQuestion; stack?: Stack };
type Worktree = { id: string; label: string; path: string; available: boolean; pinned: boolean; order: number; projectUrl?: string; pullRequest?: PullRequestSummary; stack?: Stack };
type Dashboard = { generation?: number; agents: Agent[]; worktrees: Worktree[] };
const isDashboard = (value: unknown): value is Dashboard => {
  if (value === null || typeof value !== 'object') return false;
  const dashboard = value as { agents?: unknown; worktrees?: unknown };
  return Array.isArray(dashboard.agents) && Array.isArray(dashboard.worktrees);
};
type AgentState = 'working' | 'prompt-done' | 'action-required' | 'closed';
type DashboardItem = { key: string; label: string; state: AgentState; order: number; agent?: Agent; worktree?: Worktree };
type LogFrame = { type: 'append' | 'reset'; text?: string; older?: boolean; newer?: boolean; lastPrompt?: string };
type ChoiceQuestion = { text: string; choices: string[]; omxId?: string };
type SavedPrompt = { id: string; text: string };
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
const promptCommands = [...skillCommands, ...slashCommands];
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
type SpeechRecognitionInstance = { continuous: boolean; interimResults: boolean; lang: string; start: () => void; abort: () => void; onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechRecognitionResult> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

const logSnapshots = new Map<string, string>();
const lastPrompts = new Map<string, string>();
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
const pendingOperations = new Set<string>();
const pendingOperationListeners = new Map<string, Set<() => void>>();
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
  logSnapshots.set(id, frame.type === 'reset' ? text : `${logSnapshots.get(id) ?? ''}${text}`);
  if (frame.lastPrompt !== undefined) lastPrompts.set(id, frame.lastPrompt);
  else if (frame.type === 'reset') cachedLastPrompt(id, text);
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

const lastPromptFromOutput = (output: string): string | undefined => {
  const lines = output.slice(-32_768).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^›\s+(.+)$/.exec(lines[index]!);
    if (!match) continue;
    const prompt = [match[1]];
    let continuation = index + 1;
    while (continuation < lines.length && /^ {2}\S/.test(lines[continuation]!)) prompt.push(lines[continuation++]!.trim());
    while (continuation < lines.length && lines[continuation] === '') continuation += 1;
    if (/^•\s/.test(lines[continuation] ?? '')) return prompt.join(' ');
  }
  return undefined;
};

const cachedLastPrompt = (id: string, output: string) => {
  const prompt = lastPromptFromOutput(output);
  if (prompt !== undefined) lastPrompts.set(id, prompt);
  return lastPrompts.get(id);
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
const request = async (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  try {
    return await consoleFetch(url, { ...init, credentials: 'same-origin', headers });
  } catch {
    return new Response(JSON.stringify({ error: 'Console unavailable' }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'content-type': 'application/json' }
    });
  }
};
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

function Prompt({ id, canCancel, cancelling, deleting, deactivating, swapping, swapped, onCancel, onDelete, onDeactivate, onSwap, onSelectTarget, projectUrl, question, worktreeId, newTaskConfigured, stack }: { id: string; canCancel: boolean; cancelling: boolean; deleting: boolean; deactivating: boolean; swapping: boolean; swapped: boolean; onCancel: () => void; onDelete?: () => void; onDeactivate?: () => void; onSwap: () => void; onSelectTarget: (target: DashboardTarget) => void; projectUrl?: string; question?: ChoiceQuestion; worktreeId?: string; newTaskConfigured?: boolean; stack?: Stack }) {
  const [value, setValue] = usePromptDraft(id);
  const [commandToken, setCommandToken] = useState<CommandToken>();
  const [activeCommand, setActiveCommand] = useState(0);
  const pendingKey = `prompt:${id}`;
  const pending = usePendingOperation(pendingKey);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [savedPromptsOpen, setSavedPromptsOpen] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [savedConfirmation, setSavedConfirmation] = useState(false);
  const [consumingSavedPrompt, setConsumingSavedPrompt] = useState<string>();
  const [savedPromptError, setSavedPromptError] = useState<string>();
  const savedConfirmationTimer = useRef<number | undefined>(undefined);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const promptInput = useRef<HTMLTextAreaElement | null>(null);
  const focusPromptAtEnd = useRef(false);
  const savedPromptGroupRef = useRef<HTMLSpanElement | null>(null);
  const { anchorRef: savedPromptAnchorRef, flyoutRef: savedPromptFlyoutRef, style: savedPromptFlyoutStyle } = useViewportFlyout(savedPromptsOpen);
  const commandOptions = commandToken === undefined ? [] : promptCommands.filter(command => command.value.startsWith(commandToken.prefix) && command.value.slice(1).toLocaleLowerCase().includes(commandToken.query.toLocaleLowerCase()));
  useEffect(() => {
    let cancelled = false;
    void request(`/api/agents/${encodeURIComponent(id)}/saved-prompts`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled || payload === null || typeof payload !== 'object' || !Array.isArray((payload as { prompts?: unknown }).prompts)) return;
      setSavedPrompts((payload as { prompts: unknown[] }).prompts.filter((prompt): prompt is SavedPrompt => prompt !== null && typeof prompt === 'object' && typeof (prompt as SavedPrompt).id === 'string' && typeof (prompt as SavedPrompt).text === 'string'));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [id]);
  useEffect(() => () => {
    if (savedConfirmationTimer.current !== undefined) window.clearTimeout(savedConfirmationTimer.current);
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
  useLayoutEffect(() => {
    if (!focusPromptAtEnd.current) return;
    focusPromptAtEnd.current = false;
    const input = promptInput.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [value]);
  const [listening, setListening] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  const recognition = useRef<SpeechRecognitionInstance | undefined>(undefined);
  const speechPrefix = useRef('');
  const speechSegments = useRef(new Map<number, string>());
  const speechWindow = window as Window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
  const supportsSpeechRecognition = speechWindow.SpeechRecognition !== undefined || speechWindow.webkitSpeechRecognition !== undefined;
  useEffect(() => () => recognition.current?.abort(), []);
  useEffect(() => { mobileModifiers.set(id, { alt: altActive, ctrl: ctrlActive, shift: shiftActive }); return () => { mobileModifiers.delete(id); }; }, [id, altActive, ctrlActive, shiftActive]);
  const chooseAttachments = (files: FileList | null) => {
    if (!files) return;
    const next = [...attachments, ...Array.from(files)];
    if (next.length > maxAttachments) return setAttachmentError(`Attach up to ${maxAttachments} files.`);
    if (next.reduce((total, file) => total + file.size, 0) > maxAttachmentBytes) return setAttachmentError(`Attachments must total ${maxAttachmentMegabytes} MB or less.`);
    setAttachmentError(undefined);
    setAttachments(next);
  };
  const submit = async () => {
    if (pending || (!swapped && !value && attachments.length === 0)) return;
    recognition.current?.abort();
    recognition.current = undefined;
    setListening(false);
    if (swapped) {
      const sendTerminalInput = terminalInputs.get(id);
      if (sendTerminalInput === undefined) return;
      sendTerminalInput(`${value}\r`);
      setValue('');
      return;
    }
    if (!beginPendingOperation(pendingKey)) return;
    setAttachmentError(undefined);
    try {
      const payload = await Promise.all(attachments.map(encodeAttachment));
      const response = await request(`/api/agents/${encodeURIComponent(id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: value, attachments: payload }) });
      if (response.ok) { setValue(''); setAttachments([]); }
      else setAttachmentError('Unable to queue the prompt with these attachments.');
    } catch { setAttachmentError('Unable to read the selected attachments.'); }
    finally { setPendingOperation(pendingKey, false); }
  };
  const saveCurrentPrompt = async () => {
    if (pending || savingPrompt || !value.trim()) return;
    recognition.current?.abort();
    recognition.current = undefined;
    setListening(false);
    setSavingPrompt(true);
    setSavedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/saved-prompts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: value }) });
      if (!response.ok) throw new Error();
      const saved = await response.json() as SavedPrompt;
      if (typeof saved.id !== 'string' || typeof saved.text !== 'string') throw new Error();
      setSavedPrompts(current => [saved, ...current]);
      setValue('');
      setCommandToken(undefined);
      setSavedConfirmation(true);
      if (savedConfirmationTimer.current !== undefined) window.clearTimeout(savedConfirmationTimer.current);
      savedConfirmationTimer.current = window.setTimeout(() => {
        savedConfirmationTimer.current = undefined;
        setSavedConfirmation(false);
      }, 1_600);
    } catch {
      setSavedPromptError('Unable to save this prompt.');
    } finally {
      setSavingPrompt(false);
    }
  };
  const useSavedPrompt = async (saved: SavedPrompt) => {
    if (pending || consumingSavedPrompt !== undefined) return;
    setConsumingSavedPrompt(saved.id);
    setSavedPromptError(undefined);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/saved-prompts/${encodeURIComponent(saved.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      const consumed = await response.json() as SavedPrompt;
      if (typeof consumed.id !== 'string' || typeof consumed.text !== 'string') throw new Error();
      setSavedPrompts(current => current.filter(prompt => prompt.id !== consumed.id));
      setSavedPromptsOpen(current => savedPrompts.length > 1 && current);
      focusPromptAtEnd.current = true;
      setValue(current => current ? `${current}${/\s$/u.test(current) ? '' : '\n\n'}${consumed.text}` : consumed.text);
    } catch {
      setSavedPromptError('Unable to restore this saved prompt.');
    } finally {
      setConsumingSavedPrompt(undefined);
    }
  };
  const answer = async (index: number) => { if (pending || !beginPendingOperation(pendingKey)) return; try { const url = question?.omxId === undefined ? `/api/agents/${encodeURIComponent(id)}/question` : `/api/agents/${encodeURIComponent(id)}/omx-question`; const body = question?.omxId === undefined ? { index } : { index, questionId: question.omxId }; await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } finally { setPendingOperation(pendingKey, false); } };
  const voice = () => {
    if (pending || !supportsSpeechRecognition) return;
    // Set the ref synchronously, not just React state, so a second tap cannot
    // start a parallel recognizer before the component rerenders.
    if (listening || recognition.current !== undefined) {
      recognition.current?.abort();
      recognition.current = undefined;
      setListening(false);
      return;
    }
    const Recognition = (speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition)!;
    const next = new Recognition();
    recognition.current = next;
    next.continuous = true;
    next.interimResults = true;
    next.lang = navigator.language;
    speechPrefix.current = value;
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
      setValue(`${speechPrefix.current}${speechPrefix.current && !/\s$/u.test(speechPrefix.current) ? ' ' : ''}${transcript}`);
    };
    // Keep mic mode armed after a natural recognition end. It is dismissed
    // only by pressing the mic again or by queueing the prompt.
    next.onend = () => { recognition.current = undefined; };
    next.onerror = () => { recognition.current = undefined; };
    setListening(true);
    next.start();
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
  const swapLabel = swapped ? 'Return to agent output' : 'Swap to terminal';
  const swap = <button className={`swap-agent icon-button${swapped ? ' active' : ''}`} disabled={swapping} aria-label={swapLabel} title={swapped ? 'Return to agent output' : 'Background agent and show terminal'} onClick={onSwap}>{swapping ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h13m0 0-4-4m4 4-4 4M19 17H6m0 0 4 4m-4-4 4-4" /></svg>}</button>;
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
  const composer = <div className="prompt-composer"><textarea ref={promptInput} aria-label="Prompt" aria-autocomplete="list" aria-expanded={commandToken !== undefined} aria-controls={commandToken === undefined ? undefined : `prompt-commands-${id}`} aria-activedescendant={commandOptions[activeCommand] === undefined ? undefined : `prompt-command-${id}-${activeCommand}`} value={value} disabled={pending} onFocus={() => exitTerminalInput.get(id)?.()} onBlur={() => setCommandToken(undefined)} onKeyDown={event => { if (commandOptions.length > 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.key === 'ArrowDown') { event.preventDefault(); setActiveCommand(current => (current + 1) % commandOptions.length); } else if (commandOptions.length > 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.key === 'ArrowUp') { event.preventDefault(); setActiveCommand(current => (current + commandOptions.length - 1) % commandOptions.length); } else if (commandOptions.length > 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.key === 'Enter') { event.preventDefault(); selectCommand(commandOptions[activeCommand] ?? commandOptions[0]!); } else if (event.key === 'Escape' && commandToken !== undefined) { event.preventDefault(); setCommandToken(undefined); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { if (event.currentTarget.selectionStart === event.currentTarget.selectionEnd) { event.preventDefault(); setValue(''); } } else if (event.key === 'Tab') { event.preventDefault(); setValue(current => current + '\t'); } else if (event.key === 'Enter') { event.preventDefault(); if (event.ctrlKey || event.shiftKey || window.matchMedia('(max-width: 600px)').matches) setValue(current => current + '\n'); else void submit(); } }} onChange={updatePrompt} />{commandToken !== undefined && <div className="command-menu" id={`prompt-commands-${id}`} role="listbox" aria-label={`${commandToken.prefix} commands`}>{commandOptions.length > 0 ? commandOptions.map((command, index) => <button key={command.value} id={`prompt-command-${id}-${index}`} type="button" role="option" aria-selected={index === activeCommand} className={index === activeCommand ? 'active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => selectCommand(command)}><code>{command.value}</code><span>{command.description}</span></button>) : <span className="command-menu-empty">No matching commands</span>}</div>}</div>;
  const savedPanel = savedPromptsOpen && createPortal(<section className="saved-prompts-panel more-menu flyout-menu" ref={savedPromptFlyoutRef} style={savedPromptFlyoutStyle} aria-label="Saved prompts"><div className="saved-prompts-list">{savedPrompts.map(saved => <button key={saved.id} type="button" disabled={consumingSavedPrompt !== undefined} title={saved.text} onClick={() => void useSavedPrompt(saved)}>{consumingSavedPrompt === saved.id ? <span className="spinner" /> : null}<span>{saved.text}</span></button>)}</div></section>, document.body);
  const savedToggle = savedPrompts.length > 0 ? <button className={`saved-prompts-toggle icon-button${savedPromptsOpen ? ' active' : ''}`} type="button" disabled={pending} aria-label={`Saved prompts (${savedPrompts.length})`} aria-expanded={savedPromptsOpen} title={`${savedPrompts.length} saved prompt${savedPrompts.length === 1 ? '' : 's'}`} onClick={() => setSavedPromptsOpen(open => !open)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg><span className="saved-prompts-count" aria-hidden="true">{savedPrompts.length}</span></button> : null;
  const saveLabel = savingPrompt ? 'Saving' : savedConfirmation ? 'Saved' : 'Save';
  const saveButton = <button className={`save-prompt outline-button icon-button${savedConfirmation ? ' saved' : ''}`} type="button" disabled={pending || savingPrompt || !value.trim()} aria-label={saveLabel} title={saveLabel} onClick={() => void saveCurrentPrompt()}>{savingPrompt ? <span className="spinner" /> : savedConfirmation ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11l3 3v15H5V3Zm3 0v6h8V3M8 21v-7h8v7" /></svg>}</button>;
  const saveControls = <><span className={`save-prompt-group${savedToggle === null ? '' : ' has-saved-prompts'}`} ref={element => { savedPromptGroupRef.current = element; savedPromptAnchorRef.current = element; }} role="group" aria-label="Saved prompt controls">{saveButton}{savedToggle}</span>{savedPanel}</>;
  if (question) return <section className="prompt question-prompt"><div className="question-copy"><strong>Agent question</strong><span>{question.text}</span></div><div className="question-choices">{question.choices.map((choice, index) => <button key={`${index}-${choice}`} className="question-choice" disabled={pending} onClick={() => void answer(index)}><b>{index + 1}</b>{choice}</button>)}</div><div className="prompt-actions">{stop}{swapped && swap}<span className="prompt-actions-spacer" aria-hidden="true" /><More id={id} newTaskConfigured={newTaskConfigured} swapDisabled={swapping} onSwap={swapped ? undefined : onSwap} onSelectTarget={onSelectTarget} /></div></section>;
  const queueLabel = swapped ? 'Enter' : pending ? 'Queueing' : 'Queue';
  return <section className="prompt">{composer}{attachments.length > 0 && <div className="prompt-attachments" aria-label="Selected attachments">{attachments.map((file, index) => <span key={`${file.name}-${index}`} title={file.name}>{file.name}<button type="button" disabled={pending} aria-label={`Remove ${file.name}`} onClick={() => setAttachments(current => current.filter((_, candidate) => candidate !== index))}>×</button></span>)}</div>}{attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}{savedPromptError && <p className="saved-prompt-error" role="alert">{savedPromptError}</p>}<input ref={attachmentInput} className="attachment-input" type="file" multiple onChange={event => { chooseAttachments(event.target.files); event.target.value = ''; }} /><div className="prompt-actions">{stop}{swapped && swap}<span className="prompt-actions-spacer" aria-hidden="true" /><More id={id} newTaskConfigured={newTaskConfigured} attachDisabled={pending} onAttach={swapped ? undefined : () => attachmentInput.current?.click()} swapDisabled={swapping} onSwap={swapped ? undefined : onSwap} onSelectTarget={onSelectTarget} /><ProjectOpen url={projectUrl} stack={stack} onStackAction={worktreeId === undefined ? undefined : action => request(`/api/worktrees/${encodeURIComponent(worktreeId)}/commands/${action}`, { method: 'POST' })} />{supportsSpeechRecognition && <button className={`voice icon-button ${listening ? 'listening' : ''}`} type="button" disabled={pending} aria-label={listening ? 'Stop voice input' : 'Start voice input'} title={listening ? 'Stop voice input' : 'Start voice input'} onClick={voice}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8" /></svg></button>}{saveControls}<button className="queue icon-button" disabled={pending || (!swapped && !value && attachments.length === 0)} aria-label={queueLabel} title={queueLabel} onClick={() => void submit()}>{pending ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" /></svg>}</button></div>{mobileKeys}</section>;
}

type MobileKeyIconName = 'control'|'shift'|'tab'|'up'|'down'|'left'|'right';
function MobileKeyIcon({ name }: { name: MobileKeyIconName }) {
  const paths: Record<MobileKeyIconName, string> = { control: 'M8 5h8v4h3v6h-3v4H8v-4H5V9h3zm2 2v4H7v2h3v4h4v-4h3v-2h-3V7z', shift: 'm12 4 6 6h-4v8h-4v-8H6z', tab: 'M4 8h11m0 0-3-3m3 3-3 3M20 16H9m0 0 3 3m-3-3 3-3', up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6', left: 'm15 6-6 6 6 6', right: 'm9 6 6 6-6 6' };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function Log({ id, onQuestion, terminalMode = false }: { id: string; onQuestion: (question: ChoiceQuestion | undefined) => void; terminalMode?: boolean }) {
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
  const [promptOverflows, setPromptOverflows] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const promptRef = useRef<HTMLSpanElement | null>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [inputActive, setInputActive] = useState(terminalMode);
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
    const pendingInput: string[] = [];
    setStatus('Connecting');
    setHasRendered(false);
    setLastPrompt(lastPrompts.get(id));
    setVisibleFrame(0);
    setInputActive(terminalMode);
    let historyOffset = 0;
    let requestHistory = (_offset: number) => {};
    const terminalOptions = { convertEol: true, fontFamily: monoFontFamily, fontSize: 11, scrollback: 0, screenReaderMode: window.matchMedia('(pointer: coarse)').matches, theme: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b7088', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#89dceb', brightWhite: '#a6adc8' } };
    const terminals = [new XTerm(terminalOptions), new XTerm(terminalOptions)];
    const fits = [new FitAddon(), new FitAddon()];
    let suppressOutputFocusUntil = 0;
    const overlays = createOutputLinkOverlays(canvas.current!, () => { suppressOutputFocusUntil = performance.now() + 250; });
    const releaseScrollContainment = containOutputScroll(canvas.current!);
    let activeFrame: 0 | 1 = 0;
    let terminal = terminals[activeFrame];
    terminalRef.current = terminal;
    terminals.forEach((candidate, index) => { candidate.loadAddon(fits[index]); candidate.open(index === 0 ? primaryHost.current! : secondaryHost.current!); fits[index].fit(); });
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
    const observer = new ResizeObserver(() => { overlays.clear(); fits.forEach(fit => fit.fit()); window.requestAnimationFrame(() => { if (!closed) overlays.render(terminal); }); sendViewport(); });
    observer.observe(canvas.current!);
    const syncScrollState = () => {
      setScrolledUp(historyOffset > 0);
    };
    terminals.forEach(candidate => candidate.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || event.key.toLowerCase() !== 'c') return true;
      if ((event.ctrlKey || event.metaKey) && candidate.hasSelection()) {
        event.preventDefault();
        void copyText(candidate.getSelection());
        return false;
      }
      if (event.ctrlKey && outputModeActive) {
        event.preventDefault();
        sendInput('\x03');
        return false;
      }
      return true;
    }));
    const selectionActive = () => terminals.some(candidate => candidate.hasSelection());
    let flushSelectedOutput = () => {};
    const selectionSubscriptions = terminals.map(candidate => candidate.onSelectionChange(() => {
      if (!selectionActive()) flushSelectedOutput();
    }));
    const inputSubscriptions = terminals.map(candidate => candidate.onData(value => {
      const { alt, ctrl, shift } = mobileModifiers.get(id) ?? { alt: false, ctrl: false, shift: false };
      const first = value.charAt(0);
      const modified = `${alt ? '\x1b' : ''}${ctrl && /^[a-z]$/iu.test(first) ? String.fromCharCode(first.toLowerCase().charCodeAt(0) - 96) : shift && /^[a-z]$/iu.test(first) ? `${first.toUpperCase()}${value.slice(1)}` : value}`;
      sendInput(modified);
    }));
    const focus = () => {
      if (performance.now() < suppressOutputFocusUntil) {
        suppressOutputFocusUntil = 0;
        return;
      }
      // Capture native accessibility-tree selection before the click's default
      // action can collapse it on mobile.
      const selectedTextAtClick = window.getSelection()?.toString() ?? '';
      window.setTimeout(() => {
        const selectedText = window.getSelection()?.toString() ?? '';
        if (selectedTextAtClick || selectedText || terminals.some(candidate => candidate.hasSelection()) || outputModeActive) return exitInput();
        outputModeActive = true;
        setInputActive(true);
        terminal.focus();
        void connectInteractive();
      });
    };
    const releaseLongPressSelection = preserveOutputLongPressSelection(canvas.current!, () => {
      exitInput();
    });
    canvas.current!.addEventListener('click', focus);
    if (terminalMode) {
      terminal.focus();
      void connectInteractive();
    }
    const cachedSnapshot = terminalMode ? undefined : logSnapshots.get(id);
    if (cachedSnapshot) { snapshot = cachedSnapshot; setHasRendered(true); setLastPrompt(cachedLastPrompt(id, cachedSnapshot)); onQuestion(questionFromOutput(cachedSnapshot)); terminal.write(cachedSnapshot, () => { overlays.render(terminal); syncScrollState(); }); }
    const reconnect = () => {
      if (closed || retry !== undefined) return;
      retry = window.setTimeout(() => {
        retry = undefined;
        void connect();
      }, 1_000);
    };
    const renderSnapshot = (ws: WebSocket) => {
      if (closed || socket !== ws || renderingSnapshot) {
        pendingRender = true;
        return;
      }
      renderingSnapshot = true;
      const renderedSnapshot = snapshot;
      const viewport = `\x1b[H${renderedSnapshot.replace(/\n/g, '\x1b[K\n')}\x1b[K\x1b[J`;
      const nextFrame: 0 | 1 = activeFrame === 0 ? 1 : 0;
      const nextTerminal = terminals[nextFrame];
      nextTerminal.reset();
      nextTerminal.write(viewport, () => {
        renderingSnapshot = false;
        if (closed || socket !== ws) return;
        if (selectionActive()) {
          nextTerminal.reset();
          pendingRender = true;
          return;
        }
        const previousTerminal = terminal;
        activeFrame = nextFrame;
        terminal = nextTerminal;
        terminalRef.current = terminal;
        overlays.render(terminal);
        setVisibleFrame(activeFrame);
        requestAnimationFrame(() => { previousTerminal.reset(); syncScrollState(); });
        if (snapshot !== renderedSnapshot) pendingRender = true;
        flushSelectedOutput();
      });
    };
    flushSelectedOutput = () => {
      if (!pendingRender || selectionActive() || renderingSnapshot || closed || socket === undefined || flushFrame !== undefined) return;
      flushFrame = window.requestAnimationFrame(() => {
        flushFrame = undefined;
        if (!pendingRender || selectionActive() || renderingSnapshot || closed || socket === undefined) return;
        pendingRender = false;
        renderSnapshot(socket);
      });
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
          sendViewport();
        };
        ws.onmessage = event => {
          if (closed || socket !== ws) return;
          const frame = JSON.parse(event.data) as LogFrame;
          const text = frame.text ?? '';
          if (!text) return;
          if (frame.newer !== true) historyOffset = 0;
          syncScrollState();
          const latest = historyOffset === 0;
          if (!terminalMode && frame.lastPrompt !== undefined) setLastPrompt(frame.lastPrompt);
          if (!terminalMode && latest) cacheLogFrame(id, frame);
          if (frame.type === 'reset') {
            if (text === snapshot) return;
            snapshot = text;
            if (!terminalMode && latest) setLastPrompt(cachedLastPrompt(id, snapshot));
            if (!terminalMode) onQuestion(questionFromOutput(snapshot));
            setHasRendered(true);
            if (selectionActive() || renderingSnapshot) {
              pendingRender = true;
              return;
            }
            return renderSnapshot(ws);
          }
          snapshot += text;
          if (!terminalMode && latest) setLastPrompt(cachedLastPrompt(id, snapshot));
          if (!terminalMode) onQuestion(questionFromOutput(snapshot));
          setHasRendered(true);
          if (selectionActive() || renderingSnapshot) {
            pendingRender = true;
            return;
          }
          terminal.write(text, () => {
            terminal.scrollToBottom();
            overlays.render(terminal);
            syncScrollState();
          });
        };
        ws.onclose = () => {
          if (closed || socket !== ws) return;
          socket = undefined;
          setStatus('Connecting');
          reconnect();
        };
        ws.onerror = () => ws.close();
      } catch { setStatus('Connecting'); reconnect(); }
    };
    void connect();
    return () => { closed = true; if (terminalInputs.get(id) === sendInput) terminalInputs.delete(id); if (exitTerminalInput.get(id) === exitInput) exitTerminalInput.delete(id); if (logHistoryRequests.get(id) === moveHistory) logHistoryRequests.delete(id); if (retry !== undefined) window.clearTimeout(retry); if (flushFrame !== undefined) window.cancelAnimationFrame(flushFrame); selectionSubscriptions.forEach(subscription => subscription.dispose()); inputSubscriptions.forEach(subscription => subscription.dispose()); canvas.current?.removeEventListener('click', focus); releaseLongPressSelection(); releaseScrollContainment(); observer.disconnect(); socket?.close(); interactiveSocket?.close(); if (terminalRef.current === terminal) terminalRef.current = undefined; overlays.clear(); terminals.forEach(candidate => candidate.dispose()); };
  }, [id, onQuestion, terminalMode]);
  useEffect(() => {
    const prompt = promptRef.current;
    if (!prompt || promptExpanded) return;
    const measure = () => setPromptOverflows(prompt.scrollWidth > prompt.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(prompt);
    return () => observer.disconnect();
  }, [lastPrompt, promptExpanded]);
  useEffect(() => { setPromptExpanded(false); }, [lastPrompt]);
  useEffect(() => { if (!promptOverflows) setPromptExpanded(false); }, [promptOverflows]);
  const loading = !hasRendered;
  const visibleStatus = terminalMode && status === 'Live' ? 'Terminal' : status;
  const loadingLabel = terminalMode ? 'Connecting to pane' : status === 'Live' ? 'Waiting for output' : status;
  const togglePrompt = () => { if (promptOverflows) setPromptExpanded(expanded => !expanded); };
  return <section className="log-shell"><div className={`log${terminalMode ? ' inline-terminal' : ''}${inputActive ? ' input-active' : ''}`}><div className="log-canvas" ref={canvas} aria-label={terminalMode ? 'Interactive agent pane' : 'Live log'}><div ref={primaryHost} className={`terminal-frame ${visibleFrame === 0 ? 'active' : ''}`} /><div ref={secondaryHost} className={`terminal-frame ${visibleFrame === 1 ? 'active' : ''}`} /></div>{status !== 'Live' && <div className="log-stale-overlay" aria-hidden="true" />}{loading && <div className="log-loading"><span className="spinner" />{loadingLabel}</div>}<div className="log-footer">{!terminalMode && <div className="log-controls-bottom">{scrolledUp && <button className="log-control back-to-bottom" onClick={() => logHistoryRequests.get(id)?.(0)}>Back to bottom</button>}<div className="page-controls"><button className="log-control page-arrow" aria-label="Page up" title="Page up" onPointerDown={event => event.preventDefault()} onClick={() => logHistoryRequests.get(id)?.(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button className="log-control page-arrow" aria-label="Page down" title="Page down" onPointerDown={event => event.preventDefault()} onClick={() => logHistoryRequests.get(id)?.(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div></div>}</div></div><div className={`log-topbar${promptOverflows ? ' expandable' : ''}${promptExpanded ? ' expanded' : ''}`} onClick={togglePrompt}>{!terminalMode && lastPrompt && <span className={`last-prompt${promptOverflows ? ' expandable' : ''}${promptExpanded ? ' expanded' : ''}`} ref={promptRef} title={lastPrompt} role={promptOverflows ? 'button' : undefined} tabIndex={promptOverflows ? 0 : undefined} aria-expanded={promptOverflows ? promptExpanded : undefined} onKeyDown={event => { if (promptOverflows && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); togglePrompt(); } }}><strong>Last prompt:</strong> {lastPrompt}</span>}<span className={`status log-status ${visibleStatus.toLowerCase()}`}><i />{visibleStatus}</span></div></section>;
}

type MoreMenuIconName = 'attachment'|'directory'|'new-task'|'pull-request'|'swap';
function MoreMenuIcon({ name }: { name: MoreMenuIconName }) {
  if (name === 'pull-request') return <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M6 8.5v7M18 8.5v2.5a7 7 0 0 1-7 7H8.5M15.5 6H13" /></svg>;
  const paths: Record<Exclude<MoreMenuIconName, 'pull-request'>, string> = {
    attachment: 'm9 12 5.7-5.7a3.5 3.5 0 1 1 5 5L11 20a5 5 0 1 1-7-7l8.3-8.3',
    directory: 'M3 7h6l2 2h10v10H3V7Zm0 4h18',
    'new-task': 'M12 5v14M5 12h14',
    swap: 'M5 7h13m0 0-4-4m4 4-4 4M19 17H6m0 0 4 4m-4-4 4-4'
  };
  return <svg className="more-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function More({ id, newTaskConfigured = false, attachDisabled = false, onAttach, swapDisabled = false, onSwap, onSelectTarget }: { id?: string; newTaskConfigured?: boolean; attachDisabled?: boolean; onAttach?: () => void; swapDisabled?: boolean; onSwap?: () => void; onSelectTarget: (target: DashboardTarget) => void }) {
  const [menuOpen, setMenuOpen] = useState(false); const { anchorRef, flyoutRef, style } = useViewportFlyout(menuOpen);
  const [directoryOpen, setDirectoryOpen] = useState(false); const [tree, setTree] = useState<{ root: string; path: string; directories: string[] }>();
  const [prSwitch, setPrSwitch] = useState<PullRequestSwitchAvailability>(); const [loadingPrSwitch, setLoadingPrSwitch] = useState(false); const [switchingPr, setSwitchingPr] = useState<number>();
  const [newTask, setNewTask] = useState<NewTaskAvailability>(); const [loadingNewTask, setLoadingNewTask] = useState(false); const [startingNewTask, setStartingNewTask] = useState(false);
  useEffect(() => { if (!menuOpen) return; const close = (event: MouseEvent) => { const target = event.target as Node; if (!anchorRef.current?.contains(target) && !flyoutRef.current?.contains(target)) setMenuOpen(false); }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close); }, [menuOpen]);
  useEffect(() => { if (!directoryOpen || id === undefined) return; void request(`/api/agents/${encodeURIComponent(id)}/directories`).then(r => r.ok ? r.json() : undefined).then(setTree); }, [directoryOpen, id]);
  useEffect(() => {
    if (!menuOpen || id === undefined) { setPrSwitch(undefined); setNewTask(undefined); setLoadingPrSwitch(false); setLoadingNewTask(false); return; }
    let cancelled = false;
    setLoadingPrSwitch(true);
    void request(`/api/agents/${encodeURIComponent(id)}/switch-prs`).then(response => response.ok ? response.json() : undefined).then((payload: unknown) => {
      if (cancelled) return;
      if (payload !== null && typeof payload === 'object' && typeof (payload as { enabled?: unknown }).enabled === 'boolean' && Array.isArray((payload as { pullRequests?: unknown }).pullRequests)) {
        const pullRequests = (payload as { pullRequests: unknown[] }).pullRequests.filter((value): value is SwitchablePullRequest => {
          if (value === null || typeof value !== 'object' || !Number.isInteger((value as PullRequestChoice).number) || typeof (value as PullRequestChoice).title !== 'string' || typeof (value as PullRequestChoice).branch !== 'string' || typeof (value as PullRequestChoice).draft !== 'boolean' || typeof (value as PullRequestChoice).url !== 'string' || typeof (value as SwitchablePullRequest).checkedOut !== 'boolean') return false;
          const openIn = (value as SwitchablePullRequest).openIn;
          return openIn === undefined || (openIn !== null && typeof openIn === 'object' && typeof openIn.worktreeId === 'string' && typeof openIn.worktreeName === 'string' && (openIn.agentId === undefined || typeof openIn.agentId === 'string'));
        });
        setPrSwitch({ enabled: (payload as { enabled: boolean }).enabled, pullRequests });
      }
      setLoadingPrSwitch(false);
    }).catch(() => { if (!cancelled) setLoadingPrSwitch(false); });
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
  const attachFiles = () => { setMenuOpen(false); window.requestAnimationFrame(() => onAttach?.()); };
  const chooseDirectory = () => { setMenuOpen(false); setDirectoryOpen(true); };
  const switchPullRequest = async (number: number) => { if (id === undefined || switchingPr !== undefined) return; setSwitchingPr(number); try { const response = await request(`/api/agents/${encodeURIComponent(id)}/switch-pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number }) }); if (response.ok) setMenuOpen(false); } finally { setSwitchingPr(undefined); } };
  const startNewTask = async () => { if (id === undefined || startingNewTask || !newTask?.enabled) return; setStartingNewTask(true); try { const response = await request(`/api/agents/${encodeURIComponent(id)}/new-task`, { method: 'POST' }); if (response.ok) setMenuOpen(false); } finally { setStartingNewTask(false); } };
  const hasPullRequestSwitch = prSwitch !== undefined;
  const hasPullRequestSection = loadingPrSwitch || hasPullRequestSwitch;
  const hasNewTask = newTaskConfigured;
  const toggleMenu = () => {
    if (!menuOpen && id !== undefined) { setPrSwitch(undefined); setNewTask(undefined); setLoadingPrSwitch(true); setLoadingNewTask(newTaskConfigured); }
    setMenuOpen(open => !open);
  };
  const selectWorktree = (target: DashboardTarget) => { setMenuOpen(false); onSelectTarget(target); };
  if (id === undefined) return null;
  return <><span className="more-wrap" ref={anchorRef}><button className="more icon-button" aria-label="More options" aria-expanded={menuOpen} onClick={toggleMenu}>⋮</button></span>{menuOpen && createPortal(<div className={`more-menu flyout-menu${hasPullRequestSection ? ' pr-switch-menu' : ''}`} ref={flyoutRef} style={style}>{onSwap && <button disabled={swapDisabled} onClick={swapToTerminal}><MoreMenuIcon name="swap" />Swap to terminal</button>}{onAttach && <button disabled={attachDisabled} onClick={attachFiles}><MoreMenuIcon name="attachment" />Attach files</button>}<button onClick={chooseDirectory}><MoreMenuIcon name="directory" />Change directory</button>{hasNewTask && <hr className="more-menu-divider" />}{hasNewTask && loadingNewTask && <button className="new-task-loading" disabled><span className="spinner" />New Task</button>}{hasNewTask && newTask && <div className="new-task-option"><button disabled={!newTask.enabled || startingNewTask} onClick={() => void startNewTask()}>{startingNewTask ? <><span className="spinner" />Starting New Task</> : <><MoreMenuIcon name="new-task" />New Task</>}</button>{!newTask.enabled && <span className="more-menu-reason" role="status">{newTask.reason ?? 'New Task is currently unavailable.'}</span>}</div>}{hasPullRequestSection && <hr className="more-menu-divider" />}{loadingPrSwitch && <div className="pr-switch-loading" role="status" aria-label="Loading pull requests"><span className="spinner" />Loading pull requests…</div>}{prSwitch?.pullRequests.map(pullRequest => {
    const status = pullRequest.draft ? 'draft' : 'open';
    const label = `#${pullRequest.number}: ${pullRequest.title}`;
    const unavailableReason = pullRequest.checkedOut ? `Already open in ${pullRequest.openIn?.worktreeName ?? 'another worktree'}` : !prSwitch.enabled ? 'Working copy must be clean and pushed' : label;
    return <div key={pullRequest.number} className="switch-pr-option"><button className="switch-pr" disabled={switchingPr !== undefined || pullRequest.checkedOut || !prSwitch.enabled} title={unavailableReason} aria-label={label} onClick={() => void switchPullRequest(pullRequest.number)}>{switchingPr === pullRequest.number ? <><span className="spinner" />Switching…</> : <><PullRequestStatusIcon status={status} className="switch-pr-status-icon" /><span className="switch-pr-copy"><strong className={`status-${status}`}>#{pullRequest.number}</strong><span>: {pullRequest.title}</span></span></>}</button><span className="switch-pr-actions">{pullRequest.openIn && <button className="switch-pr-worktree" onClick={() => selectWorktree(pullRequest.openIn!)}>Switch to {pullRequest.openIn.worktreeName}</button>}<a className="switch-pr-external" href={pullRequest.url} target="_blank" rel="noreferrer" aria-label={`Open PR #${pullRequest.number} in GitHub`} title={`Open PR #${pullRequest.number} in GitHub`}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M19 14v5H5V5h5" /></svg></a></span></div>;
  })}{prSwitch?.pullRequests.length === 0 && <span className="more-menu-empty">No open pull requests</span>}</div>, document.body)}{directoryOpen && <div className="dialog" role="dialog" aria-modal="true"><div><button onClick={() => setDirectoryOpen(false)}>Close</button><h2>Change directory</h2><p>{tree?.path ?? 'Loading directories…'}</p>{tree && <button onClick={() => void request(`/api/agents/${encodeURIComponent(id)}/directory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: tree.path }) }).then(() => setDirectoryOpen(false))}>Start agent here</button>}{tree?.directories.map(name => <button key={name} onClick={() => void request(`/api/agents/${encodeURIComponent(id)}/directories?path=${encodeURIComponent(`${tree.path}/${name}`)}`).then(r => r.ok && r.json()).then(setTree)}>{name}</button>)}</div></div>}</>;
}

function AgentCard({ agent, active, tabBar, onDeleted, onSelectTarget }: { agent: Agent; active: boolean; tabBar: ReactNode; onDeleted: () => Promise<void>; onSelectTarget: (target: DashboardTarget) => void }) {
  const [terminal, setTerminal] = useState(false);
  const terminalTransition = useRef<'agent'|'backgrounding'|'terminal'|'foregrounding'>('agent');
  const mounted = useRef(true);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [question, setQuestion] = useState<ChoiceQuestion>();
  const cancel = async () => { if (cancelling) return; setCancelling(true); try { await request(`/api/agents/${encodeURIComponent(agent.id)}/cancel`, { method: 'POST' }); } finally { setCancelling(false); } };
  const remove = async () => { if (deleting) return; setDeleting(true); try { const response = await request(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' }); if (response.ok) await onDeleted(); } finally { setDeleting(false); } };
  const deactivate = async () => { if (deactivating) return; setDeactivating(true); try { const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/deactivate`, { method: 'POST' }); if (response.ok) await onDeleted(); } finally { setDeactivating(false); } };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (terminalTransition.current !== 'terminal') return;
      terminalTransition.current = 'foregrounding';
      void request(`/api/agents/${encodeURIComponent(agent.id)}/foreground`, { method: 'POST' }).catch(() => undefined).finally(() => { terminalTransition.current = 'agent'; });
    };
  }, [agent.id]);
  const swap = async () => {
    if (swapping) return;
    setSwapping(true);
    try {
      if (terminal) {
        terminalTransition.current = 'foregrounding';
        const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/foreground`, { method: 'POST' });
        if (response.ok) {
          terminalTransition.current = 'agent';
          if (mounted.current) setTerminal(false);
        } else {
          terminalTransition.current = 'terminal';
        }
        return;
      }
      terminalTransition.current = 'backgrounding';
      const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/background`, { method: 'POST' });
      if (!response.ok) {
        terminalTransition.current = 'agent';
        return;
      }
      if (!mounted.current) {
        terminalTransition.current = 'foregrounding';
        await request(`/api/agents/${encodeURIComponent(agent.id)}/foreground`, { method: 'POST' });
        terminalTransition.current = 'agent';
        return;
      }
      terminalTransition.current = 'terminal';
      setTerminal(true);
    } catch {
      terminalTransition.current = terminal ? 'terminal' : 'agent';
    } finally {
      if (mounted.current) setSwapping(false);
    }
  };
  const omxQuestion = agent.question === undefined ? undefined : { text: agent.question.text, choices: agent.question.choices, omxId: agent.question.id };
  return <article className="agent-view"><Log id={agent.id} onQuestion={setQuestion} terminalMode={terminal} />{tabBar}<PullRequestCard pullRequest={agent.pullRequest} onFixup={agent.pullRequest === undefined ? undefined : async () => (await request(`/api/agents/${encodeURIComponent(agent.id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '$fixup', attachments: [] }) })).ok} /><Prompt id={agent.id} canCancel={active} cancelling={cancelling} deleting={deleting} deactivating={deactivating} swapping={swapping} swapped={terminal} onCancel={() => void cancel()} onDelete={!active && agent.worktreeId === undefined ? () => void remove() : undefined} onDeactivate={!active && agent.worktreeId !== undefined ? () => void deactivate() : undefined} onSwap={() => void swap()} onSelectTarget={onSelectTarget} projectUrl={agent.projectUrl} question={omxQuestion ?? question} worktreeId={agent.worktreeId} newTaskConfigured={agent.newTaskConfigured} stack={agent.stack} /></article>;
}

function launchError(response: Response): Promise<string> {
  return response.json().then((body: { error?: unknown }) => typeof body.error === 'string' ? body.error : `Launch failed (${response.status}).`).catch(() => `Launch failed (${response.status}).`);
}

function WorktreeCard({ worktree, tabBar, onLaunched }: { worktree: Worktree; tabBar: ReactNode; onLaunched: (agentId: string, sourceItemKey: string) => void }) {
  const launchKey = `worktree-launch:${worktree.id}`;
  const launching = usePendingOperation(launchKey);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 5_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const launch = async () => {
    if (!worktree.available || launching || !beginPendingOperation(launchKey)) return;
    setError('');
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, { method: 'POST' });
      if (!response.ok) return setError(await launchError(response));
      const payload = await response.json() as { agentId?: unknown };
      if (typeof payload.agentId !== 'string') return setError('The agent started but could not be opened.');
      onLaunched(payload.agentId, `worktree-${worktree.id}`);
    } catch { setError('Unable to reach the console while launching the agent.'); }
    finally { setPendingOperation(launchKey, false); }
  };
  return <article className="agent-view"><section className="log-shell"><div className="log inactive-log"><div className="log-loading inactive">{launching ? <><span className="spinner" />Starting Codex…</> : 'Inactive'}</div><div className="log-footer"><div className="log-controls-bottom"><div className="page-controls"><button className="log-control page-arrow" aria-label="Page up" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button className="log-control page-arrow" aria-label="Page down" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div></div></div></div><div className="log-topbar"><span className="status log-status inactive"><i />Inactive</span></div></section>{tabBar}<PullRequestCard pullRequest={worktree.pullRequest} /><section className="prompt"><textarea aria-label="Prompt" disabled />{error && <p className="launch-error" role="alert">{error}</p>}<div className="prompt-actions"><span className="prompt-actions-spacer" aria-hidden="true" /><ProjectOpen url={worktree.projectUrl} stack={worktree.stack} onStackAction={action => request(`/api/worktrees/${encodeURIComponent(worktree.id)}/commands/${action}`, { method: 'POST' })} /><button className="queue" disabled={!worktree.available || launching} onClick={() => void launch()}>{launching ? <><span className="spinner" />Launching</> : 'Launch agent'}</button></div></section></article>;
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
  const [activateAgentId, setActivateAgentId] = useState<string>();
  const tabInitialized = useRef(false);
  const refreshInFlight = useRef(false);
  const dashboardContent = useRef('');
  const selectedItemKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!launchErrorMessage) return;
    const timer = window.setTimeout(() => setLaunchErrorMessage(''), 5_000);
    return () => window.clearTimeout(timer);
  }, [launchErrorMessage]);
  useEffect(() => {
    if (!launcherOpen) return;
    const close = (event: MouseEvent) => { const target = event.target as Node; if (!launcherRef.current?.contains(target) && !launcherMenuRef.current?.contains(target)) setLauncherOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [launcherOpen]);
  const agentStates = useRef(new Map<string, AgentState>());
  const pendingCompletions = useRef(new Map<string, { due: number; timer: number }>());
  const refresh = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const response = await request('/api/dashboard', { signal: AbortSignal.timeout(8_000) });
      if (response.status === 401) return onUnauthorized();
      if (response.status === 423) return onInactive();
      if (!response.ok) throw new Error('dashboard unavailable');
      const payload: unknown = await response.json();
      if (!isDashboard(payload)) throw new Error('invalid dashboard response');
      const content = JSON.stringify([payload.agents, payload.worktrees]);
      if (content !== dashboardContent.current) {
        dashboardContent.current = content;
        setData(payload);
      }
      setUnavailable(false);
    } catch { setUnavailable(true); }
    finally { refreshInFlight.current = false; }
  };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5_000); return () => window.clearInterval(timer); }, []);
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
        if (focused) dismissAgentNotifications(agent);
        else void showNotification('finished', 'Agent finished', `${label} is ready for another prompt.`, tag, `/#agent=${encodeURIComponent(agent.id)}`, agent.worktreeId);
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
  }, [data]);
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
        socket.onmessage = event => { cacheLogFrame(agent.id, JSON.parse(event.data) as LogFrame); socket.close(); };
      }).catch(() => {});
    }
    return () => { closed = true; sockets.forEach(socket => socket.close()); };
  }, [agentIds]);
  const items: DashboardItem[] = data === undefined ? [] : [
    ...data.agents.map(agent => ({ key: `agent-${agent.id}`, label: agentLabel(agent), state: agentState(agent), order: agent.worktreeOrder ?? Number.MAX_SAFE_INTEGER, agent })),
    ...data.worktrees.filter(worktree => worktree.pinned).map(worktree => ({ key: `worktree-${worktree.id}`, label: worktree.label, state: 'closed' as const, order: worktree.order, worktree }))
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
  const select = (index: number) => { const item = items[index]; if (!item) return; selectedItemKey.current = item.key; const target = item.agent === undefined ? `tab=${encodeURIComponent(item.label)}` : `agent=${encodeURIComponent(item.agent.id)}`; history.replaceState(null, '', `${location.pathname}${location.search}#${target}`); setActive(index); };
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
    setCreatingAgent(true);
    try {
      const response = await request('/api/agents/launch', { method: 'POST' });
      if (!response.ok) return setLaunchErrorMessage(await launchError(response));
      const payload = await response.json() as { agentId?: unknown };
      if (typeof payload.agentId !== 'string') return setLaunchErrorMessage('The agent started but could not be opened.');
      launched(payload.agentId);
    } catch { setLaunchErrorMessage('Unable to reach the console while launching the agent.'); }
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
  const launchWorktree = async (worktree: Worktree) => { setLauncherOpen(false); const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, { method: 'POST' }); if (!response.ok) return setLaunchErrorMessage(await launchError(response)); const payload = await response.json() as { agentId?: unknown }; if (typeof payload.agentId === 'string') launched(payload.agentId); };
  const selectTarget = (target: DashboardTarget) => {
    const index = items.findIndex(candidate => (target.agentId !== undefined && candidate.agent?.id === target.agentId) || candidate.agent?.worktreeId === target.worktreeId || candidate.worktree?.id === target.worktreeId);
    if (index >= 0) return select(index);
    const worktree = data?.worktrees.find(candidate => candidate.id === target.worktreeId);
    if (worktree !== undefined) void launchWorktree(worktree);
  };
  const selectedAgent = data === undefined ? undefined : items[active]?.agent;
  const selectedAgentId = selectedAgent?.id;
  const selectedWorktreeId = selectedAgent?.worktreeId;
  useEffect(() => {
    if (selectedAgentId === undefined) return;
    const dismiss = () => { if (pageFocused()) dismissAgentNotifications({ id: selectedAgentId, worktreeId: selectedWorktreeId }); };
    dismiss();
    window.addEventListener('focus', dismiss);
    document.addEventListener('visibilitychange', dismiss);
    return () => { window.removeEventListener('focus', dismiss); document.removeEventListener('visibilitychange', dismiss); };
  }, [selectedAgentId, selectedWorktreeId]);
  if (data === undefined) return <LoadingScreen label={unavailable ? 'Reconnecting to console' : 'Syncing console state'} />;
  const item = items[active];
  const stateLabel: Record<AgentState, string> = { working: 'Working', 'prompt-done': 'Prompt done', 'action-required': 'Action required', closed: 'Agent closed' };
  const tabBar = <><nav className="tabs" ref={tabsRef} role="tablist" aria-label="Agents and worktrees">{items.map((entry, index) => <button key={entry.key} id={`tab-${index}`} role="tab" aria-selected={index === active} aria-controls={`panel-${index}`} tabIndex={index === active ? 0 : -1} className={`${index === active ? 'active ' : ''}status-${entry.state}`} title={stateLabel[entry.state]} aria-label={`${entry.label} — ${stateLabel[entry.state]}`} onClick={() => select(index)}>{entry.state === 'working' ? <span className="tab-label" aria-hidden="true">{entry.label}</span> : entry.label}</button>)}<NotificationControl />{updateAvailable && <button className="update-ready" type="button" onClick={onReload}>Update available <span>Reload</span></button>}<span className="launcher" ref={launcherRef}><button ref={plusRef} className="new-agent-tab" type="button" disabled={creatingAgent} aria-label="Launch agent" aria-expanded={launcherOpen} onClick={() => setLauncherOpen(value => !value)}>{creatingAgent ? <span className="spinner" /> : '+'}</button></span>{launcherOpen && createPortal(<div className="launcher-menu more-menu flyout-menu" ref={launcherMenuRef} style={launcherStyle}><button onClick={() => void createAgent()}>~ Scratch</button>{data.worktrees.map(worktree => <button key={worktree.id} onClick={() => void launchWorktree(worktree)}>{worktree.label}</button>)}</div>, document.body)}{plusAlone && <span className="tab-spacer" aria-hidden="true" />}</nav>{launchErrorMessage && <p className="launch-error launch-error-global" role="alert">{launchErrorMessage}</p>}</>;
  if (items.length === 0) return <main className="console"><article className="worktree-view">{tabBar}<h2>No sessions</h2></article></main>;
  return <main className="console"><section className="panel" role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} tabIndex={0}>{item?.agent && <AgentCard key={item.agent.id} agent={item.agent} active={item.state === 'working'} tabBar={tabBar} onDeleted={refresh} onSelectTarget={selectTarget} />}{item?.worktree && <WorktreeCard key={item.worktree.id} worktree={item.worktree} tabBar={tabBar} onLaunched={launched} />}</section></main>;
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
    const timer = window.setInterval(() => void checkForUpdate(), 30_000);
    return () => { closed = true; window.clearInterval(timer); };
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
