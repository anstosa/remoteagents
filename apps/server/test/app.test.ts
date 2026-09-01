import { afterEach, describe, expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import { createHmac } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { AuthService } from '../src/auth/service.js';
import { AgentNotificationCoordinator } from '../src/notifications.js';
import { stated } from './helpers/agent.js';
import type { ValidatedConfig } from '../src/config/schema.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { SavedPromptService } from '../src/saved-prompts/service.js';
import { ReviewTourStore } from '../src/review-tour/store.js';
import type { ReviewTour } from '../src/review-tour/contracts.js';
import { PullRequestLookupError } from '../src/pull-requests/service.js';
const config: ValidatedConfig = { name: 'Remote Agents', remoteServers: [], listen:{host:'127.0.0.1',port:8787},publicOrigin:new URL('https://agents.example.com'),trustedProxyIps:new Set(['127.0.0.1']),pollIntervalMs:500,newAgentCommand:'codex',worktrees:[] };
// reset environment overrides
afterEach(() => { vi.unstubAllEnvs(); });
describe('HTTP security boundary',()=>{let app:Awaited<ReturnType<typeof buildApp>>;afterEach(async()=>{await app?.close()});it('serves the browser application and its build version for the canonical host',async()=>{const hash=await argon2.hash('synthetic-password',{type:argon2.argon2id});app=await buildApp(config,{auth:new AuthService(hash,Buffer.alloc(32,2).toString('base64url'))});const response=await app.inject({method:'GET',url:'/',headers:{host:'agents.example.com'}});expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('text/html');expect(response.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');expect(response.body).toContain('<!doctype html>');const version=await app.inject({method:'GET',url:'/api/ui-version',headers:{host:'agents.example.com'}});expect(version.statusCode).toBe(200);expect(version.json().version).toMatch(/^\/assets\/index-[\w-]+\.js$/)}, 15_000);it('requires canonical Host and Origin and creates a secure host cookie',async()=>{const hash=await argon2.hash('synthetic-password',{type:argon2.argon2id});app=await buildApp(config,{auth:new AuthService(hash,Buffer.alloc(32,2).toString('base64url'))});const bad=await app.inject({method:'GET',url:'/api/auth/bootstrap',headers:{host:'evil.example'}});expect(bad.statusCode).toBe(403);const boot=await app.inject({method:'GET',url:'/api/auth/bootstrap',headers:{host:'agents.example.com'}});const token=boot.json().csrfToken;const denied=await app.inject({method:'POST',url:'/api/auth/login',headers:{host:'agents.example.com','x-csrf-token':token},payload:{password:'synthetic-password'}});expect(denied.statusCode).toBe(403);const ok=await app.inject({method:'POST',url:'/api/auth/login',headers:{host:'agents.example.com',origin:'https://agents.example.com','x-csrf-token':token},payload:{password:'synthetic-password'}});expect(ok.statusCode).toBe(200);expect(ok.headers['set-cookie']).toContain('__Host-rac=');expect(ok.headers['set-cookie']).toContain('HttpOnly');expect(ok.headers['set-cookie']).toContain('Secure');expect(ok.headers['content-security-policy']).toContain("default-src 'self'")}, 15_000)});

describe('server identity API', () => {
  // verify authentication never waits for peers
  it('keeps authentication independent of stalled remote status checks', async () => {
    const namedConfig = { ...config, publicOrigin: new URL('https://x1carbon.santosa.dev'), remoteServers: [{ url: new URL('https://framework.santosa.dev') }] };
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    // hold peer discovery indefinitely
    const instanceStatusPoller = { statuses: () => new Promise<never>(() => {}) };
    const identityApp = await buildApp(namedConfig, { auth: new AuthService(hash, Buffer.alloc(32, 20).toString('base64url')), instanceStatusPoller });
    // close the isolated app after assertions
    try {
      const bootstrap = await identityApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'x1carbon.santosa.dev' } });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json().server.remotes).toEqual([{ name: 'framework.santosa.dev', url: 'https://framework.santosa.dev' }]);
      const login = await identityApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'x1carbon.santosa.dev', origin: 'https://x1carbon.santosa.dev', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
      expect(login.statusCode).toBe(200);
      expect(login.json().server.remotes).toEqual([{ name: 'framework.santosa.dev', url: 'https://framework.santosa.dev' }]);
    } finally {
      await identityApp.close();
    }
  }, 15_000);

  // verify peer metadata refreshes through status polling
  it('publishes local and remote server choices before login and in sessions', async () => {
    const namedConfig = { ...config, name: 'X1 Carbon', icon: 'potato' as const, publicOrigin: new URL('https://x1carbon.santosa.dev'), remoteServers: [{ url: new URL('https://framework.santosa.dev') }] };
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const statusSecret = 'shared-status-secret-with-thirty-two-bytes';
    vi.stubEnv('RAC_INSTANCE_STATUS_SECRET', statusSecret);
    const instanceStatusPoller = { statuses: async () => [{ url: 'https://framework.santosa.dev', name: 'Framework', icon: 'heart' as const, attention: 'idle' as const }] };
    // avoid host discovery in identity test
    const discovery = { dashboard: async () => ({ generation: 1, agents: [], worktrees: [] }) };
    const identityApp = await buildApp(namedConfig, { auth: new AuthService(hash, Buffer.alloc(32, 16).toString('base64url')), instanceStatusPoller, discovery: discovery as never });
    // close the isolated app after assertions
    try {
      const bootstrap = await identityApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'x1carbon.santosa.dev' } });
      const expected = { name: 'X1 Carbon', icon: 'potato', url: 'https://x1carbon.santosa.dev', remotes: [{ name: 'Framework', icon: 'heart', url: 'https://framework.santosa.dev' }] };
      expect(bootstrap.json().server).toMatchObject({ name: expected.name, icon: expected.icon, url: expected.url, remotes: [{ url: expected.remotes[0].url }] });
      const login = await identityApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'x1carbon.santosa.dev', origin: 'https://x1carbon.santosa.dev', 'x-csrf-token': bootstrap.json().csrfToken }, payload: { password: 'synthetic-password' } });
      expect(login.statusCode).toBe(200);
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const statuses = await identityApp.inject({ method: 'GET', url: '/api/server-statuses', headers: { host: 'x1carbon.santosa.dev', cookie } });
      expect(statuses.json().servers).toEqual([{ name: 'X1 Carbon', icon: 'potato', url: 'https://x1carbon.santosa.dev', attention: 'idle' }, { name: 'Framework', icon: 'heart', url: 'https://framework.santosa.dev', attention: 'idle' }]);
      const current = await identityApp.inject({ method: 'GET', url: '/api/auth/session', headers: { host: 'x1carbon.santosa.dev', cookie } });
      expect(current.json().server).toEqual(expected);
      const timestamp = String(Date.now());
      const signature = createHmac('sha256', statusSecret).update(`rac-instance-status-v1\n${namedConfig.publicOrigin.origin}\n${timestamp}`).digest('base64url');
      const published = await identityApp.inject({ method: 'GET', url: '/api/instance-status', headers: { host: 'x1carbon.santosa.dev', 'x-rac-status-timestamp': timestamp, 'x-rac-status-signature': signature } });
      expect(published.json()).toMatchObject({ name: 'X1 Carbon', icon: 'potato', attention: 'idle' });
    } finally { await identityApp.close(); }
  }, 15_000);
});

