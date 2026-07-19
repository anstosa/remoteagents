import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

type Agent = { id: string; sessionId: string; workspace: string; branch?: string; title: string; worktreeId?: string; worktreeLabel?: string; worktreeOrder?: number; projectUrl?: string };
type Worktree = { id: string; label: string; path: string; available: boolean; order: number; projectUrl?: string };
type Dashboard = { agents: Agent[]; worktrees: Worktree[] };
type AgentState = 'working' | 'prompt-done' | 'closed';
type DashboardItem = { key: string; label: string; state: AgentState; order: number; agent?: Agent; worktree?: Worktree };

let csrf = '';
const request = async (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (csrf) headers.set('X-CSRF-Token', csrf);
  return fetch(url, { ...init, credentials: 'same-origin', headers });
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

function ProjectOpen({ url }: { url?: string }) { return url === undefined ? null : <a className="project-open" href={url} target="_blank" rel="noreferrer">Open <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6m0-6-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" /></svg></a>; }

function Prompt({ id, cancelling, onCancel, projectUrl }: { id: string; cancelling: boolean; onCancel: () => void; projectUrl?: string }) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const submit = async () => {
    if (!value || pending) return;
    setPending(true);
    try {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: value }) });
      if (response.ok) setValue('');
    } finally { setPending(false); }
  };
  return <section className="prompt"><textarea aria-label="Prompt" value={value} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } else if (event.key === 'Tab') { event.preventDefault(); setValue(current => current + '\t'); } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); setValue(current => current + '\n'); } }} onChange={event => setValue(event.target.value)} /><div className="prompt-actions"><button className="danger" disabled={cancelling} onClick={onCancel}>{cancelling ? <><span className="spinner" />Cancelling</> : 'Cancel agent'}</button><ProjectOpen url={projectUrl} /><button className="queue" disabled={pending || !value} onClick={() => void submit()}>{pending ? <><span className="spinner" />Queueing</> : 'Queue prompt'}</button></div></section>;
}

