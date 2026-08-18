import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexAccountService,
  type AddAccountStatus,
  type CodexProtocolClient,
  type CodexProtocolNotification,
  type CodexProtocolNotificationListener
} from '../src/accounts/index.js';

const roots: string[] = [];

// allocate one disposable codex home
async function accountHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rac-accounts-test-'));
  roots.push(root);
  return root;
}

// build representative chatgpt credentials
function auth(accountId: string, accessToken: string, refreshToken = 'refresh-secret'): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: accountId, access_token: accessToken, refresh_token: refreshToken }
  });
}

// build credentials with safe display claims
function authWithIdentity(accountId: string, accessToken: string, email: string, planType: string): string {
  const payload = Buffer.from(JSON.stringify({ email, email_verified: true, 'https://api.openai.com/auth': { chatgpt_plan_type: planType } })).toString('base64url');
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: accountId, access_token: accessToken, refresh_token: 'refresh-secret', id_token: `header.${payload}.signature` }
  });
}

// persist one configured account slot
async function writeSlot(home: string, id: string, contents: string, label?: string): Promise<void> {
  const accounts = join(home, 'accounts');
  await mkdir(accounts, { recursive: true });
  await writeFile(join(accounts, `${id}.auth.json`), contents);
  // persist optional labels
  if (label !== undefined) await writeFile(join(accounts, `${id}.label`), label);
}

// wait for an asynchronous login notification handler
async function waitForTerminalStatus(service: CodexAccountService, loginId: string): Promise<AddAccountStatus> {
  // poll within one focused test deadline
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await service.status(loginId);
    // return the first terminal state
    if (status.status !== 'pending') return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Login did not complete');
}

class FakeProtocolClient implements CodexProtocolClient {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  closed = false;
  private readonly listeners = new Set<CodexProtocolNotificationListener>();

  // configure deterministic protocol responses
  constructor(
    private readonly respond: (method: string, params?: unknown) => Promise<unknown>
  ) {}