describe('server administration API', () => {
  it('renames and updates only from the controlling browser', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const renamed: string[] = [];
    const targetSha = '2'.repeat(40);
    const reviewedPreview = { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [{ sha: targetSha, subject: 'Update server', author: 'Ansel', authoredAt: '2026-08-27T12:00:00-07:00' }], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] as Array<{ kind: 'config'; paths: string[] }> } };
    let preview = reviewedPreview;
    const startUpdate = vi.fn(async () => ({ id: 'server_update_operation_1234', kind: 'update' as const, state: 'queued' as const, targetSha }));
    const serverAdmin = {
      renameServer: async (name: string) => { renamed.push(name); return name.trim() || undefined; },
      startUpdate,
      updateStatus: async (id: string) => id === 'server_update_operation_1234' ? ({ id, kind: 'update' as const, state: 'running' as const, targetSha }) : undefined,
      // expose fetched upstream state
      updateAvailable: async () => true,
      updatePreview: async () => preview
    };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 19).toString('base64url')), serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const rename = await adminApp.inject({ method: 'PATCH', url: '/api/server/name', headers, payload: { name: 'Garage Server' } });
      const update = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers, payload: { expectedTargetSha: targetSha } });
      const status = await adminApp.inject({ method: 'GET', url: '/api/server/update/server_update_operation_1234', headers: { host: headers.host, cookie: headers.cookie } });
      const availability = await adminApp.inject({ method: 'GET', url: '/api/server/update-available', headers: { host: headers.host, cookie: headers.cookie } });
      const updatePreview = await adminApp.inject({ method: 'GET', url: '/api/server/update-preview', headers: { host: headers.host, cookie: headers.cookie } });
      // require explicit advisor acknowledgement for flagged previews
      preview = { ...preview, advisory: { required: true, reasons: [{ kind: 'config', paths: ['.env.example'] }] } };
      const unacknowledgedUpdate = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers, payload: { expectedTargetSha: targetSha } });

      expect(rename.json()).toMatchObject({ name: 'Garage Server', server: { name: 'Garage Server' } });
      expect(renamed).toEqual(['Garage Server']);
      expect(update.statusCode).toBe(202);
      expect(update.json()).toMatchObject({ state: 'queued' });
      expect(startUpdate).toHaveBeenCalledWith(targetSha);
      expect(status.json()).toMatchObject({ state: 'running' });
      expect(availability.json()).toEqual({ available: true });
      expect(updatePreview.json()).toEqual(reviewedPreview);
      expect(unacknowledgedUpdate.statusCode).toBe(409);
    } finally {
      await adminApp.close();
    }
  }, 15_000);

  it('requires the exact reviewed upstream target', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const targetSha = '2'.repeat(40);
    const preview = { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } };
    const startUpdate = vi.fn();
    const serverAdmin = { updatePreview: async () => preview, startUpdate, updateAvailable: async () => true };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 21).toString('base64url')), serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const missing = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers });
      const stale = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers, payload: { expectedTargetSha: '3'.repeat(40) } });

      expect(missing.statusCode).toBe(400);
      expect(stale.statusCode).toBe(409);
      expect(startUpdate).not.toHaveBeenCalled();
    } finally { await adminApp.close(); }
  }, 15_000);

  it('retries the reviewed rebuild after Git already reached its target', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const targetSha = '2'.repeat(40);
    const preview = { available: false, rebuildRetryAvailable: true, baseSha: targetSha, targetSha, fastForwardable: true, commitCount: 0, commits: [], commitsTruncated: false, filesTruncated: false, advisory: { required: false, reasons: [] } };
    const startUpdate = vi.fn(async () => ({ id: 'server_update_retry_123456', kind: 'update' as const, state: 'queued' as const, targetSha }));
    const serverAdmin = { updatePreview: async () => preview, startUpdate, updateAvailable: async () => false };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 22).toString('base64url')), serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const retry = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers, payload: { expectedTargetSha: targetSha } });

      expect(retry.statusCode).toBe(202);
      expect(startUpdate).toHaveBeenCalledWith(targetSha);
    } finally { await adminApp.close(); }
  }, 15_000);

  it('launches, reuses, and cleans one target-pinned update advisor', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const directory = await mkdtemp(join(tmpdir(), 'rac-update-advisor-api-'));
    const targetSha = '2'.repeat(40);
    const advisorId = 'update-advisor';
    const socket = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const pendingAgent = stated({ id: advisorId, paneId: '%8', sessionId: 'socket:$8', socketFingerprint: 'socket', workspace: '/host/repo', displayLabel: 'Update Advisor Starting v4 2222222', title: 'Ready' });
    const readyAgent = { ...pendingAgent, displayLabel: 'Update Advisor v4 2222222' };
    const oldAgent = { ...pendingAgent, id: 'old-update-advisor', paneId: '%7', sessionId: 'socket:$7' };
    const preview = { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [], commitsTruncated: false, filesTruncated: false, advisory: { required: true, reasons: [{ kind: 'config', paths: ['.env.example'] }] } };
    let activeTarget: string | undefined;
    let launched = false;
    let advisorReady = false;
    let advisorStarted = false;
    let advisorClosed = false;
    let oldAdvisorClosed = false;
    let blockAdvisorClose = false;
    let signalAdvisorCloseStarted = () => {};
    let advisorCloseGate = Promise.resolve();
    const discovery = {
      dashboard: async () => ({ generation: launched ? 2 : 1, agents: [...(oldAdvisorClosed ? [] : [oldAgent]), ...(launched && !advisorClosed ? [stated({ ...(advisorReady ? readyAgent : pendingAgent), title: advisorStarted ? '⠋ Reviewing' : 'Ready' })] : [])], worktrees: [] }),
      target: async (id: string) => launched && !advisorClosed && id === advisorId ? { agent: stated({ ...(advisorReady ? readyAgent : pendingAgent), title: advisorStarted ? '⠋ Reviewing' : 'Ready' }), socket } : !oldAdvisorClosed && id === oldAgent.id ? { agent: oldAgent, socket } : undefined
    };
    const launch = { launchUpdateAdvisor: vi.fn(async () => { launched = true; advisorReady = false; advisorStarted = false; advisorClosed = false; return true; }) };
    const tmux = { pastePrompt: vi.fn(async () => true), capture: vi.fn(async () => '› Inspect the fixed committed range without changing it. '), sendKeys: vi.fn(async (_socket: unknown, _pane: string, keys: string[]) => { if (keys.includes('Enter')) advisorStarted = true; return true; }), label: vi.fn(async () => { advisorReady = true; return true; }), close: vi.fn(async (_socket: unknown, paneId: string) => {
      // close interrupted launches immediately
      if (paneId === oldAgent.paneId) oldAdvisorClosed = true;
      // optionally hold one modal-close race
      if (paneId === readyAgent.paneId) {
        signalAdvisorCloseStarted();
        if (blockAdvisorClose) await advisorCloseGate;
        advisorClosed = true;
      }
      return true;
    }) };
    const serverAdmin = {
      updatePreview: async () => preview,
      updateAdvisor: () => ({ repository: '/host/repo', prompt: 'Inspect the fixed committed range without changing it.' }),
      updateAvailable: async () => true,
      activeUpdateTarget: async () => activeTarget,
      startUpdate: async () => ({ id: 'server_update_advisor_1234', kind: 'update' as const, state: 'queued' as const, targetSha }),
      updateStatus: async () => ({ id: 'server_update_advisor_1234', kind: 'update' as const, state: 'complete' as const, targetSha })
    };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 23).toString('base64url')), discovery: discovery as never, launch: launch as never, tmux: tmux as never, serverAdmin: serverAdmin as never, queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')) });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      // reopen the modal beyond the former route limit
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const advisor = await adminApp.inject({ method: 'POST', url: '/api/server/update-advisor', headers, payload: { targetSha } });
        expect(advisor.statusCode).toBe(201);
        expect(advisor.json()).toEqual({ agentId: advisorId, targetSha });
      }
      expect(tmux.close).toHaveBeenCalledWith(socket, oldAgent.paneId);
      expect(tmux.close).not.toHaveBeenCalledWith(socket, readyAgent.paneId);
      let releaseAdvisorClose = () => {};
      const advisorCloseStarted = new Promise<void>(resolve => { signalAdvisorCloseStarted = resolve; });
      advisorCloseGate = new Promise<void>(resolve => { releaseAdvisorClose = resolve; });
      blockAdvisorClose = true;
      const racingClose = adminApp.inject({ method: 'DELETE', url: '/api/server/update-advisor', headers, payload: { targetSha } });
      await advisorCloseStarted;
      const racingReopen = adminApp.inject({ method: 'POST', url: '/api/server/update-advisor', headers, payload: { targetSha } });
      blockAdvisorClose = false;
      releaseAdvisorClose();
      expect((await racingClose).statusCode).toBe(204);
      expect((await racingReopen).statusCode).toBe(201);
      expect(advisorClosed).toBe(false);
      expect(launch.launchUpdateAdvisor).toHaveBeenCalledTimes(2);
      activeTarget = targetSha;
      const activeClose = await adminApp.inject({ method: 'DELETE', url: '/api/server/update-advisor', headers, payload: { targetSha } });
      expect(activeClose.statusCode).toBe(409);
      expect(advisorClosed).toBe(false);
      activeTarget = undefined;
      const closeAdvisor = await adminApp.inject({ method: 'DELETE', url: '/api/server/update-advisor', headers, payload: { targetSha } });
      expect(closeAdvisor.statusCode).toBe(204);
      expect(tmux.close).toHaveBeenCalledWith(socket, readyAgent.paneId);
      const update = await adminApp.inject({ method: 'POST', url: '/api/server/update', headers, payload: { expectedTargetSha: targetSha, advisoryAcknowledged: true } });
      expect(update.statusCode).toBe(202);
      const status = await adminApp.inject({ method: 'GET', url: '/api/server/update/server_update_advisor_1234', headers: { host: headers.host, cookie: headers.cookie } });

      expect(status.statusCode).toBe(200);
      expect(launch.launchUpdateAdvisor).toHaveBeenCalledTimes(2);
      expect(launch.launchUpdateAdvisor).toHaveBeenCalledWith('/host/repo', targetSha);
      expect(tmux.pastePrompt).toHaveBeenCalledTimes(2);
      expect(tmux.sendKeys).toHaveBeenCalledTimes(2);
      expect(tmux.sendKeys).toHaveBeenCalledWith(socket, pendingAgent.paneId, ['Enter']);
      // the advisor is submitted with Enter, never Codex's Tab queue key
      expect(tmux.sendKeys.mock.calls.every(call => !(call[2] as string[]).includes('Tab'))).toBe(true);
      expect(tmux.label).toHaveBeenCalledWith(socket, pendingAgent.paneId, readyAgent.displayLabel);
      expect(tmux.close).toHaveBeenCalledWith(socket, readyAgent.paneId);
    } finally { await adminApp.close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);

  it('closes a legacy advisor recovered after an update restart', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const targetSha = '2'.repeat(40);
    const socket = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const legacy = stated({ id: 'legacy-advisor', paneId: '%7', sessionId: 'socket:$7', socketFingerprint: 'socket', workspace: '/host/repo', displayLabel: 'Update Advisor 2222222', title: 'Ready' });
    let closed = false;
    let dashboardFails = false;
    const discovery = {
      dashboard: async () => { if (dashboardFails) throw new Error('tmux unavailable'); return { generation: 1, agents: closed ? [] : [legacy], worktrees: [] }; },
      target: async (id: string) => !closed && id === legacy.id ? { agent: legacy, socket } : undefined
    };
    const tmux = { close: vi.fn(async () => { closed = true; return true; }) };
    const serverAdmin = { updateStatus: async () => ({ id: 'server_update_advisor_1234', kind: 'update' as const, state: 'complete' as const, targetSha }), updateAvailable: async () => false, activeUpdateTarget: async () => undefined };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 25).toString('base64url')), discovery: discovery as never, tmux: tmux as never, serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const status = await adminApp.inject({ method: 'GET', url: '/api/server/update/server_update_advisor_1234', headers });

      expect(status.statusCode).toBe(200);
      expect(tmux.close).toHaveBeenCalledWith(socket, legacy.paneId);
      dashboardFails = true;
      const failedCleanup = await adminApp.inject({ method: 'DELETE', url: '/api/server/update-advisor', headers, payload: { targetSha } });
      expect(failedCleanup.statusCode).toBe(503);
    } finally { await adminApp.close(); }
  }, 15_000);

  it('keeps only the newest same-target update advisor', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const targetSha = '2'.repeat(40);
    const socket = { fingerprint: 'socket', path: '/host-tmux/default', device: 1, inode: 2 };
    const older = stated({ id: 'older-advisor', paneId: '%8', sessionId: 'socket:$8', socketFingerprint: 'socket', workspace: '/host/repo', displayLabel: 'Update Advisor v4 2222222', title: 'Framework' });
    const newer = { ...older, id: 'newer-advisor', paneId: '%9', sessionId: 'socket:$9', title: 'remoteagents' };
    let olderClosed = false;
    const discovery = {
      dashboard: async () => ({ generation: 1, agents: [...(olderClosed ? [] : [older]), newer], worktrees: [] }),
      target: async (id: string) => id === newer.id ? { agent: newer, socket } : !olderClosed && id === older.id ? { agent: older, socket } : undefined
    };
    const launch = { launchUpdateAdvisor: vi.fn(async () => true) };
    const tmux = { pastePrompt: vi.fn(async () => true), queue: vi.fn(async () => true), close: vi.fn(async (_socket: unknown, paneId: string) => { if (paneId === older.paneId) olderClosed = true; return true; }) };
    const preview = { available: true, rebuildRetryAvailable: false, baseSha: '1'.repeat(40), targetSha, fastForwardable: true, commitCount: 1, commits: [], commitsTruncated: false, filesTruncated: false, advisory: { required: true, reasons: [{ kind: 'config', paths: ['.env.example'] }] } };
    const serverAdmin = { updatePreview: async () => preview, updateAdvisor: () => ({ repository: '/host/repo', prompt: 'Inspect the fixed committed range without changing it.' }), updateAvailable: async () => true, activeUpdateTarget: async () => undefined };
    const adminApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 24).toString('base64url')), discovery: discovery as never, launch: launch as never, tmux: tmux as never, serverAdmin: serverAdmin as never });
    try {
      const boot = await adminApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await adminApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const advisor = await adminApp.inject({ method: 'POST', url: '/api/server/update-advisor', headers, payload: { targetSha } });

      expect(advisor.statusCode).toBe(201);
      expect(advisor.json()).toEqual({ agentId: newer.id, targetSha });
      expect(tmux.close).toHaveBeenCalledWith(socket, older.paneId);
      expect(tmux.close).not.toHaveBeenCalledWith(socket, newer.paneId);
      expect(launch.launchUpdateAdvisor).not.toHaveBeenCalled();
      expect(tmux.pastePrompt).not.toHaveBeenCalled();
    } finally { await adminApp.close(); }
  }, 15_000);
});