function Log({ id, onOpenTerminal }: { id: string; onOpenTerminal: () => void }) {
  const host = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | undefined>(undefined);
  const [status, setStatus] = useState('Connecting');
  const [hasRendered, setHasRendered] = useState(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [canPageUp, setCanPageUp] = useState(false);
  const [canPageDown, setCanPageDown] = useState(false);
  useEffect(() => {
    let socket: WebSocket | undefined;
    let closed = false;
    let retry: number | undefined;
    setHasRendered(false);
    const terminal = new XTerm({ convertEol: true, disableStdin: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 11, scrollback: 800, theme: { background: '#11111b', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b7088', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#89dceb', brightWhite: '#a6adc8' } });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
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
    const reconnect = () => { if (!closed) retry = window.setTimeout(() => void connect(), 1_000); };
    const connect = async () => {
      setStatus('Connecting');
      try {
        const response = await request(`/api/agents/${encodeURIComponent(id)}/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'logs' }) });
        if (!response.ok) throw new Error('ticket unavailable');
        const { ticket } = await response.json();
        if (closed) return;
        socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/logs/${encodeURIComponent(id)}`, ['rac', ticket]);
        socket.onopen = () => setStatus('Live');
        socket.onmessage = event => {
          const frame = JSON.parse(event.data);
          if (frame.type !== 'reset') { if (frame.text) setHasRendered(true); return terminal.write(frame.text, syncScrollState); }
          const buffer = terminal.buffer.active;
          const offsetFromBottom = buffer.baseY - buffer.viewportY;
          const follow = offsetFromBottom < 2;
          terminal.reset();
          setHasRendered(Boolean(frame.text));
          terminal.write(frame.text, () => {
            if (follow) terminal.scrollToBottom();
            else terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - offsetFromBottom));
            syncScrollState();
          });
        };
        socket.onclose = () => { setStatus('Reconnecting'); reconnect(); };
        socket.onerror = () => socket?.close();
      } catch { setStatus('Reconnecting'); reconnect(); }
    };
    void connect();
    return () => { closed = true; if (retry !== undefined) window.clearTimeout(retry); scrollSubscription.dispose(); observer.disconnect(); socket?.close(); if (terminalRef.current === terminal) terminalRef.current = undefined; terminal.dispose(); };
  }, [id]);
  const loading = status === 'Connecting' || status === 'Reconnecting' || (status === 'Live' && !hasRendered);
  const loadingLabel = status === 'Live' ? 'Waiting for output' : status;
  return <section className="log-shell"><div className="log"><div className="log-topbar"><button className="terminal-toggle" onClick={onOpenTerminal}>Open terminal</button><span className={`status log-status ${status.toLowerCase()}`}><i />{status}</span></div><div className="log-canvas" ref={host} aria-label="Live log" />{loading && <div className="log-loading"><span className="spinner" />{loadingLabel}</div>}<div className="log-controls-bottom">{scrolledUp && <button className="log-control back-to-bottom" onClick={() => terminalRef.current?.scrollToBottom()}>Back to bottom</button>}<div className="page-controls"><button className="log-control page-arrow" aria-label="Page up" title="Page up" disabled={!canPageUp} onClick={() => terminalRef.current?.scrollPages(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button className="log-control page-arrow" aria-label="Page down" title="Page down" disabled={!canPageDown} onClick={() => terminalRef.current?.scrollPages(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div></div></div></section>;
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

function AgentCard({ agent }: { agent: Agent }) {
  const [terminal, setTerminal] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancel = async () => { if (cancelling) return; setCancelling(true); try { await request(`/api/agents/${encodeURIComponent(agent.id)}/cancel`, { method: 'POST' }); } finally { setCancelling(false); } };
  return <article className="agent-view"><Log id={agent.id} onOpenTerminal={() => setTerminal(true)} /><Prompt id={agent.id} cancelling={cancelling} onCancel={() => void cancel()} projectUrl={agent.projectUrl} />{terminal && <div className="dialog" role="dialog" aria-modal="true"><div><button onClick={() => setTerminal(false)}>Close</button><Terminal agent={agent} /></div></div>}</article>;
}

function WorktreeCard({ worktree }: { worktree: Worktree }) {
  const [launching, setLaunching] = useState(false);
  const launch = async () => { if (!worktree.available || launching) return; setLaunching(true); try { await request(`/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, { method: 'POST' }); } finally { setLaunching(false); } };
  return <article className="agent-view"><section className="log-shell"><div className="log inactive-log"><div className="log-topbar"><button className="terminal-toggle" disabled>Open terminal</button><span className="status log-status inactive"><i />Inactive</span></div><div className="log-loading inactive">Inactive</div><div className="log-controls-bottom"><div className="page-controls"><button className="log-control page-arrow" aria-label="Page up" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button><button className="log-control page-arrow" aria-label="Page down" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button></div></div></div></section><section className="prompt"><textarea aria-label="Prompt" disabled /><div className="prompt-actions"><button className="danger" disabled>Cancel agent</button><ProjectOpen url={worktree.projectUrl} /><button className="queue" disabled={!worktree.available || launching} onClick={() => void launch()}>{launching ? <><span className="spinner" />Launching</> : 'Launch agent'}</button></div></section></article>;
}

function DashboardView() {
  const [data, setData] = useState<Dashboard>();
  const [active, setActive] = useState(0);
  const tabInitialized = useRef(false);
  const refresh = () => request('/api/dashboard').then(response => response.ok ? response.json() : Promise.reject()).then(setData);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5_000); return () => window.clearInterval(timer); }, []);
  const items: DashboardItem[] = data === undefined ? [] : [
    ...data.agents.map(agent => ({ key: `agent-${agent.id}`, label: (agent.worktreeLabel ?? agent.title) || agent.workspace, state: /^[\u2800-\u28ff]/u.test(agent.title) ? 'working' as const : 'prompt-done' as const, order: agent.worktreeOrder ?? Number.MAX_SAFE_INTEGER, agent })),
    ...data.worktrees.map(worktree => ({ key: `worktree-${worktree.id}`, label: worktree.label, state: 'closed' as const, order: worktree.order, worktree }))
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
  const move = (delta: number) => select(Math.max(0, Math.min(items.length - 1, active + delta)));
  if (data === undefined) return <LoadingScreen label="Syncing console state" />;
  const item = items[active];
  const stateLabel: Record<AgentState, string> = { working: 'Working', 'prompt-done': 'Prompt done', closed: 'Agent closed' };
  return <main className="console">{items.length > 0 && <><nav className="tabs" role="tablist" aria-label="Agents and worktrees">{items.map((entry, index) => <button key={entry.key} id={`tab-${index}`} role="tab" aria-selected={index === active} aria-controls={`panel-${index}`} tabIndex={index === active ? 0 : -1} className={`${index === active ? 'active ' : ''}status-${entry.state}`} title={stateLabel[entry.state]} aria-label={`${entry.label} — ${stateLabel[entry.state]}`} onClick={() => select(index)}>{entry.label}</button>)}</nav><section className="panel" role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} tabIndex={0} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); move(1); } if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); } }}>{item?.agent && <AgentCard agent={item.agent} />}{item?.worktree && <WorktreeCard worktree={item.worktree} />}</section></>}{items.length === 0 && <article className="worktree-view"><h2>No sessions</h2></article>}</main>;
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
        const session = await fetch('/api/auth/session', { credentials: 'same-origin' });
        if (session.ok) {
          csrf = (await session.json()).csrfToken;
          if (active) setState('ready');
          return;
        }
        const bootstrap = await fetch('/api/auth/bootstrap', { credentials: 'same-origin' });
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
  return state === 'ready' ? <DashboardView /> : <Login initialError={error} done={() => setState('ready')} />;
}
createRoot(document.getElementById('root')!).render(<App />);
