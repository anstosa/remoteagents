import { Component, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

type OmxQuestion = { id: string; text: string; choices: string[]; paneId: string };
type Agent = { id: string; sessionId: string; workspace: string; branch?: string; title: string; worktreeId?: string; worktreeLabel?: string; worktreeOrder?: number; projectUrl?: string; pullRequestUrl?: string; question?: OmxQuestion };
type Worktree = { id: string; label: string; path: string; available: boolean; pinned: boolean; order: number; projectUrl?: string; pullRequestUrl?: string };
type Dashboard = { agents: Agent[]; worktrees: Worktree[] };
const isDashboard = (value: unknown): value is Dashboard => {
  if (value === null || typeof value !== 'object') return false;
  const dashboard = value as { agents?: unknown; worktrees?: unknown };
  return Array.isArray(dashboard.agents) && Array.isArray(dashboard.worktrees);
};
type AgentState = 'working' | 'prompt-done' | 'action-required' | 'closed';
type DashboardItem = { key: string; label: string; state: AgentState; order: number; agent?: Agent; worktree?: Worktree };
type LogFrame = { type: 'append' | 'reset'; text?: string };
type ChoiceQuestion = { text: string; choices: string[]; omxId?: string };
const actionRequired = (agent: Agent) => /action required/i.test(agent.title);
const agentState = (agent: Agent): AgentState => actionRequired(agent) ? 'action-required' : /^[\u2800-\u28ff]/u.test(agent.title) ? 'working' : 'prompt-done';
const agentLabel = (agent: Agent) => (agent.worktreeLabel ?? (actionRequired(agent) ? agent.title.replace(/(?:\[\s*.\s*\]\s*)?action required\s*\|?\s*/i, '🚨 ') : agent.title)) || agent.workspace;
type SpeechRecognitionInstance = { continuous: boolean; interimResults: boolean; lang: string; start: () => void; abort: () => void; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

const logSnapshots = new Map<string, string>();
const promptDrafts = new Map<string, { value: string; pending: boolean }>();
const cacheLogFrame = (id: string, frame: LogFrame) => {
  const text = frame.text ?? '';
  logSnapshots.set(id, frame.type === 'reset' ? text : `${logSnapshots.get(id) ?? ''}${text}`);
};

const questionFromOutput = (output: string): ChoiceQuestion | undefined => {
  const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').map(line => line.trim()).filter(Boolean);
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
  const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n');
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

let csrf = '';
const request = async (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  return fetch(url, { ...init, credentials: 'same-origin', headers });
};

const showNotification = async (title: string, body: string, tag: string) => {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body, tag, icon: '/favicon.svg' };
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, options);
    return;
  }
  new Notification(title, options);
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

function Login({ done, initialError }: { done: () => void; initialError?: string }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!response.ok) return setError('Invalid credentials');
    csrf = (await response.json()).csrfToken;
    setPassword('');
    done();
  };
  return <main className="auth-screen"><div className="auth-glow" /><form className="auth-card" onSubmit={login}><div className="auth-mark" aria-hidden="true"><span>&gt;_</span></div><div className="auth-heading"><p>REMOTE // AGENTS</p><h1>Console access</h1></div><label className="sr-only">Username<input type="text" name="username" autoComplete="username" tabIndex={-1} /></label><label>Password<input autoFocus type="password" name="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="auth-submit">Authenticate <span aria-hidden="true">↗</span></button></form></main>;
}

function LoadingScreen({ label = 'Restoring secure session' }: { label?: string }) {
  return <main className="auth-screen loading-screen" aria-live="polite"><div className="auth-glow" /><div className="loading-console"><div className="loading-line"><span className="spinner" />{label}</div><div className="loading-bars" aria-hidden="true"><i /><i /><i /><i /><i /></div></div></main>;
}

class ConsoleBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="auth-screen loading-screen" role="alert"><div className="auth-glow" /><section className="loading-console console-recovery"><strong>Console needs to reconnect</strong><span>The interface hit a temporary problem.</span><button type="button" onClick={() => location.reload()}>Reload console</button></section></main>;
  }
}

function ProjectOpen({ url }: { url?: string }) { return url === undefined ? null : <a className="project-open" href={url} target="_blank" rel="noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6m0-6-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" /></svg>Open</a>; }
function PullRequestOpen({ url }: { url?: string }) { return url === undefined ? null : <a className="pull-request-open" href={url} target="_blank" rel="noreferrer"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 4.73c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>PR</a>; }