describe('project browser security boundary', () => {
  it('limits iframe sources to configured project origins', async () => {
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex', projectUrl: 'https://project.example.com' };
    const app = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService('$argon2id$unused', Buffer.alloc(32, 13).toString('base64url')) });
    try {
      const response = await app.inject({ method: 'GET', url: '/', headers: { host: 'agents.example.com' } });
      expect(response.headers['content-security-policy']).toContain("frame-src 'self' https://project.example.com");
      expect(response.headers['content-security-policy']).not.toContain('evil.example.com');
    } finally { await app.close(); }
  });
});

describe('client control', () => {
  it('automatically activates the first client and lets another client take control', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const names = new Map<string, string>();
    const devices = {
      get: async (sessionId: string) => names.get(sessionId),
      set: async (sessionId: string, name: string) => {
        const normalized = name.trim();
        if (!normalized) return undefined;
        names.set(sessionId, normalized);
        return normalized;
      }
    };
    const controlApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 5).toString('base64url')), devices: devices as never });
    const login = async () => {
      const boot = await controlApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const response = await controlApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      return { response, cookie: String(response.headers['set-cookie']).split(';')[0] };
    };
    const first = await login();
    const firstHeaders = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: first.cookie, 'x-csrf-token': first.response.json().csrfToken };
    const unnamedFirst = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: firstHeaders });
    const namedFirst = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: firstHeaders, payload: { deviceName: 'Studio Mac' } });
    const second = await login();
    expect(first.response.json().active).toBe(true);
    expect(first.response.json().deviceName).toBeUndefined();
    expect(unnamedFirst.statusCode).toBe(400);
    expect(namedFirst.json()).toMatchObject({ active: true, deviceName: 'Studio Mac', controllingDeviceName: 'Studio Mac' });
    const invalidRename = await controlApp.inject({ method: 'PATCH', url: '/api/auth/device-name', headers: firstHeaders, payload: { deviceName: '   ' } });
    const renamedFirst = await controlApp.inject({ method: 'PATCH', url: '/api/auth/device-name', headers: firstHeaders, payload: { deviceName: 'Studio Display' } });
    expect(invalidRename.statusCode).toBe(400);
    expect(renamedFirst.json()).toMatchObject({ active: true, deviceName: 'Studio Display', controllingDeviceName: 'Studio Display' });
    const dashboardTicket = await controlApp.inject({ method: 'POST', url: '/api/dashboard/ticket', headers: firstHeaders });
    expect(dashboardTicket.statusCode).toBe(200);
    expect(dashboardTicket.json().ticket).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(second.response.json().active).toBe(false);
    expect(second.response.json().controllingDeviceName).toBe('Studio Mac');
    const secondHeaders = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: second.cookie, 'x-csrf-token': second.response.json().csrfToken };
    const blocked = await controlApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: second.cookie } });
    const blockedTicket = await controlApp.inject({ method: 'POST', url: '/api/dashboard/ticket', headers: secondHeaders });
    expect(blocked.statusCode).toBe(423);
    expect(blockedTicket.statusCode).toBe(423);
    const unnamedSecond = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: secondHeaders });
    const take = await controlApp.inject({ method: 'POST', url: '/api/auth/take-control', headers: secondHeaders, payload: { deviceName: 'Kitchen iPad' } });
    expect(unnamedSecond.statusCode).toBe(400);
    expect(take.json()).toMatchObject({ active: true, deviceName: 'Kitchen iPad', controllingDeviceName: 'Kitchen iPad' });
    const displaced = await controlApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: first.cookie } });
    const displacedSession = await controlApp.inject({ method: 'GET', url: '/api/auth/session', headers: { host: 'agents.example.com', cookie: first.cookie } });
    expect(displaced.statusCode).toBe(423);
    expect(displacedSession.json()).toMatchObject({ active: false, deviceName: 'Studio Display', controllingDeviceName: 'Kitchen iPad' });
    await controlApp.close();
  }, 15_000);

  it('registers every authenticated client without pushing silent notification dismissals', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const subscribed: unknown[] = [];
    const messages: unknown[] = [];
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const push = { enabled: true, publicKey: 'public-key', subscribe: async (subscription: unknown) => { subscribed.push(subscription); return true; }, notify: async (message: unknown) => { messages.push(message); } };
    const notifications = new AgentNotificationCoordinator(() => {}, 0);
    notifications.observe(stated({ ...agent, title: '⠋ Working' }));
    notifications.observe(agent);
    await new Promise(resolve => setTimeout(resolve, 0));
    const discovery = { target: async (id: string) => id === agent.id ? { agent, socket } : undefined, dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [] }) };
    const pushApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 6).toString('base64url')), discovery: discovery as never, push: push as never, notifications });
    const login = async () => {
      const boot = await pushApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const response = await pushApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      return { response, cookie: String(response.headers['set-cookie']).split(';')[0] };
    };
    const active = await login();
    const inactive = await login();
    expect(inactive.response.json().active).toBe(false);
    const key = await pushApp.inject({ method: 'GET', url: '/api/push/public-key', headers: { host: 'agents.example.com', cookie: inactive.cookie } });
    expect(key.json()).toEqual({ publicKey: 'public-key' });
    const registration = await pushApp.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: inactive.cookie, 'x-csrf-token': inactive.response.json().csrfToken }, payload: { endpoint: 'https://push.example.com/subscription', keys: { p256dh: 'key', auth: 'auth' } } });
    const unreadDashboard = await pushApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: active.cookie } });
    const dismissal = await pushApp.inject({ method: 'POST', url: `/api/agents/${encodeURIComponent(agent.id)}/notifications/dismiss`, headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: active.cookie, 'x-csrf-token': active.response.json().csrfToken } });
    const viewedDashboard = await pushApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: active.cookie } });
    expect(registration.statusCode).toBe(204);
    expect(subscribed).toHaveLength(1);
    expect(unreadDashboard.json().agents[0].unread).toBe(true);
    expect(dismissal.statusCode).toBe(204);
    expect(viewedDashboard.json().agents[0].unread).toBe(false);
    expect(messages).toEqual([]);
    notifications.stop();
    await pushApp.close();
  }, 15_000);
});