  // record and answer one request
  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, ...(params !== undefined ? { params } : {}) });
    return await this.respond(method, params);
  }

  // record one client notification
  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, ...(params !== undefined ? { params } : {}) });
  }

  // subscribe to fake notifications
  onNotification(listener: CodexProtocolNotificationListener): () => void {
    this.listeners.add(listener);
    // remove the exact listener
    return () => this.listeners.delete(listener);
  }

  // mark cleanup
  async close(): Promise<void> {
    this.closed = true;
  }

  // publish one fake notification
  emit(notification: CodexProtocolNotification): void {
    // notify each current listener
    for (const listener of this.listeners) listener(notification);
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('codex multi-account service', () => {
  it('uses the codex home default and discovers only safe regular slots', async () => {
    const home = await accountHome();
    vi.stubEnv('CODEX_HOME', home);
    await writeSlot(home, 'account-1', auth('acct-one', 'access-one'), 'First account');
    await writeSlot(home, 'account_2', auth('acct-two', 'access-two'));
    await writeSlot(home, 'account-3', auth('acct-one', 'duplicate-access'));
    await writeSlot(home, 'bad.name', auth('acct-bad', 'access-bad'));
    await mkdir(join(home, 'accounts', 'directory.auth.json'));
    const queried: string[] = [];
    const service = new CodexAccountService({
      // record deterministic account queries
      queryAccount: async context => {
        queried.push(context.id);
        return {
          account: { account: { type: 'chatgpt', email: `${context.id}@example.com`, planType: 'plus', accessToken: 'must-not-leak' } },
          rateLimits: { rateLimits: { primary: null, secondary: null, planType: 'plus' }, rateLimitResetCredits: null }
        };
      }
    });

    const summaries = await service.listAccounts();
    expect(service.codexHome).toBe(home);
    expect(summaries).toEqual([
      { id: 'account_2', label: 'account_2', active: false, email: 'account_2@example.com', planType: 'plus' },
      { id: 'account-1', label: 'First account', active: false, email: 'account-1@example.com', planType: 'plus' }
    ]);
    expect(queried.sort()).toEqual(['account-1', 'account_2']);
    expect(JSON.stringify(summaries)).not.toContain('must-not-leak');
  });

  it('queries slots concurrently, marks stable active identity, sanitizes limits, and persists refreshes to that slot only', async () => {
    const home = await accountHome();
    const originalOne = auth('acct-one', 'old-access-one', 'old-refresh-one');
    const originalTwo = auth('acct-two', 'old-access-two', 'old-refresh-two');
    await writeSlot(home, 'account-1', originalOne, 'One');
    await writeSlot(home, 'account-2', originalTwo, 'Two');
    await writeFile(join(home, 'auth.json'), auth('acct-one', 'different-active-token'));
    const started = new Set<string>();
    const queriedAuth = new Map<string, string>();
    let release!: () => void;
    const bothStarted = new Promise<void>(resolve => { release = resolve; });
    const service = new CodexAccountService({
      codexHome: home,
      // hold both queries until concurrency is observed
      queryAccount: async context => {
        started.add(context.id);
        queriedAuth.set(context.id, await readFile(context.authFile, 'utf8'));
        // release after both slots begin
        if (started.size === 2) release();
        await bothStarted;
        // simulate a token refresh for one slot
        if (context.id === 'account-1') await writeFile(context.authFile, auth('acct-one', 'new-access-one', 'new-refresh-one'));
        return {
          account: { account: { type: 'chatgpt', email: `${context.id}@example.com`, planType: 'pro', refreshToken: 'hidden' } },
          rateLimits: {
            rateLimits: {
              primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
              secondary: { usedPercent: 101, windowDurationMins: 10_080, resetsAt: 1_900_000_000 },
              planType: 'pro'
            },
            rateLimitResetCredits: { availableCount: '2', credits: [{ id: 'secret-credit' }] }
          }
        };
      }
    });

    const summaries = await service.listAccounts();

    expect(started).toEqual(new Set(['account-1', 'account-2']));
    expect(queriedAuth).toEqual(new Map([
      ['account-1', auth('acct-one', 'different-active-token')],
      ['account-2', originalTwo]
    ]));
    expect(summaries).toEqual([
      {
        id: 'account-1', label: 'One', active: true, email: 'account-1@example.com', planType: 'pro',
        limits: {
          primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          rateLimitResetCredits: { availableCount: 2 }
        }
      },
      {
        id: 'account-2', label: 'Two', active: false, email: 'account-2@example.com', planType: 'pro',
        limits: {
          primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          rateLimitResetCredits: { availableCount: 2 }
        }
      }
    ]);
    expect(await readFile(join(home, 'accounts', 'account-1.auth.json'), 'utf8')).toBe(auth('acct-one', 'new-access-one', 'new-refresh-one'));
    expect(await readFile(join(home, 'accounts', 'account-2.auth.json'), 'utf8')).toBe(originalTwo);
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(auth('acct-one', 'new-access-one', 'new-refresh-one'));
    expect(JSON.stringify(summaries)).not.toMatch(/hidden|secret-credit|old-access|new-access/u);
  });

  it('uses the initialized app-server sequence and cleans isolated homes after queries', async () => {
    const home = await accountHome();
    await writeSlot(home, 'account-1', auth('acct-one', 'access-one'));
    let isolatedHome = '';
    const client = new FakeProtocolClient(async method => {
      // return protocol-shaped account data
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'one@example.com', planType: 'team' }, requiresOpenaiAuth: false };
      // return protocol-shaped rate limits
      if (method === 'account/rateLimits/read') {
        return {
          rateLimits: {
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: null,
            planType: 'team'
          },
          rateLimitResetCredits: { availableCount: 1 }
        };
      }
      return {};
    });
    const service = new CodexAccountService({
      codexHome: home,
      // capture the isolated protocol home
      createClient: async codexHome => {
        isolatedHome = codexHome;
        return client;
      }
    });

    await expect(service.listAccounts()).resolves.toMatchObject([{ id: 'account-1', email: 'one@example.com', planType: 'team' }]);
    expect(client.calls).toEqual([
      {
        method: 'initialize',
        params: {
          clientInfo: { name: 'remote-agent-console', title: 'Remote Agent Console', version: '1.0.0' },
          capabilities: { experimentalApi: true, requestAttestation: false }
        }
      },
      { method: 'account/read', params: { refreshToken: true } },
      { method: 'account/rateLimits/read' }
    ]);
    expect(client.notifications).toEqual([{ method: 'initialized' }]);
    expect(client.closed).toBe(true);
    await expect(access(isolatedHome)).rejects.toThrow();
  });

  it('redeems one reset credit through an isolated account and returns refreshed limits', async () => {
    const home = await accountHome();
    await writeSlot(home, 'account-1', auth('acct-one', 'access-one'), 'Personal');
    let isolatedHome = '';
    const client = new FakeProtocolClient(async (method, params) => {
      // accept one idempotent reset attempt
      if (method === 'account/rateLimitResetCredit/consume') {
        expect(params).toMatchObject({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
        return { outcome: 'reset' };
      }
      // return the refreshed account identity
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'personal@example.com', planType: 'pro' } };
      // return the refreshed usage snapshot
      if (method === 'account/rateLimits/read') {
        return {
          rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: null, planType: 'pro' },
          rateLimitResetCredits: { availableCount: 1 }
        };
      }
      return {};
    });
    const service = new CodexAccountService({
      codexHome: home,
      // capture the isolated reset home
      createClient: async codexHome => {
        isolatedHome = codexHome;
        return client;
      }
    });

    await expect(service.consumeRateLimitReset('account-1')).resolves.toEqual({
      outcome: 'reset',
      account: {
        id: 'account-1', label: 'Personal', active: false, email: 'personal@example.com', planType: 'pro',
        limits: {
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_900_000_000 },
          rateLimitResetCredits: { availableCount: 1 }
        }
      }
    });
    expect(client.calls.map(call => call.method)).toEqual([
      'initialize',
      'account/rateLimitResetCredit/consume',
      'account/read',
      'account/rateLimits/read'
    ]);
    expect(client.closed).toBe(true);
    await expect(access(isolatedHome)).rejects.toThrow();
    await expect(service.consumeRateLimitReset('../account-1')).rejects.toThrow('Invalid account id');
  });

  it('bounds hanging queries and returns an account-local safe error', async () => {
    const home = await accountHome();
    await writeSlot(home, 'account-1', auth('acct-one', 'access-one'));
    let isolatedHome = '';
    const service = new CodexAccountService({
      codexHome: home,
      queryTimeoutMs: 20,
      // wait for query cancellation
      queryAccount: async context => {
        isolatedHome = context.codexHome;
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('refresh-secret must not leak');
      }
    });

    await expect(service.listAccounts()).resolves.toEqual([
      { id: 'account-1', label: 'account-1', active: false, error: 'Account query timed out' }
    ]);
    await expect(access(isolatedHome)).rejects.toThrow();
  });

  it('atomically switches a revalidated safe slot without querying or exposing auth', async () => {
    const home = await accountHome();
    const selected = auth('acct-two', 'selected-secret');
    await writeSlot(home, 'account-2', selected, 'Second');
    await writeFile(join(home, 'auth.json'), auth('acct-one', 'old-active-secret'));
    const service = new CodexAccountService({ codexHome: home });

    await expect(service.switchAccount('account-2')).resolves.toEqual({ id: 'account-2', label: 'Second', active: true });
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(selected);
    await expect(service.switchAccount('../account-2')).rejects.toThrow('Invalid account id');
    await expect(service.switchAccount('missing')).rejects.toThrow('Account not found');
    await writeSlot(home, 'broken', '{}');
    await expect(service.switchAccount('broken')).rejects.toThrow('Account not found');
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(selected);
  });

  it('persists a rotated credential when the later account query fails', async () => {
    const home = await accountHome();
    const original = auth('acct-one', 'old-access', 'old-refresh');
    const refreshed = auth('acct-one', 'new-access', 'new-refresh');
    await writeSlot(home, 'account-1', original);
    const service = new CodexAccountService({
      codexHome: home,
      // rotate before a later provider failure
      queryAccount: async context => {
        await writeFile(context.authFile, refreshed);
        throw new Error('rate limits failed');
      }
    });

    await expect(service.listAccounts()).resolves.toEqual([
      { id: 'account-1', label: 'account-1', active: false, error: 'Account query failed' }
    ]);
    expect(await readFile(join(home, 'accounts', 'account-1.auth.json'), 'utf8')).toBe(refreshed);
  });

  it('reports a safe account error when refreshed credentials cannot be persisted', async () => {
    const home = await accountHome();
    const refreshed = auth('acct-one', 'new-access', 'new-refresh');
    await writeSlot(home, 'account-1', auth('acct-one', 'old-access', 'old-refresh'));
    let isolatedHome = '';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new CodexAccountService({
      codexHome: home,
      // replace the slot directory after the isolated refresh
      queryAccount: async context => {
        isolatedHome = context.codexHome;
        await writeFile(context.authFile, refreshed);
        await rm(join(home, 'accounts'), { recursive: true, force: true });
        await writeFile(join(home, 'accounts'), 'blocked');
        return {
          account: { account: { type: 'chatgpt', email: 'one@example.com', planType: 'pro' } },
          rateLimits: { rateLimits: { primary: null, secondary: null, planType: 'pro' } }
        };
      }
    });

    await expect(service.listAccounts()).resolves.toEqual([
      { id: 'account-1', label: 'account-1', active: false, error: 'Unable to save refreshed account credentials' }
    ]);
    expect(logged).toHaveBeenCalledWith('[accounts] query credential persistence failed:', expect.any(String));
    await expect(access(isolatedHome)).rejects.toThrow();
    logged.mockRestore();
  });

  it('fails a reset when refreshed credentials cannot be persisted', async () => {
    const home = await accountHome();
    await writeSlot(home, 'account-1', auth('acct-one', 'old-access', 'old-refresh'));
    let isolatedHome = '';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new FakeProtocolClient(async method => {
      // rotate credentials and make their source unavailable
      if (method === 'account/rateLimitResetCredit/consume') {
        await writeFile(join(isolatedHome, 'auth.json'), auth('acct-one', 'new-access', 'new-refresh'));
        await rm(join(home, 'accounts'), { recursive: true, force: true });
        await writeFile(join(home, 'accounts'), 'blocked');
        return { outcome: 'reset' };
      }
      // retain a valid provider response before persistence
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'one@example.com', planType: 'pro' } };
      // return an empty rate-limit snapshot
      if (method === 'account/rateLimits/read') return { rateLimits: { primary: null, secondary: null, planType: 'pro' } };
      return {};
    });
    const service = new CodexAccountService({
      codexHome: home,
      // capture the isolated reset home
      createClient: async codexHome => {
        isolatedHome = codexHome;
        return client;
      }
    });

    await expect(service.consumeRateLimitReset('account-1')).rejects.toThrow('Unable to save refreshed account credentials');
    expect(logged).toHaveBeenCalledWith('[accounts] reset credential persistence failed:', expect.any(String));
    await expect(access(isolatedHome)).rejects.toThrow();
    logged.mockRestore();
  });

  it('completes device-code login into the next account slot and retains only safe status', async () => {
    const home = await accountHome();
    const originalActive = auth('acct-existing', 'active-secret');
    await writeSlot(home, 'account-2', auth('acct-existing', 'existing-secret'));
    await writeFile(join(home, 'auth.json'), originalActive);
    let client!: FakeProtocolClient;
    let loginHome = '';
    client = new FakeProtocolClient(async method => {
      // create credentials as the real login flow does
      if (method === 'account/login/start') {
        await writeFile(join(loginHome, 'auth.json'), auth('acct-new', 'new-access-secret', 'new-refresh-secret'));
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-123',
          verificationUrl: 'https://auth.openai.com/device',
          userCode: 'ABCD-EFGH'
        };
      }
      // return the post-login identity
      if (method === 'account/read') {
        return { account: { type: 'chatgpt', email: 'new@example.com', planType: 'plus', accessToken: 'hidden' } };
      }
      return {};
    });
    const service = new CodexAccountService({
      codexHome: home,
      // retain the isolated login home for assertions
      createClient: async codexHome => {
        loginHome = codexHome;
        return client;
      }
    });

    await expect(service.startAddAccount()).resolves.toEqual({
      loginId: 'login-123',
      verificationUrl: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH'
    });
    client.emit({
      method: 'account/login/completed',
      params: { loginId: 'login-123', success: true, error: null, onboardingEntrypoint: null }
    });
    const status = await waitForTerminalStatus(service, 'login-123');

    expect(status).toEqual({
      status: 'succeeded',
      account: { id: 'account-3', label: 'new@example.com', active: false, email: 'new@example.com', planType: 'plus' }
    });
    expect(JSON.stringify(status)).not.toMatch(/access-secret|refresh-secret|hidden/u);
    expect(await readFile(join(home, 'accounts', 'account-3.auth.json'), 'utf8')).toBe(auth('acct-new', 'new-access-secret', 'new-refresh-secret'));
    expect(await readFile(join(home, 'accounts', 'account-3.label'), 'utf8')).toBe('new@example.com');
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(originalActive);
    expect(client.closed).toBe(true);
    await expect(access(loginHome)).rejects.toThrow();
    await service.close();
  });

  it('does not treat an unreadable account directory as an empty allocation', async () => {
    const home = await accountHome();
    const accountsPath = join(home, 'accounts');
    await writeFile(accountsPath, 'existing-storage');
    let client!: FakeProtocolClient;
    let loginHome = '';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    client = new FakeProtocolClient(async method => {
      // create completed login credentials
      if (method === 'account/login/start') {
        await writeFile(join(loginHome, 'auth.json'), auth('acct-new', 'new-access'));
        return { type: 'chatgptDeviceCode', loginId: 'login-storage-error', verificationUrl: 'https://auth.openai.com/device', userCode: 'SAVE-CODE' };
      }
      // return the completed identity
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'new@example.com', planType: 'plus' } };
      return {};
    });
    const service = new CodexAccountService({
      codexHome: home,
      // capture the isolated login home
      createClient: async codexHome => {
        loginHome = codexHome;
        return client;
      }
    });

    const login = await service.startAddAccount();
    client.emit({ method: 'account/login/completed', params: { loginId: login.loginId, success: true } });

    await expect(waitForTerminalStatus(service, login.loginId)).resolves.toEqual({ status: 'failed', error: 'Unable to save account' });
    expect(await readFile(accountsPath, 'utf8')).toBe('existing-storage');
    expect(logged).toHaveBeenCalledWith('[accounts] device login persistence failed:', expect.any(String));
    logged.mockRestore();
    await service.close();
  });

  it('waits for completed device credentials to finish writing before saving the account', async () => {
    const home = await accountHome();
    let client!: FakeProtocolClient;
    let loginHome = '';
    client = new FakeProtocolClient(async method => {
      // return login metadata before credentials exist
      if (method === 'account/login/start') {
        return { type: 'chatgptDeviceCode', loginId: 'login-delayed-auth', verificationUrl: 'https://auth.openai.com/device', userCode: 'WAIT-CODE' };
      }
      // reproduce the empty post-login identity response
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      return {};
    });
    const service = new CodexAccountService({
      codexHome: home,
      queryTimeoutMs: 1_000,
      // capture the isolated login home
      createClient: async codexHome => {
        loginHome = codexHome;
        return client;
      }
    });

    const login = await service.startAddAccount();
    client.emit({ method: 'account/login/completed', params: { loginId: login.loginId, success: true } });
    // emulate Codex flushing auth after its completion notification
    await new Promise(resolve => setTimeout(resolve, 75));
    const delayedAuth = authWithIdentity('acct-delayed', 'delayed-access', 'delayed@example.com', 'plus');
    await writeFile(join(loginHome, 'auth.json'), delayedAuth);

    await expect(waitForTerminalStatus(service, login.loginId)).resolves.toEqual({
      status: 'succeeded',
      account: { id: 'account-1', label: 'delayed@example.com', active: false, email: 'delayed@example.com', planType: 'plus' }
    });
    expect(await readFile(join(home, 'accounts', 'account-1.auth.json'), 'utf8')).toBe(delayedAuth);
    await service.close();
  });

  it('reuses an existing slot when the same account is added again', async () => {
    const home = await accountHome();
    await writeSlot(home, 'account-1', auth('acct-same', 'old-access'), 'Existing');
    let client!: FakeProtocolClient;
    let loginHome = '';
    client = new FakeProtocolClient(async method => {
      // replace the same identity with new credentials
      if (method === 'account/login/start') {
        await writeFile(join(loginHome, 'auth.json'), auth('acct-same', 'new-access'));
        return { type: 'chatgptDeviceCode', loginId: 'login-same', verificationUrl: 'https://auth.openai.com/device', userCode: 'SAME-CODE' };
      }
      // return the repeated account identity
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'same@example.com', planType: 'pro' } };
      return {};
    });
    const service = new CodexAccountService({
      codexHome: home,
      // capture the isolated login home
      createClient: async codexHome => {
        loginHome = codexHome;
        return client;
      }
    });

    const login = await service.startAddAccount();
    client.emit({ method: 'account/login/completed', params: { loginId: login.loginId, success: true } });
    await expect(waitForTerminalStatus(service, login.loginId)).resolves.toMatchObject({
      status: 'succeeded', account: { id: 'account-1', label: 'same@example.com' }
    });
    expect(await readFile(join(home, 'accounts', 'account-1.auth.json'), 'utf8')).toBe(auth('acct-same', 'new-access'));
    await expect(access(join(home, 'accounts', 'account-2.auth.json'))).rejects.toThrow();
    await service.close();
  });

  it('repairs one failed slot without changing the active account', async () => {
    const home = await accountHome();
    const active = auth('acct-one', 'active-access');
    await writeFile(join(home, 'auth.json'), active);
    await writeSlot(home, 'account-2', '{}', 'Work');
    let client!: FakeProtocolClient;
    let loginHome = '';
    client = new FakeProtocolClient(async method => {
      // replace failed credentials during device login
      if (method === 'account/login/start') {
        await writeFile(join(loginHome, 'auth.json'), auth('acct-two', 'repaired-access'));
        return { type: 'chatgptDeviceCode', loginId: 'login-repair', verificationUrl: 'https://auth.openai.com/device', userCode: 'FIX-ACCOUNT' };
      }
      // return the repaired account identity
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'work@example.com', planType: 'business' } };
      return {};
    });
    const service = new CodexAccountService({
      codexHome: home,
      // capture the isolated repair home
      createClient: async codexHome => {
        loginHome = codexHome;
        return client;
      }
    });

    const login = await service.startAddAccount('account-2');
    client.emit({ method: 'account/login/completed', params: { loginId: login.loginId, success: true } });
    await expect(waitForTerminalStatus(service, login.loginId)).resolves.toEqual({
      status: 'succeeded',
      account: { id: 'account-2', label: 'Work', active: false, email: 'work@example.com', planType: 'business' }
    });
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(active);
    expect(await readFile(join(home, 'accounts', 'account-2.auth.json'), 'utf8')).toBe(auth('acct-two', 'repaired-access'));
    await expect(access(join(home, 'accounts', 'account-3.auth.json'))).rejects.toThrow();
    await expect(service.startAddAccount('../account-2')).rejects.toThrow('Invalid account id');
    await expect(service.startAddAccount('missing')).rejects.toThrow('Account not found');
    await service.close();
  });

  it('cancels pending device-code logins and cleans their isolated process', async () => {
    const home = await accountHome();
    let loginHome = '';
    const client = new FakeProtocolClient(async method => {
      // return a pending device-code login
      if (method === 'account/login/start') {
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-cancel',
          verificationUrl: 'https://auth.openai.com/device',
          userCode: 'CANCEL-ME'
        };
      }
      // acknowledge cancellation
      if (method === 'account/login/cancel') return { status: 'cancelled' };
      return {};
    });
    const service = new CodexAccountService({
      codexHome: home,
      // capture the isolated login home
      createClient: async codexHome => {
        loginHome = codexHome;
        return client;
      }
    });

    await service.startAddAccount();
    await expect(service.cancelAddAccount('login-cancel')).resolves.toBe(true);
    await expect(service.status('login-cancel')).resolves.toEqual({ status: 'failed', error: 'Account login cancelled' });
    expect(client.calls).toContainEqual({ method: 'account/login/cancel', params: { loginId: 'login-cancel' } });
    expect(client.closed).toBe(true);
    await expect(access(loginHome)).rejects.toThrow();
    await expect(service.cancelAddAccount('login-cancel')).resolves.toBe(false);
    await service.close();
  });
});