function Prompt({ id, canCancel, cancelling, deleting, onCancel, onDelete, projectUrl, pullRequestUrl, question }: { id: string; canCancel: boolean; cancelling: boolean; deleting: boolean; onCancel: () => void; onDelete?: () => void; projectUrl?: string; pullRequestUrl?: string; question?: ChoiceQuestion }) {
  const [value, setValue] = useState(() => promptDrafts.get(id)?.value ?? '');
  const [pending, setPending] = useState(() => promptDrafts.get(id)?.pending ?? false);
  useEffect(() => { promptDrafts.set(id, { value, pending }); }, [id, value, pending]);
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionInstance | undefined>(undefined);
  const speechPrefix = useRef('');
  const speechWindow = window as Window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
  const supportsSpeechRecognition = speechWindow.SpeechRecognition !== undefined || speechWindow.webkitSpeechRecognition !== undefined;
  useEffect(() => () => recognition.current?.abort(), []);
  const submit = async () => {
    if (!value || pending) return;
    setPending(true);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: value }) });
      if (response.ok) setValue('');
    } finally { setPending(false); }
  };
  const answer = async (index: number) => { if (pending) return; setPending(true); try { const url = question?.omxId === undefined ? `/api/agents/${encodeURIComponent(id)}/question` : `/api/agents/${encodeURIComponent(id)}/omx-question`; const body = question?.omxId === undefined ? { index } : { index, questionId: question.omxId }; await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } finally { setPending(false); } };
  const voice = () => {
    if (pending || !supportsSpeechRecognition) return;
    if (listening) return recognition.current?.abort();
    const Recognition = (speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition)!;
    const next = new Recognition();
    recognition.current = next;
    next.continuous = true;
    next.interimResults = true;
    next.lang = navigator.language;
    speechPrefix.current = value;
    next.onresult = event => {
      const transcript = Array.from(event.results).map(result => result[0]?.transcript ?? '').join('').trim();
      if (!transcript) return;
      setValue(`${speechPrefix.current}${speechPrefix.current && !/\s$/u.test(speechPrefix.current) ? ' ' : ''}${transcript}`);
    };
    next.onend = () => { recognition.current = undefined; setListening(false); };
    next.onerror = () => { recognition.current = undefined; setListening(false); };
    setListening(true);
    next.start();
  };
  const stop = onDelete ? <button className="danger delete-agent" disabled={deleting} onClick={onDelete}>{deleting ? <span className="spinner" /> : 'Delete'}</button> : <button className="danger" disabled={!canCancel || cancelling} aria-label="Cancel agent" title="Cancel agent" onClick={onCancel}>{cancelling ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>}</button>;
  if (question) return <section className="prompt question-prompt"><div className="question-copy"><strong>Agent question</strong><span>{question.text}</span></div><div className="question-choices">{question.choices.map((choice, index) => <button key={`${index}-${choice}`} className="question-choice" disabled={pending} onClick={() => void answer(index)}><b>{index + 1}</b>{choice}</button>)}</div><div className="prompt-actions">{stop}</div></section>;
  return <section className="prompt"><textarea aria-label="Prompt" value={value} disabled={pending} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); setValue(''); } else if (event.key === 'Tab') { event.preventDefault(); setValue(current => current + '\t'); } else if (event.key === 'Enter') { event.preventDefault(); if (event.ctrlKey || event.shiftKey || window.matchMedia('(max-width: 600px)').matches) setValue(current => current + '\n'); else void submit(); } }} onChange={event => setValue(event.target.value)} /><div className="prompt-actions">{stop}<More id={id} /><PullRequestOpen url={pullRequestUrl} /><ProjectOpen url={projectUrl} />{supportsSpeechRecognition && <button className={`voice ${listening ? 'listening' : ''}`} type="button" disabled={pending} aria-label={listening ? 'Stop voice input' : 'Start voice input'} title={listening ? 'Stop voice input' : 'Start voice input'} onClick={voice}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0m6 6v4m-3 0h6" /></svg></button>}<button className="queue" disabled={pending || !value} onClick={() => void submit()}>{pending ? <><span className="spinner" />Queueing</> : 'Queue prompt'}</button></div></section>;
}