describe('agent launches', () => {
  it('waits for a discovered Codex pane and returns its id to the client', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu', title: '' });
    let dashboards = 0;
    const discovery = { dashboard: async () => ({ generation: ++dashboards, agents: dashboards === 1 ? [] : [agent], worktrees: [] }) };
    const launch = { launch: async () => true, launchHome: async () => true };
    const launchApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 3).toString('base64url')), discovery: discovery as never, launch: launch as never });
    try {
      const boot = await launchApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await launchApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const response = await launchApp.inject({ method: 'POST', url: '/api/agents/launch', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie, 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: agent.id });
    } finally { await launchApp.close(); }
  }, 15_000);

  it('waits beyond twenty seconds for the requested worktree agent', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = stated({ id: 'socket:%2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: '', worktreeId: 'cora' });
    let dashboards = 0;
    // reveal after the old timeout
    const discovery = { dashboard: async () => ({ generation: ++dashboards, agents: dashboards < 83 ? [] : [agent], worktrees: [] }) };
    const launch = { launch: async (id: string) => id === 'cora', launchHome: async () => true };
    // skip real poll delays
    const skipLaunchPollDelay = async () => {};
    const launchApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 4).toString('base64url')), discovery: discovery as never, launch: launch as never, launchPollDelay: skipLaunchPollDelay });
    try {
      const boot = await launchApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await launchApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const response = await launchApp.inject({ method: 'POST', url: '/api/worktrees/cora/launch', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie, 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ agentId: agent.id });
      expect(dashboards).toBe(83);
    } finally { await launchApp.close(); }
  }, 15_000);
});

describe('pull request switch API', () => {
  // preserve lookup failures across the HTTP boundary
  it('returns an actionable gateway error when GitHub lookup fails', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const prSwitch = { available: async () => { throw new PullRequestLookupError('GitHub could not load pull requests (503).'); } };
    const pullRequestApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 17).toString('base64url')), prSwitch: prSwitch as never });
    try {
      const boot = await pullRequestApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await pullRequestApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const response = await pullRequestApp.inject({ method: 'GET', url: '/api/agents/agent-1/switch-prs', headers: { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] } });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: 'GitHub could not load pull requests (503).' });
    } finally { await pullRequestApp.close(); }
  }, 15_000);

  it('moves an occupied pull request through the controlled HTTP boundary', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const move = vi.fn<() => Promise<'moved' | 'recovery-required'>>().mockResolvedValueOnce('moved').mockResolvedValueOnce('recovery-required');
    const prSwitch = { move };
    const pullRequestApp = await buildApp(config, { auth: new AuthService(hash, Buffer.alloc(32, 18).toString('base64url')), prSwitch: prSwitch as never });
    try {
      const boot = await pullRequestApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await pullRequestApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const response = await pullRequestApp.inject({ method: 'POST', url: '/api/agents/agent-1/move-pr', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken }, payload: { number: 301 } });
      const recovery = await pullRequestApp.inject({ method: 'POST', url: '/api/agents/agent-1/move-pr', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken }, payload: { number: 302 } });

      expect(response.statusCode).toBe(202);
      expect(move).toHaveBeenCalledWith('agent-1', 301);
      expect(recovery.statusCode).toBe(409);
      expect(recovery.json()).toMatchObject({ recoveryRequired: true, error: expect.any(String) });
    } finally {
      await pullRequestApp.close();
    }
  }, 15_000);
});

describe('configured worktree deactivation', () => {
  it('closes an idle configured agent so its worktree becomes inactive', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' });
    let closed = false;
    const deactivateApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 7).toString('base64url')), discovery: { target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined } as never, tmux: { close: async () => { closed = true; return true; } } as never });
    try {
      const boot = await deactivateApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await deactivateApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const response = await deactivateApp.inject({ method: 'POST', url: '/api/agents/agent-1/deactivate', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken } });
      expect(response.statusCode).toBe(204);
      expect(closed).toBe(true);
    } finally { await deactivateApp.close(); }
  }, 15_000);

  it('sleeps, wakes, and turns off a retained worktree tab', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex' };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let active = true;
    let resumed = '';
    const discovery = {
      // expose the current process state
      dashboard: async () => active
        ? { generation: 1, agents: [agent], worktrees: [] }
        : { generation: 2, agents: [], worktrees: [{ id: worktree.id, label: worktree.label, path: worktree.path, available: true, pinned: false, order: 0 }] },
      // resolve only the live agent
      target: async (id: string) => active && id === agent.id ? { agent, socket } : undefined
    };
    const launch = {
      // wake through the requested alias
      resume: async (id: string) => { resumed = id; active = true; return true; },
      launch: async () => false,
      launchHome: async () => false
    };
    const sleepApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 21).toString('base64url')), discovery: discovery as never, launch: launch as never, tmux: { close: async () => { active = false; return true; } } as never, launchPollDelay: async () => {} });
    try {
      const boot = await sleepApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await sleepApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const slept = await sleepApp.inject({ method: 'POST', url: '/api/agents/agent-1/sleep', headers });
      expect(slept.statusCode).toBe(204);
      const sleepingDashboard = await sleepApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });
      expect(sleepingDashboard.json().worktrees).toEqual([expect.objectContaining({ id: 'cora', sleeping: true })]);

      const woke = await sleepApp.inject({ method: 'POST', url: '/api/worktrees/cora/wake', headers });
      expect(woke.statusCode).toBe(201);
      expect(woke.json()).toEqual({ agentId: agent.id });
      expect(resumed).toBe('cora');

      // retain the tab again for shutdown
      const sleptAgain = await sleepApp.inject({ method: 'POST', url: '/api/agents/agent-1/sleep', headers });
      expect(sleptAgain.statusCode).toBe(204);
      const turnedOff = await sleepApp.inject({ method: 'POST', url: '/api/worktrees/cora/deactivate', headers });
      expect(turnedOff.statusCode).toBe(204);
      const inactiveDashboard = await sleepApp.inject({ method: 'GET', url: '/api/dashboard', headers: { host: headers.host, cookie: headers.cookie } });
      expect(inactiveDashboard.json().worktrees).toEqual([expect.objectContaining({ id: 'cora' })]);
      expect(inactiveDashboard.json().worktrees[0].sleeping).toBeUndefined();

      // reject wake after permanent shutdown
      const wakeAfterTurnOff = await sleepApp.inject({ method: 'POST', url: '/api/worktrees/cora/wake', headers });
      expect(wakeAfterTurnOff.statusCode).toBe(409);
    } finally { await sleepApp.close(); }
  }, 15_000);

  it('closes an idle agent before restarting it through the resume alias', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-restart-agent-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex' };
    const firstAgent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready', worktreeId: 'cora' });
    const secondAgent = { ...firstAgent, id: 'agent-2', paneId: '%2', sessionId: 'socket:$2' };
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const events: string[] = [];
    let resumed = false;
    let pollsAfterResume = 0;
    const discovery = {
      // expose one stale frame before the replacement
      dashboard: async () => {
        // retain the original agent before resume
        if (!resumed) return { generation: 1, agents: [firstAgent], worktrees: [] };
        pollsAfterResume += 1;
        return { generation: pollsAfterResume === 1 ? 1 : 2, agents: [pollsAfterResume === 1 ? firstAgent : secondAgent], worktrees: [] };
      },
      // resolve the original restart target
      target: async (id: string) => id === firstAgent.id ? { agent: firstAgent, socket } : undefined
    };
    const launch = {
      launch: async () => false,
      launchHome: async () => false,
      // record the host alias handoff
      resume: async (id: string) => { events.push(`resume:${id}`); resumed = true; return true; }
    };
    const restartApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 22).toString('base64url')), discovery: discovery as never, launch: launch as never, tmux: { close: async () => { events.push(`close:${firstAgent.id}`); return true; } } as never, queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')), launchPollDelay: async () => {} });
    try {
      const boot = await restartApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await restartApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const restarted = await restartApp.inject({ method: 'POST', url: '/api/agents/agent-1/restart', headers });

      expect(restarted.statusCode).toBe(201);
      expect(restarted.json()).toEqual({ agentId: 'agent-2' });
      expect(events).toEqual(['close:agent-1', 'resume:cora']);
    } finally { await restartApp.close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);
});

describe('agent terminal swap', () => {
  it('backgrounds the agent for terminal mode and foregrounds it when returning', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const suspended: Array<{ pane: string; path: string }> = [];
    const foregrounded: Array<{ pane: string; path: string }> = [];
    const swapApp = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 8).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined } as never,
      tmux: {
        suspend: async (targetSocket: typeof socket, pane: string) => { suspended.push({ pane, path: targetSocket.path }); return true; },
        foreground: async (targetSocket: typeof socket, pane: string) => { foregrounded.push({ pane, path: targetSocket.path }); return true; }
      } as never,
      prSwitch: { actionsUrl: async (id: string) => id === agent.id ? 'https://github.com/octo/repo/actions' : undefined } as never
    });
    try {
      const boot = await swapApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await swapApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const background = await swapApp.inject({ method: 'POST', url: `/api/agents/${agent.id}/background`, headers });
      const foreground = await swapApp.inject({ method: 'POST', url: `/api/agents/${agent.id}/foreground`, headers });
      const actions = await swapApp.inject({ method: 'GET', url: `/api/agents/${agent.id}/github-actions`, headers: { host: headers.host, cookie: headers.cookie } });

      expect(background.statusCode).toBe(204);
      expect(foreground.statusCode).toBe(204);
      expect(actions.json()).toEqual({ url: 'https://github.com/octo/repo/actions' });
      expect(suspended).toEqual([{ pane: '%1', path: '/tmp/tmux' }]);
      expect(foregrounded).toEqual([{ pane: '%1', path: '/tmp/tmux' }]);
    } finally { await swapApp.close(); }
  }, 15_000);
});