function Log({ id, onOpenTerminal, onQuestion }: { id: string; onOpenTerminal: () => void; onQuestion: (question: ChoiceQuestion | undefined) => void }) {
  const host = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | undefined>(undefined);
  const [status, setStatus] = useState('Connecting');
  const [hasRendered, setHasRendered] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<string>();
  const [promptOverflows, setPromptOverflows] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const promptRef = useRef<HTMLSpanElement | null>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [canPageUp, setCanPageUp] = useState(false);
  const [canPageDown, setCanPageDown] = useState(false);
  useEffect(() => {
    let socket: WebSocket | undefined;
    let closed = false;
    let retry: number | undefined;
    let snapshot = '';
    setHasRendered(false);
    setLastPrompt(undefined);
    const terminal = new XTerm({ convertEol: true, disableStdin: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 11, scrollback: 800, theme: { background: '#11111b', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b7088', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#89dceb', brightWhite: '#a6adc8' } });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    terminal.open(host.current!);
    fit.fit();
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current!);
    const syncScrollState = () => {
      const buffer = terminal.buffer.active;
      setScrolledUp(buffer.viewportY < buffer.baseY);
      setCanPageUp(buffer.viewportY > 0);
      setCanPageDown(buffer.viewportY < buffer.baseY);
    };
    const scrollSubscription = terminal.onScroll(syncScrollState);
    const keySubscription = terminal.onKey(({ domEvent }) => {
      if ((domEvent.ctrlKey || domEvent.metaKey) && domEvent.key.toLowerCase() === 'c' && terminal.hasSelection()) {
        domEvent.preventDefault();
        void copyText(terminal.getSelection());
      }
    });
    const cachedSnapshot = logSnapshots.get(id);
    if (cachedSnapshot) { setHasRendered(true); setLastPrompt(lastPromptFromOutput(cachedSnapshot)); onQuestion(questionFromOutput(cachedSnapshot)); terminal.write(cachedSnapshot, syncScrollState); }
    const reconnect = () => {
      if (closed || retry !== undefined) return;
      retry = window.setTimeout(() => {
        retry = undefined;
        void connect();
      }, 1_000);
    };
    const connect = async () => {
      setStatus('Connecting');
      try {
        const response = await request(`/api/agents/${encodeURIComponent(id)}/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'logs' }) });
        if (!response.ok) throw new Error('ticket unavailable');
        const { ticket } = await response.json();
        if (closed) return;
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/logs/${encodeURIComponent(id)}`, ['rac', ticket]);
        socket = ws;
        ws.onopen = () => {
          if (closed || socket !== ws) return;
          setStatus('Live');
        };
        ws.onmessage = event => {
          if (closed || socket !== ws) return;
          const frame = JSON.parse(event.data) as LogFrame;
          cacheLogFrame(id, frame);
          if (frame.type !== 'reset') { const text = frame.text ?? ''; snapshot += text; setLastPrompt(lastPromptFromOutput(snapshot)); onQuestion(questionFromOutput(snapshot)); if (text) setHasRendered(true); return terminal.write(text, syncScrollState); }
          const buffer = terminal.buffer.active;
          const viewportY = buffer.viewportY;
          const follow = viewportY >= buffer.baseY - 1;
          terminal.reset();
          snapshot = frame.text ?? '';
          setLastPrompt(lastPromptFromOutput(snapshot)); onQuestion(questionFromOutput(snapshot));
          setHasRendered(Boolean(frame.text));
          terminal.write(frame.text ?? '', () => {
            if (follow) terminal.scrollToBottom();
            else terminal.scrollToLine(Math.min(viewportY, terminal.buffer.active.baseY));
            syncScrollState();
          });
        };
        ws.onclose = () => {
          if (closed || socket !== ws) return;
          socket = undefined;
          setStatus('Reconnecting');
          reconnect();
        };
        ws.onerror = () => ws.close();
      } catch { setStatus('Reconnecting'); reconnect(); }
    };
    void connect();
    return () => { closed = true; if (retry !== undefined) window.clearTimeout(retry); scrollSubscription.dispose(); keySubscription.dispose(); observer.disconnect(); socket?.close(); if (terminalRef.current === terminal) terminalRef.current = undefined; terminal.dispose(); };
  }, [id, onQuestion]);
  useEffect(() => {
    const prompt = promptRef.current;
    if (!prompt) return;
    const measure = () => { if (!promptExpanded) setPromptOverflows(prompt.scrollWidth > prompt.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(prompt);
    return () => observer.disconnect();
  }, [lastPrompt, promptExpanded]);
  useEffect(() => { setPromptExpanded(false); }, [lastPrompt]);
  useEffect(() => { if (!promptOverflows) setPromptExpanded(false); }, [promptOverflows]);
  const loading = !hasRendered;
  const loadingLabel = status === 'Live' ? 'Waiting for output' : status;
  return <section className="log-shell"><div className="log"><div className={`log-topbar ${promptOverflows ? 'expandable' : ''} ${promptExpanded ? 'expanded' : ''}`} onClick={() => promptOverflows && setPromptExpanded(expanded => !expanded)}><button className="terminal-toggle" onClick={event => { event.stopPropagation(); onOpenTerminal(); }}>Open terminal</button>{lastPrompt && <span className={`last-prompt ${promptExpanded ? 'expanded' : ''}`} ref={promptRef} title={lastPrompt}><strong>Last prompt:</strong> {lastPrompt}</span>}<span className={`status log-status ${status.toLowerCase()}`}><i />{status}</span></div><div className="log-canvas" ref={host} aria-label="Live log" />{loading && <div className="log-loading"><span className="spinner" />{loadingLabel}</div>}<div className="log-controls-bottom">{scrolledUp && <button className="log-control back-to-bottom" onClick={() => terminalRef.current?.scrollToBottom()}>Back to bottom</button>}<div className="page-controls"><button className="log-control page-arrow" aria-label="Page up" title="Page up" disabled={!canPageUp} onClick={() => terminalRef.current?.scrollPages(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button className="log-control page-arrow" aria-label="Page down" title="Page down" disabled={!canPageDown} onClick={() => terminalRef.current?.scrollPages(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div></div></div></section>;
}

function Terminal({ agent }: { agent: Agent }) {
  const host = useRef<HTMLDivElement | null>(null);
  const socket = useRef<WebSocket | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  useEffect(() => () => socket.current?.close(), []);
  const connect = async () => {
    const response = await request(`/api/agents/${encodeURIComponent(agent.id)}/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'terminal' }) });
    const { ticket } = await response.json();
    const terminal = new XTerm({ cursorBlink: true, theme: { background: '#11111b', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b7088', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#89dceb', brightWhite: '#a6adc8' } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current!);
    fit.fit();
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/terminal/${encodeURIComponent(agent.id)}`, ['rac', ticket]);
    socket.current = ws;
    const bytes = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    ws.onopen = () => { setConnected(true); ws.send(JSON.stringify({ v: 1, type: 'resize', cols: terminal.cols, rows: terminal.rows })); };
    ws.onmessage = event => { const frame = JSON.parse(event.data); if (frame.type === 'output') terminal.write(bytes(frame.data)); };
    terminal.onData(data => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ v: 1, type: 'input', data: b64(data) })));
    const observer = new ResizeObserver(() => { fit.fit(); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: 'resize', cols: terminal.cols, rows: terminal.rows })); });
    observer.observe(host.current!);
    ws.onclose = () => { observer.disconnect(); terminal.dispose(); setConnected(false); };
  };
  return <section><button disabled={connected} onClick={() => void connect()}>Confirm and connect</button><div className="terminal" ref={host} aria-label="Interactive session terminal" /></section>;
}