describe('guided review API boundary', () => {
  it('normalizes malformed and oversized requests while accepting the exact request shape', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const snapshot = { agentId: 'agent-1', worktreeId: 'cora', workspace: '/worktrees/cora', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'empty-fingerprint', changes: [] };
    let prepares = 0;
    const reviewTours = {
      capability: async () => ({ available: true }),
      prepare: async () => { prepares += 1; return { snapshot, resolved: {} }; },
      fingerprint: async () => ({ snapshot: { scope: 'working', base: 'HEAD', fingerprint: 'empty-fingerprint', includeTests: false, includeDocs: false }, empty: true })
    };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const pasted: string[] = [];
    const reviewApp = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 19).toString('base64url')),
      reviewTours: reviewTours as never,
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined } as never,
      tmux: { pastePrompt: async (_socket: typeof socket, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt); return true; }, sendKeys: async () => true } as never
    });
    try {
      const boot = await reviewApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await reviewApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken, 'content-type': 'application/json' };
      const malformed = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers, payload: '{"scope":' });
      const oversized = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false, padding: 'x'.repeat(1_100) }) });
      const unexpected = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false, unexpected: true }) });
      const idempotentHeaders = { ...headers, 'idempotency-key': 'review-start_1234567890' };
      const invalidRequestId = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers: { ...headers, 'idempotency-key': 'short' }, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false }) });
      const valid = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers: idempotentHeaders, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false }) });
      const replay = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/review-tour/jobs', headers: idempotentHeaders, payload: JSON.stringify({ scope: 'working', includeTests: false, includeDocs: false }) });
      const invalidFingerprint = await reviewApp.inject({ method: 'GET', url: '/api/agents/agent-1/review-tour/fingerprint?scope=working&includeTests=maybe&includeDocs=false', headers: { host: headers.host, cookie: headers.cookie } });
      const fingerprint = await reviewApp.inject({ method: 'GET', url: '/api/agents/agent-1/review-tour/fingerprint?scope=working&includeTests=false&includeDocs=false', headers: { host: headers.host, cookie: headers.cookie } });
      const maximumPrompt = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: JSON.stringify({ prompt: 'x'.repeat(32_000), attachments: [] }) });
      const oversizedPrompt = await reviewApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: JSON.stringify({ prompt: 'x'.repeat(32_001), attachments: [] }) });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(oversized.statusCode).toBe(400);
      expect(oversized.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(unexpected.statusCode).toBe(400);
      expect(unexpected.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(invalidRequestId.statusCode).toBe(400);
      expect(invalidRequestId.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ status: 'empty', snapshot: { scope: 'working', base: 'HEAD', fingerprint: 'empty-fingerprint', includeTests: false, includeDocs: false } });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(valid.json());
      expect(prepares).toBe(1);
      expect(invalidFingerprint.statusCode).toBe(400);
      expect(invalidFingerprint.json()).toEqual({ status: 'error', error: { code: 'invalid_request', retryable: false } });
      expect(fingerprint.statusCode).toBe(200);
      expect(fingerprint.json()).toEqual({ status: 'empty', snapshot: { scope: 'working', base: 'HEAD', fingerprint: 'empty-fingerprint', includeTests: false, includeDocs: false } });
      expect(maximumPrompt.statusCode).toBe(204);
      expect(oversizedPrompt.statusCode).toBe(400);
      expect(pasted).toHaveLength(1);
    } finally { await reviewApp.close(); }
  }, 15_000);

  it('serves and dismisses a branch-bound review from durable dashboard state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-review-tour-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex' };
    const review: ReviewTour = { title: 'Persisted tour', overview: 'Resume the saved walkthrough.', scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'persisted-fingerprint-1234', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1 +1 @@\n-old\n+new' }], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route delegates to the service.', changeIds: ['chg_route0001'] }] };
    const reviewStore = new ReviewTourStore(join(directory, 'reviews.json'));
    await reviewStore.save('cora', 'feature/review', review);
    const discovery = { dashboard: async () => ({ generation: 1, agents: [], worktrees: [{ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: false, order: 0, branch: 'feature/review' }] }) };
    const reviewApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 20).toString('base64url')), discovery: discovery as never, reviewStore, reviewTours: { capability: async () => ({ available: true }) } as never });
    try {
      const boot = await reviewApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await reviewApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0] };
      const mutationHeaders = { ...headers, origin: 'https://agents.example.com', 'x-csrf-token': login.json().csrfToken };
      const dashboard = await reviewApp.inject({ method: 'GET', url: '/api/dashboard', headers });
      const restored = await reviewApp.inject({ method: 'GET', url: '/api/worktrees/cora/review-tour', headers });
      const dismissed = await reviewApp.inject({ method: 'DELETE', url: '/api/worktrees/cora/review-tour', headers: mutationHeaders });
      const missing = await reviewApp.inject({ method: 'GET', url: '/api/worktrees/cora/review-tour', headers });
      expect(dashboard.json().reviews).toEqual([expect.objectContaining({ worktreeId: 'cora', branch: 'feature/review', title: review.title })]);
      expect(restored.json()).toMatchObject({ status: 'ready', review: { worktreeId: 'cora', branch: 'feature/review', tour: { fingerprint: review.fingerprint } } });
      expect(dismissed.statusCode).toBe(204);
      expect(missing.statusCode).toBe(404);
    } finally { await reviewApp.close(); await rm(directory, { recursive: true, force: true }); }
  }, 15_000);
});

describe('queued prompt API', () => {
  it('accepts a durable prompt when immediate agent acknowledgement is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-unacknowledged-prompt-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    let pasted = '';
    const queuedApp = await buildApp(config, {
      auth: new AuthService(hash, Buffer.alloc(32, 34).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      tmux: {
        pastePrompt: async (_socket: typeof socket, _pane: string, _buffer: string, prompt: string) => { pasted = prompt; return true; },
        capture: async () => `› ${pasted}`,
        // model a key accepted by tmux but ignored by Codex
        sendKeys: async () => true
      } as never
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const submitted = await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Retain this prompt', attachments: [] } });
      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });

      expect(submitted.statusCode).toBe(204);
      expect(listed.json().prompts).toMatchObject([{ text: 'Retain this prompt' }]);
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('lists, reorders, edits, and cancels prompts waiting behind a busy agent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-queued-prompt-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const queuedApp = await buildApp({ ...config, worktrees: [worktree] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 11).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json'))
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'First prompt', attachments: [] } });
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Second prompt', attachments: [] } });

      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const [first, second] = listed.json().prompts as Array<{ id: string; text: string }>;
      const moved = await queuedApp.inject({ method: 'POST', url: `/api/agents/agent-1/queued-prompts/${second!.id}/move`, headers, payload: { direction: 'earlier' } });
      const edited = await queuedApp.inject({ method: 'PUT', url: `/api/agents/agent-1/queued-prompts/${second!.id}`, headers, payload: { prompt: 'Edited second prompt' } });
      const cancelled = await queuedApp.inject({ method: 'DELETE', url: `/api/agents/agent-1/queued-prompts/${first!.id}`, headers });
      const remaining = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.statusCode).toBe(200);
      expect([first?.text, second?.text]).toEqual(['First prompt', 'Second prompt']);
      expect(moved.json().prompts.map((prompt: { id: string }) => prompt.id)).toEqual([second!.id, first!.id]);
      expect(edited.json()).toMatchObject({ id: second!.id, text: 'Edited second prompt' });
      expect(cancelled.statusCode).toBe(204);
      expect(remaining.json().prompts).toMatchObject([{ id: second!.id, text: 'Edited second prompt' }]);
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('moves a queued prompt and its attachments into saved prompts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-save-queued-prompt-api-'));
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: '⠋ Working' });
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const queuedApp = await buildApp({ ...config, worktrees: [worktree] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 12).toString('base64url')),
      discovery: { target: async (id: string) => id === agent.id ? { agent, socket } : undefined } as never,
      queuedPrompts: new QueuedPromptService(join(directory, 'queue.json')),
      savedPrompts: new SavedPromptService(join(directory, 'saved.json'))
    });
    try {
      const boot = await queuedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await queuedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      await queuedApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Save this prompt', attachments: [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }] } });
      const listed = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const [queued] = listed.json().prompts as Array<{ id: string }>;

      const saved = await queuedApp.inject({ method: 'POST', url: `/api/agents/agent-1/queued-prompts/${queued!.id}/save`, headers });
      const remaining = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/queued-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const savedPrompts = await queuedApp.inject({ method: 'GET', url: '/api/agents/agent-1/saved-prompts', headers: { host: headers.host, cookie: headers.cookie } });

      expect(saved.statusCode).toBe(201);
      expect(saved.json()).toMatchObject({ text: 'Save this prompt', attachments: [{ name: 'context.txt', size: 7 }] });
      expect(remaining.json()).toEqual({ prompts: [] });
      expect(savedPrompts.json()).toMatchObject({ prompts: [{ text: 'Save this prompt', attachments: [{ name: 'context.txt', size: 7 }] }] });
    } finally {
      await queuedApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('saved prompt API', () => {
  it('keeps prompts with a configured worktree when its agent pane changes', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agents = [
      stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' }),
      stated({ id: 'agent-2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' })
    ];
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const prompts = [{ id: 'saved-prompt-001', text: 'Review this change.' }];
    const keys: string[] = [];
    const queued: string[] = [];
    const savedPrompts = {
      list: async (key: string) => { keys.push(key); return key === 'worktree:cora' ? [...prompts] : undefined; },
      save: async (key: string, text: string, attachments: Array<{ name: string; data: string }>) => { keys.push(key); return key === 'worktree:cora' ? { id: 'saved-prompt-002', text, attachments: attachments.map(attachment => ({ name: attachment.name, size: Buffer.from(attachment.data, 'base64').length })) } : undefined; },
      get: async (key: string, promptId: string) => { keys.push(key); return key === 'worktree:cora' ? prompts.find(prompt => prompt.id === promptId) : undefined; },
      consumeOnSuccess: async (key: string, promptId: string, use: (prompt: { id: string; text: string }) => Promise<boolean>) => { keys.push(key); const prompt = key === 'worktree:cora' ? prompts.find(candidate => candidate.id === promptId) : undefined; return prompt === undefined ? 'missing' : await use(prompt) ? 'consumed' : 'failed'; },
      consume: async (key: string, promptId: string) => { keys.push(key); return key === 'worktree:cora' ? prompts.find(prompt => prompt.id === promptId) : undefined; }
    };
    const savedApp = await buildApp({ ...config, worktrees: [worktree] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 9).toString('base64url')),
      discovery: { target: async (id: string) => { const agent = agents.find(candidate => candidate.id === id); return agent === undefined ? undefined : { agent, socket }; } } as never,
      tmux: { pastePrompt: async (_socket: unknown, _paneId: string, _buffer: string, prompt: string) => { queued.push(prompt); return true; }, sendKeys: async () => true } as never,
      savedPrompts: savedPrompts as never
    });
    try {
      const boot = await savedApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await savedApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const listed = await savedApp.inject({ method: 'GET', url: '/api/agents/agent-2/saved-prompts', headers: { host: headers.host, cookie: headers.cookie } });
      const created = await savedApp.inject({ method: 'POST', url: '/api/agents/agent-1/saved-prompts', headers, payload: { prompt: 'Summarize this branch.', attachments: [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }] } });
      const queuedSaved = await savedApp.inject({ method: 'POST', url: '/api/agents/agent-2/saved-prompts/saved-prompt-001/queue', headers });
      const consumed = await savedApp.inject({ method: 'DELETE', url: '/api/agents/agent-1/saved-prompts/saved-prompt-001', headers });

      expect(listed.json()).toEqual({ prompts });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ id: 'saved-prompt-002', text: 'Summarize this branch.', attachments: [{ name: 'context.txt', size: 7 }] });
      expect(queuedSaved.statusCode).toBe(204);
      expect(queued).toEqual(['Review this change. ']);
      expect(consumed.json()).toEqual(prompts[0]);
      expect(keys).toEqual(['worktree:cora', 'worktree:cora', 'worktree:cora', 'worktree:cora']);
    } finally {
      await savedApp.close();
    }
  }, 15_000);
});