type FlyoutSide = 'above' | 'below';
function useViewportFlyout(open: boolean) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [side, setSide] = useState<FlyoutSide>('above');
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = ref.current;
      const flyout = anchor?.querySelector<HTMLElement>('.flyout-menu');
      if (!anchor || !flyout) return;
      const { top, bottom } = anchor.getBoundingClientRect();
      const height = flyout.offsetHeight + 8;
      const above = top;
      const below = window.innerHeight - bottom;
      setSide(below >= height || below > above ? 'below' : 'above');
    };
    position();
    const observer = new ResizeObserver(position);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open]);
  return { ref, side };
}

function More({ id }: { id: string }) {
  const [menuOpen, setMenuOpen] = useState(false); const { ref: menu, side } = useViewportFlyout(menuOpen);
  const [directoryOpen, setDirectoryOpen] = useState(false); const [tree, setTree] = useState<{ root: string; path: string; directories: string[] }>();
  useEffect(() => { if (!menuOpen) return; const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close); }, [menuOpen]);
  useEffect(() => { if (!directoryOpen) return; void request(`/api/agents/${encodeURIComponent(id)}/directories`).then(r => r.ok ? r.json() : undefined).then(setTree); }, [directoryOpen, id]);
  const chooseDirectory = () => { setMenuOpen(false); setDirectoryOpen(true); };
  return <><span className="more-wrap" ref={menu}><button className="more" aria-label="More options" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}>⋮</button>{menuOpen && <div className="more-menu flyout-menu" data-flyout-side={side}><button onClick={chooseDirectory}>Change directory</button></div>}</span>{directoryOpen && <div className="dialog" role="dialog" aria-modal="true"><div><button onClick={() => setDirectoryOpen(false)}>Close</button><h2>Change directory</h2><p>{tree?.path ?? 'Loading directories…'}</p>{tree && <button onClick={() => void request(`/api/agents/${encodeURIComponent(id)}/directory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: tree.path }) }).then(() => setDirectoryOpen(false))}>Start agent here</button>}{tree?.directories.map(name => <button key={name} onClick={() => void request(`/api/agents/${encodeURIComponent(id)}/directories?path=${encodeURIComponent(`${tree.path}/${name}`)}`).then(r => r.ok && r.json()).then(setTree)}>{name}</button>)}</div></div>}</>;
}

function AgentCard({ agent, active, onDeleted }: { agent: Agent; active: boolean; onDeleted: () => Promise<void> }) {
  const [terminal, setTerminal] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [question, setQuestion] = useState<ChoiceQuestion>();
  const cancel = async () => { if (cancelling) return; setCancelling(true); try { await request(`/api/agents/${encodeURIComponent(agent.id)}/cancel`, { method: 'POST' }); } finally { setCancelling(false); } };
  const remove = async () => { if (deleting) return; setDeleting(true); try { const response = await request(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' }); if (response.ok) await onDeleted(); } finally { setDeleting(false); } };
  const omxQuestion = agent.question === undefined ? undefined : { text: agent.question.text, choices: agent.question.choices, omxId: agent.question.id };
  return <article className="agent-view"><Log id={agent.id} onOpenTerminal={() => setTerminal(true)} onQuestion={setQuestion} /><Prompt id={agent.id} canCancel={active} cancelling={cancelling} deleting={deleting} onCancel={() => void cancel()} onDelete={!active && agent.worktreeId === undefined ? () => void remove() : undefined} projectUrl={agent.projectUrl} pullRequestUrl={agent.pullRequestUrl} question={omxQuestion ?? question} />{terminal && <div className="dialog" role="dialog" aria-modal="true"><div><button onClick={() => setTerminal(false)}>Close</button><Terminal agent={agent} /></div></div>}</article>;
}

function launchError(response: Response): Promise<string> {
  return response.json().then((body: { error?: unknown }) => typeof body.error === 'string' ? body.error : `Launch failed (${response.status}).`).catch(() => `Launch failed (${response.status}).`);
}

function WorktreeCard({ worktree, onLaunched }: { worktree: Worktree; onLaunched: (agentId: string) => void }) {
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 5_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const launch = async () => {
    if (!worktree.available || launching) return;
    setError('');
    setLaunching(true);
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, { method: 'POST' });
      if (!response.ok) return setError(await launchError(response));
      const payload = await response.json() as { agentId?: unknown };
      if (typeof payload.agentId !== 'string') return setError('The agent started but could not be opened.');
      onLaunched(payload.agentId);
    } catch { setError('Unable to reach the console while launching the agent.'); }
    finally { setLaunching(false); }
  };
  return <article className="agent-view"><section className="log-shell"><div className="log inactive-log"><div className="log-topbar"><button className="terminal-toggle" disabled>Open terminal</button><span className="status log-status inactive"><i />Inactive</span></div><div className="log-loading inactive">{launching ? <><span className="spinner" />Starting Codex…</> : 'Inactive'}</div><div className="log-controls-bottom"><div className="page-controls"><button className="log-control page-arrow" aria-label="Page up" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button className="log-control page-arrow" aria-label="Page down" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div></div></div></section><section className="prompt"><textarea aria-label="Prompt" disabled />{error && <p className="launch-error" role="alert">{error}</p>}<div className="prompt-actions"><button className="danger" disabled aria-label="Cancel agent" title="Cancel agent"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg></button><PullRequestOpen url={worktree.pullRequestUrl} /><ProjectOpen url={worktree.projectUrl} /><button className="queue" disabled={!worktree.available || launching} onClick={() => void launch()}>{launching ? <><span className="spinner" />Launching</> : 'Launch agent'}</button></div></section></article>;
}

function NotificationControl() {
  const supported = 'Notification' in window;
  const [permission, setPermission] = useState<NotificationPermission | undefined>(() => supported ? Notification.permission : undefined);
  const [publicKey, setPublicKey] = useState<string>();
  useEffect(() => { void request('/api/push/public-key').then(response => response.ok ? response.json() : undefined).then((value: { publicKey?: unknown } | undefined) => typeof value?.publicKey === 'string' && setPublicKey(value.publicKey)); }, []);
  const enable = async () => {
    if (!supported || permission !== 'default' || !publicKey || !('serviceWorker' in navigator)) return;
    const next = await Notification.requestPermission();
    setPermission(next);
    if (next === 'granted') { const registration = await navigator.serviceWorker.ready; const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)); const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); await request('/api/push/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) }); await showNotification('Alerts enabled', 'You will be notified when an agent is ready.', 'rac-alerts-enabled'); }
  };
  if (!supported || !publicKey || permission === 'granted') return null;
  if (permission === 'denied') return <span className="notification-status" title="Enable notifications for this site in your browser settings">Alerts blocked</span>;
  return <button className="notification-control" type="button" onClick={() => void enable()}>Enable alerts</button>;
}

function DashboardView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [data, setData] = useState<Dashboard>();
  const [unavailable, setUnavailable] = useState(false);
  const [active, setActive] = useState(0);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const tabsRef = useRef<HTMLElement | null>(null);
  const { ref: launcherRef, side: launcherSide } = useViewportFlyout(launcherOpen);
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const [plusAlone, setPlusAlone] = useState(false);
  const [launchErrorMessage, setLaunchErrorMessage] = useState('');
  const [activateAgentId, setActivateAgentId] = useState<string>();
  const tabInitialized = useRef(false);
  useEffect(() => {
    if (!launchErrorMessage) return;
    const timer = window.setTimeout(() => setLaunchErrorMessage(''), 5_000);
    return () => window.clearTimeout(timer);
  }, [launchErrorMessage]);
  useEffect(() => {
    if (!launcherOpen) return;
    const close = (event: MouseEvent) => { if (!launcherRef.current?.contains(event.target as Node)) setLauncherOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [launcherOpen]);
  const agentStates = useRef(new Map<string, AgentState>());
  const refresh = async () => {
    try {
      const response = await request('/api/dashboard', { signal: AbortSignal.timeout(8_000) });
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('dashboard unavailable');
      const payload: unknown = await response.json();
      if (!isDashboard(payload)) throw new Error('invalid dashboard response');
      setData(payload);
      setUnavailable(false);
    } catch { setUnavailable(true); }
  };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!data) return;
    const next = new Map<string, AgentState>();
    for (const agent of data.agents) {
      const state = agentState(agent);
      const previous = agentStates.current.get(agent.id);
      if (previous === 'working' && state === 'prompt-done') {
        void showNotification('Agent finished', `${agent.worktreeLabel ?? agent.title} is ready for another prompt.`, `agent-finished-${agent.id}`);
      }
      next.set(agent.id, state);
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
  useEffect(() => { setActive(current => Math.min(current, Math.max(items.length - 1, 0))); }, [items.length]);
  const tabKey = items.map(item => item.label).join('\u0000');
  useEffect(() => {
    if (tabInitialized.current || items.length === 0) return;
    const encoded = location.hash.startsWith('#tab=') ? location.hash.slice(5) : '';
    let title = '';
    try { title = decodeURIComponent(encoded); } catch { /* use the current tab */ }
    const linked = items.findIndex(item => item.label === title);
    if (linked >= 0) setActive(linked);
    tabInitialized.current = true;
  }, [tabKey]);
  const select = (index: number) => { const item = items[index]; if (!item) return; history.replaceState(null, '', `${location.pathname}${location.search}#tab=${encodeURIComponent(item.label)}`); setActive(index); };
  useEffect(() => {
    if (activateAgentId === undefined) return;
    const index = items.findIndex(candidate => candidate.agent?.id === activateAgentId);
    if (index < 0) return;
    select(index);
    setActivateAgentId(undefined);
  }, [activateAgentId, tabKey]);
  const launched = (agentId: string) => { setLaunchErrorMessage(''); setActivateAgentId(agentId); void refresh(); };
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
  }, [items.length, launcherOpen]);
  const launchWorktree = async (worktree: Worktree) => { setLauncherOpen(false); const response = await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, { method: 'POST' }); if (!response.ok) return setLaunchErrorMessage(await launchError(response)); const payload = await response.json() as { agentId?: unknown }; if (typeof payload.agentId === 'string') launched(payload.agentId); };
  if (data === undefined) return <LoadingScreen label={unavailable ? 'Reconnecting to console' : 'Syncing console state'} />;
  const item = items[active];
  const stateLabel: Record<AgentState, string> = { working: 'Working', 'prompt-done': 'Prompt done', 'action-required': 'Action required', closed: 'Agent closed' };
  return <main className="console"><nav className="tabs" ref={tabsRef} role="tablist" aria-label="Agents and worktrees">{items.map((entry, index) => <button key={entry.key} id={`tab-${index}`} role="tab" aria-selected={index === active} aria-controls={`panel-${index}`} tabIndex={index === active ? 0 : -1} className={`${index === active ? 'active ' : ''}status-${entry.state}`} title={stateLabel[entry.state]} aria-label={`${entry.label} — ${stateLabel[entry.state]}`} onClick={() => select(index)}>{entry.state === 'working' ? <span className="tab-label" aria-hidden="true">{Array.from(entry.label).map((letter, letterIndex) => <span className="tab-label-letter" key={`${letter}-${letterIndex}`} style={{ animationDelay: `-${letterIndex * 75}ms` }}>{letter === ' ' ? '\u00a0' : letter}</span>)}</span> : entry.label}</button>)}<NotificationControl /><span className="launcher" ref={launcherRef}><button ref={plusRef} className="new-agent-tab" type="button" disabled={creatingAgent} aria-label="Launch agent" aria-expanded={launcherOpen} onClick={() => setLauncherOpen(value => !value)}>{creatingAgent ? <span className="spinner" /> : '+'}</button>{launcherOpen && <span className="launcher-menu more-menu flyout-menu" data-flyout-side={launcherSide}><button onClick={() => void createAgent()}>~ Home</button>{data.worktrees.map(worktree => <button key={worktree.id} onClick={() => void launchWorktree(worktree)}>{worktree.label}</button>)}</span>}</span>{plusAlone && <span className="tab-spacer" aria-hidden="true" />}</nav>{launchErrorMessage && <p className="launch-error launch-error-global" role="alert">{launchErrorMessage}</p>}{items.length > 0 ? <section className="panel" role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} tabIndex={0}>{item?.agent && <AgentCard agent={item.agent} active={item.state === 'working'} onDeleted={refresh} />}{item?.worktree && <WorktreeCard worktree={item.worktree} onLaunched={launched} />}</section> : <article className="worktree-view"><h2>No sessions</h2></article>}</main>;
}