describe('prompt history API', () => {
  it('records and lists history by configured worktree when the agent pane changes', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agents = [
      stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' }),
      stated({ id: 'agent-2', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', workspace: '/worktrees/cora', title: 'Ready' })
    ];
    const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
    const stored: Array<{ id: string; text: string; createdAt: string }> = [];
    const keys: string[] = [];
    const promptHistory = {
      list: async (key: string) => { keys.push(`list:${key}`); return [...stored]; },
      record: async (key: string, text: string) => {
        keys.push(`record:${key}`);
        const entry = { id: 'prompt-history-001', text, createdAt: '2026-08-04T01:00:00.000Z' };
        stored.unshift(entry);
        return entry;
      }
    };
    const historyApp = await buildApp({ ...config, worktrees: [worktree] }, {
      auth: new AuthService(hash, Buffer.alloc(32, 10).toString('base64url')),
      discovery: { target: async (id: string) => { const agent = agents.find(candidate => candidate.id === id); return agent === undefined ? undefined : { agent, socket }; } } as never,
      tmux: { pastePrompt: async () => true, sendKeys: async () => true } as never,
      promptHistory: promptHistory as never
    });
    try {
      const boot = await historyApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await historyApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const queued = await historyApp.inject({ method: 'POST', url: '/api/agents/agent-1/prompt', headers, payload: { prompt: 'Review this branch.' } });
      const listed = await historyApp.inject({ method: 'GET', url: '/api/agents/agent-2/prompt-history', headers: { host: headers.host, cookie: headers.cookie } });

      expect(queued.statusCode).toBe(204);
      expect(listed.json()).toEqual({ prompts: stored });
      expect(keys).toEqual(['record:worktree:cora', 'list:worktree:cora']);
    } finally {
      await historyApp.close();
    }
  }, 15_000);
});

describe('worktree notes API', () => {
  it('lists, creates, updates, and deletes notes for the configured worktree', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', saveKey: 'potato', available: true, command: 'codex' };
    const stored: Array<{ id: string; text: string; title?: string }> = [{ id: 'note-identifier-001', text: 'Existing note' }];
    const keys: string[] = [];
    const notes = {
      list: async (key: string) => { keys.push(`list:${key}`); return [...stored]; },
      create: async (key: string, title?: string) => { keys.push(`create:${key}:${title ?? ''}`); const note = { id: 'note-identifier-002', text: '', ...(title === undefined ? {} : { title }) }; stored.unshift(note); return note; },
      update: async (key: string, noteId: string, text: string) => { keys.push(`update:${key}:${noteId}`); const note = stored.find(candidate => candidate.id === noteId); if (note === undefined) return undefined; note.text = text; return { ...note }; },
      rename: async (key: string, noteId: string, title: string) => { keys.push(`rename:${key}:${noteId}`); const note = stored.find(candidate => candidate.id === noteId); if (note === undefined) return undefined; note.title = title; return { ...note }; },
      delete: async (key: string, noteId: string) => { keys.push(`delete:${key}:${noteId}`); const index = stored.findIndex(candidate => candidate.id === noteId); return index < 0 ? undefined : stored.splice(index, 1)[0]; }
    };
    const notesApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 10).toString('base64url')), notes: notes as never });
    try {
      const boot = await notesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await notesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };

      const listed = await notesApp.inject({ method: 'GET', url: '/api/worktrees/cora/notes', headers: { host: headers.host, cookie: headers.cookie } });
      const created = await notesApp.inject({ method: 'POST', url: '/api/worktrees/cora/notes', headers, payload: { title: 'Assistant response' } });
      const updated = await notesApp.inject({ method: 'PUT', url: '/api/worktrees/cora/notes/note-identifier-002', headers, payload: { text: 'Autosaved note' } });
      const renamed = await notesApp.inject({ method: 'PATCH', url: '/api/worktrees/cora/notes/note-identifier-002', headers, payload: { title: 'Release checklist' } });
      const deleted = await notesApp.inject({ method: 'DELETE', url: '/api/worktrees/cora/notes/note-identifier-001', headers });
      const missing = await notesApp.inject({ method: 'GET', url: '/api/worktrees/missing/notes', headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.json()).toEqual({ notes: [{ id: 'note-identifier-001', text: 'Existing note' }] });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ id: 'note-identifier-002', text: '', title: 'Assistant response' });
      expect(updated.json()).toEqual({ id: 'note-identifier-002', text: 'Autosaved note', title: 'Assistant response' });
      expect(renamed.json()).toEqual({ id: 'note-identifier-002', text: 'Autosaved note', title: 'Release checklist' });
      expect(deleted.json()).toEqual({ id: 'note-identifier-001', text: 'Existing note' });
      expect(missing.statusCode).toBe(404);
      expect(keys).toEqual(['list:potato', 'create:potato:Assistant response', 'update:potato:note-identifier-002', 'rename:potato:note-identifier-002', 'delete:potato:note-identifier-001']);
    } finally { await notesApp.close(); }
  }, 15_000);

  it('keeps scratch notes available through the live agent', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, command: 'codex' };
    const agent = stated({ id: 'scratch-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu', title: 'Scratch' });
    const stored: Array<{ id: string; text: string; title?: string }> = [{ id: 'note-identifier-001', text: 'Scratch note' }];
    const keys: string[] = [];
    const notes = {
      list: async (key: string) => { keys.push(key); return [...stored]; },
      create: async (key: string, title?: string) => { keys.push(key); const note = { id: 'note-identifier-002', text: '', ...(title === undefined ? {} : { title }) }; stored.unshift(note); return note; },
      update: async (key: string, noteId: string, text: string) => {
        keys.push(key);
        const note = stored.find(candidate => candidate.id === noteId);
        // require one fixture note
        if (note === undefined) return undefined;
        note.text = text;
        return { ...note };
      },
      rename: async (key: string, noteId: string, title: string) => {
        keys.push(key);
        const note = stored.find(candidate => candidate.id === noteId);
        // require one fixture note
        if (note === undefined) return undefined;
        note.title = title;
        return { ...note };
      },
      delete: async (key: string, noteId: string) => { keys.push(key); const index = stored.findIndex(candidate => candidate.id === noteId); return index < 0 ? undefined : stored.splice(index, 1)[0]; }
    };
    const discovery = {
      // resolve the live scratch agent
      target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined,
      dashboard: async () => ({ generation: 1, agents: [agent], worktrees: [] })
    };
    const notesApp = await buildApp({ ...config, worktrees: [worktree] } as never, { auth: new AuthService(hash, Buffer.alloc(32, 26).toString('base64url')), discovery: discovery as never, notes: notes as never });
    try {
      const boot = await notesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await notesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const base = `/api/agents/${agent.id}/notes`;

      const listed = await notesApp.inject({ method: 'GET', url: base, headers: { host: headers.host, cookie: headers.cookie } });
      const created = await notesApp.inject({ method: 'POST', url: base, headers, payload: { title: 'Scratch checklist' } });
      const updated = await notesApp.inject({ method: 'PUT', url: `${base}/note-identifier-002`, headers, payload: { text: 'Keep this in scratch' } });
      const renamed = await notesApp.inject({ method: 'PATCH', url: `${base}/note-identifier-002`, headers, payload: { title: 'Scratch plan' } });
      const deleted = await notesApp.inject({ method: 'DELETE', url: `${base}/note-identifier-001`, headers });
      const missing = await notesApp.inject({ method: 'GET', url: '/api/agents/missing/notes', headers: { host: headers.host, cookie: headers.cookie } });

      expect(listed.json()).toEqual({ notes: [{ id: 'note-identifier-001', text: 'Scratch note' }] });
      expect(created.statusCode).toBe(201);
      expect(updated.json()).toEqual({ id: 'note-identifier-002', text: 'Keep this in scratch', title: 'Scratch checklist' });
      expect(renamed.json()).toEqual({ id: 'note-identifier-002', text: 'Keep this in scratch', title: 'Scratch plan' });
      expect(deleted.json()).toEqual({ id: 'note-identifier-001', text: 'Scratch note' });
      expect(missing.statusCode).toBe(404);
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toMatch(/^scratch_[A-Za-z0-9_-]{40}$/u);
    } finally { await notesApp.close(); }
  }, 15_000);
});

describe('workspace files API', () => {
  it('lists response files and previews active or inactive workspace files', async () => {
    const hash = await argon2.hash('synthetic-password', { type: argon2.argon2id });
    const worktree = { id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', hostPath: '/home/ubuntu/cora', available: true, pinned: false, command: 'codex' };
    const agent = stated({ id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/home/ubuntu/cora', title: 'Ready' });
    const discovery = { target: async (id: string) => id === agent.id ? { agent, socket: { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 } } : undefined };
    const workspaceFiles = {
      list: async (workspace: string, message: string) => workspace === '/worktrees/cora' && message === 'Changed `src/main.ts`.' ? [{ path: 'src/main.ts', size: 12 }] : [],
      preview: async (workspace: string, path: string) => workspace === '/worktrees/cora' && path === 'src/main.ts' ? { path, size: 12, binary: false, truncated: false, content: 'const ok=1;\n' } : undefined
    };
    const filesApp = await buildApp({ ...config, worktrees: [worktree] }, { auth: new AuthService(hash, Buffer.alloc(32, 15).toString('base64url')), discovery: discovery as never, workspaceFiles: workspaceFiles as never });
    try {
      const boot = await filesApp.inject({ method: 'GET', url: '/api/auth/bootstrap', headers: { host: 'agents.example.com' } });
      const login = await filesApp.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'agents.example.com', origin: 'https://agents.example.com', 'x-csrf-token': boot.json().csrfToken }, payload: { password: 'synthetic-password' } });
      const headers = { host: 'agents.example.com', origin: 'https://agents.example.com', cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
      const listed = await filesApp.inject({ method: 'POST', url: '/api/agents/agent-1/message-files', headers, payload: { message: 'Changed `src/main.ts`.' } });
      const previewed = await filesApp.inject({ method: 'POST', url: '/api/agents/agent-1/file-preview', headers, payload: { path: 'src/main.ts' } });
      const worktreePreviewed = await filesApp.inject({ method: 'POST', url: '/api/worktrees/cora/file-preview', headers, payload: { path: 'src/main.ts' } });
      const invalid = await filesApp.inject({ method: 'POST', url: '/api/agents/agent-1/file-preview', headers, payload: { path: '' } });
      const missingWorktree = await filesApp.inject({ method: 'POST', url: '/api/worktrees/missing/file-preview', headers, payload: { path: 'src/main.ts' } });

      expect(listed.json()).toEqual({ files: [{ path: 'src/main.ts', size: 12 }] });
      expect(previewed.json()).toEqual({ path: 'src/main.ts', size: 12, binary: false, truncated: false, content: 'const ok=1;\n' });
      expect(worktreePreviewed.json()).toEqual(previewed.json());
      expect(invalid.statusCode).toBe(400);
      expect(missingWorktree.statusCode).toBe(404);
    } finally { await filesApp.close(); }
  }, 15_000);
});