function App() {
  const [state, setState] = useState<'checking' | 'login' | 'ready'>('checking');
  const [error, setError] = useState('');
  useEffect(() => {
    const viewport = window.visualViewport;
    const updateHeight = () => document.documentElement.style.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`);
    updateHeight();
    window.addEventListener('resize', updateHeight);
    viewport?.addEventListener('resize', updateHeight);
    viewport?.addEventListener('scroll', updateHeight);
    return () => {
      window.removeEventListener('resize', updateHeight);
      viewport?.removeEventListener('resize', updateHeight);
      viewport?.removeEventListener('scroll', updateHeight);
    };
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await fetch('/api/auth/session', { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) });
        if (session.ok) {
          csrf = (await session.json()).csrfToken;
          if (active) setState('ready');
          return;
        }
        const bootstrap = await fetch('/api/auth/bootstrap', { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) });
        if (!bootstrap.ok) throw new Error('bootstrap unavailable');
        csrf = (await bootstrap.json()).csrfToken;
      } catch {
        if (active) setError('Unable to connect to the console');
      }
      if (active) setState('login');
    })();
    return () => { active = false; };
  }, []);
  if (state === 'checking') return <LoadingScreen />;
  return state === 'ready' ? <DashboardView onUnauthorized={() => setState('login')} /> : <Login initialError={error} done={() => setState('ready')} />;
}
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
createRoot(document.getElementById('root')!).render(<ConsoleBoundary><App /></ConsoleBoundary>);
