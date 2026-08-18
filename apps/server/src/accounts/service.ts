import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  createCodexProtocolClient,
  initializeCodexProtocol,
  type CodexProtocolClient,
  type CodexProtocolClientFactory,
  type CodexProtocolNotification
} from './protocol.js';

export const safeAccountId = /^[a-zA-Z0-9_-]{1,80}$/u;

export type AccountRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type AccountLimits = {
  primary?: AccountRateLimitWindow;
  secondary?: AccountRateLimitWindow;
  rateLimitResetCredits?: { availableCount: number };
};

export type AccountSummary = {
  id: string;
  label: string;
  active: boolean;
  email?: string;
  planType?: string;
  limits?: AccountLimits;
  error?: string;
};

export type AccountResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

export type AccountResetResult = {
  outcome: AccountResetOutcome;
  account?: AccountSummary;
};

export type AccountQueryResult = {
  account: unknown;
  rateLimits: unknown;
};

export type AccountQueryContext = {
  id: string;
  active: boolean;
  codexHome: string;
  authFile: string;
  signal: AbortSignal;
};

export type AccountQuery = (context: AccountQueryContext) => Promise<AccountQueryResult>;

export type StartAddAccountResult = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

export type AddAccountStatus =
  | { status: 'pending' }
  | { status: 'succeeded'; account: AccountSummary }
  | { status: 'failed'; error: string };

export type AccountServiceOptions = {
  codexHome?: string;
  queryTimeoutMs?: number;
  loginTimeoutMs?: number;
  createClient?: CodexProtocolClientFactory;
  queryAccount?: AccountQuery;
};

type ParsedAuth = {
  contents: Buffer;
  contentDigest: string;
  fingerprint: string;
};

type AccountIdentity = {
  email?: string;
  planType?: string;
};

type Slot = {
  id: string;
  authFile: string;
  label: string;
};

type LoginSession = {
  loginId: string;
  tempHome: string;
  repair?: RepairTarget;
  client?: CodexProtocolClient;
  unsubscribe?: () => void;
  expiry?: NodeJS.Timeout;
  finalized: boolean;
  state: AddAccountStatus;
};

type RepairTarget = {
  id: string;
  label: string;
  authFile: string;
  sourceContentDigest: string;
  sourceFingerprint?: string;
};

const maxAuthFileBytes = 1024 * 1024;
const maxLabelFileBytes = 4096;
const defaultQueryTimeoutMs = 15_000;
const defaultLoginTimeoutMs = 10 * 60_000;
const completedLoginRetentionMs = 60 * 60_000;
const loginAuthPollIntervalMs = 50;

class AccountTimeoutError extends Error {}

// match one filesystem error code
function hasFileErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code;
}

// read an optional directory without masking storage failures
async function readDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    // treat only an absent directory as empty
    if (hasFileErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
}

// narrow unknown objects
function record(value: unknown): Record<string, unknown> | undefined {
  // reject arrays and null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

// hash secret-bearing inputs
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

// serialize parsed json deterministically
function canonicalJson(value: unknown): string {
  // preserve json scalar values
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  // preserve array order
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  const fields: string[] = [];
  // sort object keys
  for (const key of Object.keys(object).sort()) fields.push(`${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${fields.join(',')}}`;
}

// select the first non-empty string
function firstString(object: Record<string, unknown>, keys: string[]): string | undefined {
  // inspect supported field aliases
  for (const key of keys) {
    const value = object[key];
    // return bounded scalar strings
    if (typeof value === 'string' && value.length > 0 && value.length <= 8192) return value;
  }
  return undefined;
}

// parse credentials without returning secrets
function parseAuth(contents: Buffer): ParsedAuth {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid account credentials file');
  }
  const auth = record(value);
  // require a json object
  if (!auth) throw new Error('Invalid account credentials file');
  const tokens = record(auth.tokens) ?? {};
  const apiKey = firstString(auth, ['OPENAI_API_KEY', 'openai_api_key', 'api_key', 'apiKey']);
  const accessToken = firstString(tokens, ['access_token', 'accessToken']);
  const refreshToken = firstString(tokens, ['refresh_token', 'refreshToken']);
  const idToken = firstString(tokens, ['id_token', 'idToken']);
  const accountId = firstString(tokens, ['account_id', 'accountId', 'chatgpt_account_id', 'chatgptAccountId'])
    ?? firstString(auth, ['account_id', 'accountId', 'chatgpt_account_id', 'chatgptAccountId']);
  const inferredMode = apiKey ? 'apikey' : accountId && (accessToken || refreshToken || idToken) ? 'chatgpt' : 'unknown';
  const mode = firstString(auth, ['auth_mode', 'authMode']) ?? inferredMode;
  // require recognized credential material
  if ((mode === 'chatgpt' && (!accountId || (!accessToken && !refreshToken && !idToken))) || (mode === 'apikey' && !apiKey) || (mode !== 'chatgpt' && mode !== 'apikey')) throw new Error('Invalid account credentials file');
  const contentDigest = digest(canonicalJson(value));
  const identityKind = accountId ? 'account' : apiKey ? 'api-key' : 'content';
  const identityValue = accountId ?? (apiKey ? digest(apiKey) : contentDigest);
  return {
    contents,
    contentDigest: digest(contents),
    fingerprint: digest(JSON.stringify([mode, identityKind, identityValue]))
  };
}

// read a bounded regular file without following symlinks
async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    // reject non-files and oversized data
    if (!metadata.isFile() || metadata.size > maxBytes) throw new Error('Invalid file');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// atomically replace one private file
async function atomicWrite(path: string, contents: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

// normalize user-visible scalar data
function safeScalar(value: unknown, maxLength: number): string | undefined {
  // require printable strings
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // reject empty, long, or control-bearing values
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined;
  return trimmed;
}

// read display identity from one Codex id token
function credentialIdentity(contents: Buffer): AccountIdentity | undefined {
  try {
    const auth = record(JSON.parse(contents.toString('utf8')) as unknown);
    const tokens = record(auth?.tokens);
    const idToken = firstString(tokens ?? {}, ['id_token', 'idToken']);
    // require one bounded jwt payload
    if (!idToken) return undefined;
    const payload = idToken.split('.')[1];
    // reject missing or oversized claims
    if (!payload || payload.length > 65_536) return undefined;
    const claims = record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown);
    // require decoded claims
    if (!claims) return undefined;
    const provider = record(claims['https://api.openai.com/auth']);
    const identity: AccountIdentity = {};
    const email = safeScalar(claims.email, 254);
    // retain only verified-looking email claims
    if (email?.includes('@') && claims.email_verified !== false) identity.email = email;
    const planType = safeScalar(provider?.chatgpt_plan_type, 64);
    // retain only protocol-style plan claims
    if (planType && /^[a-z0-9_]+$/u.test(planType)) identity.planType = planType;
    return Object.keys(identity).length > 0 ? identity : undefined;
  } catch {
    return undefined;
  }
}

// normalize account identity responses
function accountIdentity(response: unknown): AccountIdentity | undefined {
  const envelope = record(response);
  const account = record(envelope?.account);
  // require an authenticated account shape
  if (!account || typeof account.type !== 'string') return undefined;
  const identity: AccountIdentity = {};
  // include only plausible email addresses
  const email = safeScalar(account.email, 254);
  // discard malformed email fields
  if (email?.includes('@')) identity.email = email;
  const planType = safeScalar(account.planType, 64);
  // restrict plan values to protocol-style identifiers
  if (planType && /^[a-z0-9_]+$/u.test(planType)) identity.planType = planType;
  return identity;
}

// normalize one rate-limit window
function rateLimitWindow(value: unknown): AccountRateLimitWindow | undefined {
  const window = record(value);
  // require a finite percentage
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)
    || window.usedPercent < 0 || window.usedPercent > 100) return undefined;
  const duration = window.windowDurationMins;
  const reset = window.resetsAt;
  // validate nullable duration
  if (duration !== null && (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 0)) return undefined;
  // validate nullable reset timestamp
  if (reset !== null && (typeof reset !== 'number' || !Number.isSafeInteger(reset) || reset < 0)) return undefined;
  return { usedPercent: window.usedPercent, windowDurationMins: duration, resetsAt: reset };
}

// normalize a non-negative count
function availableCount(value: unknown): number | undefined {
  // accept safe integer json numbers
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  // accept serialized protocol integers
  if (typeof value === 'string' && /^\d{1,15}$/u.test(value)) {
    const parsed = Number(value);
    // keep only safe integers
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

// validate one reset-credit provider outcome
function accountResetOutcome(value: unknown): AccountResetOutcome | undefined {
  // accept only documented protocol values
  if (value === 'reset' || value === 'nothingToReset' || value === 'noCredit' || value === 'alreadyRedeemed') return value;
  return undefined;
}

// normalize rate-limit responses
function accountLimits(response: unknown): { limits?: AccountLimits; planType?: string } {
  const envelope = record(response);
  const snapshot = record(envelope?.rateLimits);
  // omit malformed limit envelopes
  if (!envelope || !snapshot) return {};
  const limits: AccountLimits = {};
  const primary = rateLimitWindow(snapshot.primary);
  const secondary = rateLimitWindow(snapshot.secondary);
  // include valid primary windows
  if (primary) limits.primary = primary;
  // include valid secondary windows
  if (secondary) limits.secondary = secondary;
  const resetCredits = record(envelope.rateLimitResetCredits);
  const count = availableCount(resetCredits?.availableCount);
  // include available reset credits
  if (count !== undefined) limits.rateLimitResetCredits = { availableCount: count };
  const planType = safeScalar(snapshot.planType, 64);
  const validPlanType = planType && /^[a-z0-9_]+$/u.test(planType) ? planType : undefined;
  return { ...(Object.keys(limits).length > 0 ? { limits } : {}), ...(validPlanType ? { planType: validPlanType } : {}) };
}

// enforce one operation deadline
async function withDeadline<T>(task: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new AccountTimeoutError('Account operation timed out'));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    // clear completed deadlines
    if (timer) clearTimeout(timer);
  }
}

// resolve the configured codex home
function defaultCodexHome(): string {
  return process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), '.codex');
}

// constrain configurable operation deadlines
function boundedTimeout(value: number | undefined, fallback: number, maximum: number): number {
  // use defaults for invalid values
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), maximum);
}

export class CodexAccountService {
  readonly codexHome: string;
  readonly accountsDirectory: string;
  private readonly activeAuthFile: string;
  private readonly queryTimeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly createClient: CodexProtocolClientFactory;
  private readonly injectedQuery?: AccountQuery;
  private readonly logins = new Map<string, LoginSession>();
  private mutationTail: Promise<void> = Promise.resolve();

  // configure account storage and protocol injection
  constructor(options: AccountServiceOptions = {}) {
    this.codexHome = options.codexHome ?? defaultCodexHome();
    this.accountsDirectory = join(this.codexHome, 'accounts');
    this.activeAuthFile = join(this.codexHome, 'auth.json');
    this.queryTimeoutMs = boundedTimeout(options.queryTimeoutMs, defaultQueryTimeoutMs, 60_000);
    this.loginTimeoutMs = boundedTimeout(options.loginTimeoutMs, defaultLoginTimeoutMs, 24 * 60 * 60_000);
    this.createClient = options.createClient ?? createCodexProtocolClient;
    this.injectedQuery = options.queryAccount;
  }

  // list and query all configured accounts concurrently
  async listAccounts(): Promise<AccountSummary[]> {
    const [slots, activeAuth] = await Promise.all([this.listSlots(), this.readActiveAuth()]);
    const unique: Slot[] = [];
    const fingerprints = new Set<string>();
    // collapse duplicate configured identities
    for (const slot of slots) {
      try {
        const fingerprint = parseAuth(await readRegularFile(slot.authFile, maxAuthFileBytes)).fingerprint;
        // retain the first deterministic slot
        if (fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
      } catch { /* retain invalid slots as independent errors */ }
      unique.push(slot);
    }
    // query independent slots concurrently
    return await Promise.all(unique.map(slot => this.querySlot(slot, activeAuth)));
  }

  // atomically select one configured account
  async switchAccount(id: string): Promise<AccountSummary> {
    // reject unsafe ids before path construction
    if (!safeAccountId.test(id)) throw new Error('Invalid account id');
    return await this.mutate(async () => {
      const authFile = join(this.accountsDirectory, `${id}.auth.json`);
      let parsed: ParsedAuth;
      try {
        parsed = parseAuth(await readRegularFile(authFile, maxAuthFileBytes));
      } catch {
        throw new Error('Account not found');
      }
      const label = await this.readLabel(id);
      await atomicWrite(this.activeAuthFile, parsed.contents);
      return { id, label, active: true };
    });
  }

  // redeem one provider reset credit for a configured account
  async consumeRateLimitReset(id: string): Promise<AccountResetResult> {
    // reject unsafe ids before path construction
    if (!safeAccountId.test(id)) throw new Error('Invalid account id');
    return await this.mutate(async () => {
      const authFile = join(this.accountsDirectory, `${id}.auth.json`);
      let parsed: ParsedAuth;
      try {
        parsed = parseAuth(await readRegularFile(authFile, maxAuthFileBytes));
      } catch {
        throw new Error('Account not found');
      }
      const label = await this.readLabel(id);
      const activeAuth = await this.readActiveAuth();
      const active = parsed.fingerprint === activeAuth?.fingerprint;
      const queryAuth = active && activeAuth !== undefined ? activeAuth : parsed;
      const slot = { id, authFile, label };
      const tempHome = await mkdtemp(join(tmpdir(), 'rac-codex-reset-'));
      const tempAuthFile = join(tempHome, 'auth.json');
      let client: CodexProtocolClient | undefined;
      try {
        await writeFile(tempAuthFile, queryAuth.contents, { mode: 0o600 });
        client = await withDeadline(this.createClient(tempHome), this.queryTimeoutMs);
        await withDeadline(initializeCodexProtocol(client), this.queryTimeoutMs, () => void client?.close());
        const response = record(await withDeadline(
          client.request('account/rateLimitResetCredit/consume', { idempotencyKey: randomUUID() }),
          this.queryTimeoutMs,
          () => void client?.close()
        ));
        const outcome = accountResetOutcome(response?.outcome);
        // require one documented provider outcome
        if (outcome === undefined) throw new Error('Invalid reset response');
        try {
          const account = await withDeadline(client.request('account/read', { refreshToken: !active }), this.queryTimeoutMs, () => void client?.close());
          const rateLimits = await withDeadline(client.request('account/rateLimits/read'), this.queryTimeoutMs, () => void client?.close());
          const identity = accountIdentity(account);
          // return the reset even when the refreshed identity is unavailable
          if (!identity) return { outcome };
          const limits = accountLimits(rateLimits);
          return {
            outcome,
            account: {
              id,
              label,
              active,
              ...identity,
              ...limits,
              ...(identity.planType ? { planType: identity.planType } : {})
            }
          };
        } catch {
          return { outcome };
        }
      } finally {
        await client?.close().catch(() => undefined);
        try {
          // retain any provider credential refresh before removing isolation
          await this.persistRefreshLocked(slot, parsed, queryAuth, tempAuthFile);
        } catch (error) {
          console.error('[accounts] reset credential persistence failed:', error instanceof Error ? error.message : 'unknown error');
          throw new Error('Unable to save refreshed account credentials');
        } finally {
          await rm(tempHome, { recursive: true, force: true });
        }
      }
    });
  }

  // begin an isolated device-code login
  async startAddAccount(repairAccountId?: string): Promise<StartAddAccountResult> {
    const repair = repairAccountId === undefined ? undefined : await this.prepareRepairTarget(repairAccountId);
    const tempHome = await mkdtemp(join(tmpdir(), 'rac-codex-login-'));
    await mkdir(tempHome, { recursive: true, mode: 0o700 });
    let client: CodexProtocolClient | undefined;
    try {
      client = await withDeadline(this.createClient(tempHome), this.queryTimeoutMs);
      await withDeadline(initializeCodexProtocol(client), this.queryTimeoutMs, () => void client?.close());
      let session: LoginSession | undefined;
      let earlyCompletion: CodexProtocolNotification | undefined;
      // capture completion before and after session registration
      const unsubscribe = client.onNotification(notification => {
        // ignore unrelated notifications
        if (notification.method !== 'account/login/completed') return;
        // buffer notifications received before the login response
        if (!session) {
          earlyCompletion = notification;
          return;
        }
        void this.handleLoginCompletion(session, notification);
      });
      const response = record(await withDeadline(
        client.request('account/login/start', { type: 'chatgptDeviceCode' }),
        this.queryTimeoutMs,
        () => void client?.close()
      ));
      const loginId = safeScalar(response?.loginId, 200);
      const verificationUrl = safeVerificationUrl(response?.verificationUrl);
      const userCode = safeScalar(response?.userCode, 64);
      // require the expected device-code response
      if (response?.type !== 'chatgptDeviceCode' || !loginId || !verificationUrl || !userCode) {
        unsubscribe();
        throw new Error('Codex returned an invalid login response');
      }
      // reject duplicate protocol login ids
      if (this.logins.has(loginId)) {
        unsubscribe();
        throw new Error('Codex returned a duplicate login id');
      }
      const registeredSession: LoginSession = { loginId, tempHome, ...(repair === undefined ? {} : { repair }), client, unsubscribe, finalized: false, state: { status: 'pending' } };
      session = registeredSession;
      this.logins.set(loginId, registeredSession);
      // expire abandoned login sessions
      registeredSession.expiry = setTimeout(() => void this.expireLogin(registeredSession), this.loginTimeoutMs);
      registeredSession.expiry.unref();
      // process buffered completion events
      if (earlyCompletion) void this.handleLoginCompletion(registeredSession, earlyCompletion);
      return { loginId, verificationUrl, userCode };
    } catch (error) {
      await client?.close().catch(() => undefined);
      await rm(tempHome, { recursive: true, force: true });
      throw error;
    }
  }

  // read one login result without exposing credentials
  async status(loginId: string): Promise<AddAccountStatus> {
    const session = this.logins.get(loginId);
    // report unknown login ids as failures
    if (!session) return { status: 'failed', error: 'Login session not found' };
    return session.state;
  }

  // cancel a pending device-code login
  async cancelAddAccount(loginId: string): Promise<boolean> {
    const session = this.logins.get(loginId);
    // reject missing or completed sessions
    if (!session || session.finalized) return false;
    session.finalized = true;
    session.state = { status: 'failed', error: 'Account login cancelled' };
    // cancel server-side polling best effort
    if (session.client) {
      await withDeadline(
        session.client.request('account/login/cancel', { loginId }),
        this.queryTimeoutMs,
        () => void session.client?.close()
      ).catch(() => undefined);
    }
    await this.cleanupLogin(session);
    this.retainLoginResult(session);
    return true;
  }

  // clean up all long-lived login processes
  async close(): Promise<void> {
    const sessions = [...this.logins.values()];
    // stop each pending process
    for (const session of sessions) {
      // preserve terminal results
      if (!session.finalized) {
        session.finalized = true;
        session.state = { status: 'failed', error: 'Account service stopped' };
      }
      await this.cleanupLogin(session);
    }
    this.logins.clear();
  }

  // discover regular safe-id slot files
  private async listSlots(): Promise<Slot[]> {
    const entries = await readDirectory(this.accountsDirectory);
    const slots: Slot[] = [];
    // inspect sorted directory entries
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      // accept regular auth files only
      if (!entry.isFile() || !entry.name.endsWith('.auth.json')) continue;
      const id = entry.name.slice(0, -'.auth.json'.length);
      // reject unsafe ids
      if (!safeAccountId.test(id)) continue;
      slots.push({ id, authFile: join(this.accountsDirectory, entry.name), label: await this.readLabel(id) });
    }
    return slots;
  }

  // read a bounded optional label
  private async readLabel(id: string): Promise<string> {
    try {
      const label = safeScalar((await readRegularFile(join(this.accountsDirectory, `${id}.label`), maxLabelFileBytes)).toString('utf8'), 120);
      return label ?? id;
    } catch {
      return id;
    }
  }

  // read active credentials for identity and concurrency checks
  private async readActiveAuth(): Promise<ParsedAuth | undefined> {
    try {
      return parseAuth(await readRegularFile(this.activeAuthFile, maxAuthFileBytes));
    } catch {
      return undefined;
    }
  }

  // read active credentials without masking storage failures
  private async readActiveAuthForRefresh(): Promise<ParsedAuth | undefined> {
    let contents: Buffer;
    try {
      contents = await readRegularFile(this.activeAuthFile, maxAuthFileBytes);
    } catch (error) {
      // tolerate only an absent active selection
      if (hasFileErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      return parseAuth(contents);
    } catch {
      return undefined;
    }
  }

  // snapshot one configured slot before a repair login
  private async prepareRepairTarget(id: string): Promise<RepairTarget> {
    // reject unsafe ids before path construction
    if (!safeAccountId.test(id)) throw new Error('Invalid account id');
    const authFile = join(this.accountsDirectory, `${id}.auth.json`);
    let contents: Buffer;
    try {
      contents = await readRegularFile(authFile, maxAuthFileBytes);
    } catch {
      throw new Error('Account not found');
    }
    let sourceFingerprint: string | undefined;
    try {
      sourceFingerprint = parseAuth(contents).fingerprint;
    } catch { /* invalid credentials remain repairable */ }
    return {
      id,
      authFile,
      label: await this.readLabel(id),
      sourceContentDigest: digest(contents),
      ...(sourceFingerprint === undefined ? {} : { sourceFingerprint })
    };
  }

  // query one slot in a disposable codex home
  private async querySlot(slot: Slot, activeAuth: ParsedAuth | undefined): Promise<AccountSummary> {
    let parsed: ParsedAuth;
    try {
      parsed = parseAuth(await readRegularFile(slot.authFile, maxAuthFileBytes));
    } catch {
      return { id: slot.id, label: slot.label, active: false, error: 'Invalid account credentials file' };
    }
    const summary: AccountSummary = { id: slot.id, label: slot.label, active: parsed.fingerprint === activeAuth?.fingerprint };
    const queryAuth = summary.active && activeAuth !== undefined ? activeAuth : parsed;
    const tempHome = await mkdtemp(join(tmpdir(), 'rac-codex-account-'));
    const tempAuthFile = join(tempHome, 'auth.json');
    const controller = new AbortController();
    let result: AccountSummary = summary;
    try {
      await writeFile(tempAuthFile, queryAuth.contents, { mode: 0o600 });
      const queryResult = await withDeadline(
        this.runQuery({ id: slot.id, active: summary.active, codexHome: tempHome, authFile: tempAuthFile, signal: controller.signal }),
        this.queryTimeoutMs,
        () => controller.abort()
      );
      const identity = accountIdentity(queryResult.account);
      // report unauthenticated or malformed account responses
      if (!identity) {
        result = { ...summary, error: 'Account is not authenticated' };
      } else {
        const rateLimits = accountLimits(queryResult.rateLimits);
        result = {
          ...summary,
          ...identity,
          ...rateLimits,
          ...(identity.planType ? { planType: identity.planType } : {})
        };
      }
    } catch (error) {
      result = { ...summary, error: error instanceof AccountTimeoutError ? 'Account query timed out' : 'Account query failed' };
    } finally {
      controller.abort();
      try {
        // retain refreshes even when later account queries fail
        await this.persistRefresh(slot, parsed, queryAuth, tempAuthFile);
      } catch (error) {
        console.error('[accounts] query credential persistence failed:', error instanceof Error ? error.message : 'unknown error');
        result = { ...summary, error: 'Unable to save refreshed account credentials' };
      } finally {
        await rm(tempHome, { recursive: true, force: true });
      }
    }
    return result;
  }

  // execute an injected or real protocol query
  private async runQuery(context: AccountQueryContext): Promise<AccountQueryResult> {
    // use deterministic injected queries
    if (this.injectedQuery) return await this.injectedQuery(context);
    const client = await this.createClient(context.codexHome);
    // terminate the child when the overall query aborts
    const abort = () => void client.close();
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      // handle already-aborted contexts
      if (context.signal.aborted) throw new AccountTimeoutError('Account operation timed out');
      await initializeCodexProtocol(client);
      const account = await client.request('account/read', { refreshToken: !context.active });
      const rateLimits = await client.request('account/rateLimits/read');
      return { account, rateLimits };
    } finally {
      context.signal.removeEventListener('abort', abort);
      await client.close();
    }
  }

  // persist a valid refresh only when credential sources are unchanged
  private async persistRefresh(slot: Slot, slotAtStart: ParsedAuth, queryAuth: ParsedAuth, tempAuthFile: string): Promise<void> {
    await this.mutate(async () => this.persistRefreshLocked(slot, slotAtStart, queryAuth, tempAuthFile));
  }

  // persist a valid refresh while holding the mutation queue
  private async persistRefreshLocked(slot: Slot, slotAtStart: ParsedAuth, queryAuth: ParsedAuth, tempAuthFile: string): Promise<void> {
    let refreshedContents: Buffer;
    try {
      refreshedContents = await readRegularFile(tempAuthFile, maxAuthFileBytes);
    } catch (error) {
      // skip homes that did not write credentials
      if (hasFileErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    let refreshed: ParsedAuth;
    try {
      refreshed = parseAuth(refreshedContents);
    } catch {
      return;
    }
    // reject identity-changing query results
    if (refreshed.fingerprint !== queryAuth.fingerprint) return;
    // skip fully unchanged sources
    if (refreshed.contentDigest === queryAuth.contentDigest && refreshed.contentDigest === slotAtStart.contentDigest) return;
    let currentContents: Buffer;
    try {
      currentContents = await readRegularFile(slot.authFile, maxAuthFileBytes);
    } catch (error) {
      // preserve external slot deletion as a concurrency no-op
      if (hasFileErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    let current: ParsedAuth;
    try {
      current = parseAuth(currentContents);
    } catch {
      return;
    }
    // avoid overwriting concurrent slot changes
    if (current.contentDigest !== slotAtStart.contentDigest || current.fingerprint !== slotAtStart.fingerprint) return;
    const activeNow = await this.readActiveAuthForRefresh();
    // preserve concurrent refreshes of this identity
    if (activeNow?.fingerprint === queryAuth.fingerprint && activeNow.contentDigest !== queryAuth.contentDigest) return;
    // synchronize the configured slot with the live active snapshot
    if (current.contentDigest !== refreshed.contentDigest) await atomicWrite(slot.authFile, refreshed.contents);
    // carry refreshes through a concurrent switch to this exact source
    if (activeNow?.contentDigest === queryAuth.contentDigest && refreshed.contentDigest !== queryAuth.contentDigest) await atomicWrite(this.activeAuthFile, refreshed.contents);
  }

  // complete a matching login event exactly once
  private async handleLoginCompletion(session: LoginSession, notification: CodexProtocolNotification): Promise<void> {
    const params = record(notification.params);
    // ignore other login ids and malformed events
    if (params?.loginId !== session.loginId || typeof params.success !== 'boolean' || session.finalized) return;
    session.finalized = true;
    // record server-reported failures safely
    if (!params.success) {
      session.state = { status: 'failed', error: 'Account login failed' };
      await this.cleanupLogin(session);
      this.retainLoginResult(session);
      return;
    }
    try {
      const client = session.client;
      // require the live login client
      if (!client) throw new Error('Missing login client');
      const parsed = await this.readCompletedLoginAuth(session);
      const storedIdentity = credentialIdentity(parsed.contents);
      let identity = storedIdentity;
      try {
        const accountResponse = await withDeadline(
          client.request('account/read', { refreshToken: true }),
          this.queryTimeoutMs,
          () => void client.close()
        );
        identity = accountIdentity(accountResponse) ?? storedIdentity;
      } catch (error) {
        // require either provider or credential metadata
        if (identity === undefined) throw error;
      }
      // require a validated account identity
      if (!identity) throw new Error('Invalid account identity');
      const account = session.repair === undefined
        ? await this.persistAddedAccount(parsed, identity)
        : await this.persistRepairedAccount(parsed, identity, session.repair);
      session.state = { status: 'succeeded', account };
    } catch (error) {
      console.error('[accounts] device login persistence failed:', error instanceof Error ? error.message : 'unknown error');
      session.state = { status: 'failed', error: 'Unable to save account' };
    }
    await this.cleanupLogin(session);
    this.retainLoginResult(session);
  }

  // wait for Codex to flush completed credentials
  private async readCompletedLoginAuth(session: LoginSession): Promise<ParsedAuth> {
    const authFile = join(session.tempHome, 'auth.json');
    const deadline = Date.now() + this.queryTimeoutMs;
    let lastError: unknown = new Error('Login credentials unavailable');
    // tolerate completion notifications that precede the atomic auth write
    while (Date.now() < deadline) {
      try {
        return parseAuth(await readRegularFile(authFile, maxAuthFileBytes));
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>(resolve => setTimeout(resolve, loginAuthPollIntervalMs));
    }
    throw lastError;
  }

  // allocate and persist the next conventional account id
  private async persistAddedAccount(parsed: ParsedAuth, identity: AccountIdentity): Promise<AccountSummary> {
    return await this.mutate(async () => {
      const entries = await readDirectory(this.accountsDirectory);
      let highest = 0;
      let existingId: string | undefined;
      // find the highest configured conventional slot
      for (const entry of entries) {
        const match = /^account-(\d+)\.auth\.json$/u.exec(entry.name);
        // ignore unrelated and non-file entries
        if (!entry.isFile() || !match?.[1]) continue;
        const number = Number(match[1]);
        // track safe sequence values
        if (Number.isSafeInteger(number) && number > highest) highest = number;
        try {
          const existing = parseAuth(await readRegularFile(join(this.accountsDirectory, entry.name), maxAuthFileBytes));
          // reuse the first matching identity
          if (existingId === undefined && existing.fingerprint === parsed.fingerprint) existingId = entry.name.slice(0, -'.auth.json'.length);
        } catch { /* ignore invalid existing slots */ }
      }
      let id = existingId;
      // refresh a known identity in place
      if (id !== undefined) {
        const label = identity.email ?? id;
        await atomicWrite(join(this.accountsDirectory, `${id}.label`), label);
        await atomicWrite(join(this.accountsDirectory, `${id}.auth.json`), parsed.contents);
      } else {
        await mkdir(this.accountsDirectory, { recursive: true, mode: 0o700 });
        let sequence = highest + 1;
        // allocate without replacing an external slot
        while (id === undefined) {
          // stop unsafe sequence overflow
          if (!Number.isSafeInteger(sequence)) throw new Error('Account slot limit reached');
          const candidate = `account-${sequence}`;
          const authFile = join(this.accountsDirectory, `${candidate}.auth.json`);
          const labelFile = join(this.accountsDirectory, `${candidate}.label`);
          try {
            await writeFile(authFile, parsed.contents, { mode: 0o600, flag: 'wx' });
            try {
              await writeFile(labelFile, identity.email ?? candidate, { mode: 0o600, flag: 'wx' });
              id = candidate;
            } catch (error) {
              await rm(authFile, { force: true });
              // skip externally reserved labels
              if (hasFileErrorCode(error, 'EEXIST')) {
                sequence += 1;
                continue;
              }
              throw error;
            }
          } catch (error) {
            // skip externally reserved auth slots
            if (hasFileErrorCode(error, 'EEXIST')) {
              sequence += 1;
              continue;
            }
            throw error;
          }
        }
      }
      const persistedId = id;
      // require the completed allocation
      if (persistedId === undefined) throw new Error('Unable to allocate account slot');
      const active = parsed.fingerprint === (await this.readActiveAuth())?.fingerprint;
      return { id: persistedId, label: identity.email ?? persistedId, active, ...identity };
    });
  }

  // replace one unchanged slot without changing the selected account
  private async persistRepairedAccount(parsed: ParsedAuth, identity: AccountIdentity, repair: RepairTarget): Promise<AccountSummary> {
    return await this.mutate(async () => {
      const currentContents = await readRegularFile(repair.authFile, maxAuthFileBytes).catch(() => undefined);
      // preserve concurrent slot changes
      if (currentContents === undefined || digest(currentContents) !== repair.sourceContentDigest) throw new Error('Account changed during login');
      const activeContents = await readRegularFile(this.activeAuthFile, maxAuthFileBytes).catch(() => undefined);
      const activeAuth = await this.readActiveAuth();
      const activeByContents = activeContents !== undefined && digest(activeContents) === repair.sourceContentDigest;
      const activeByIdentity = repair.sourceFingerprint !== undefined && activeAuth?.fingerprint === repair.sourceFingerprint;
      const active = activeByContents || activeByIdentity;
      await atomicWrite(repair.authFile, parsed.contents);
      // repair live credentials only when this slot is still selected
      if (active) await atomicWrite(this.activeAuthFile, parsed.contents);
      return { id: repair.id, label: repair.label, active, ...identity };
    });
  }

  // expire an abandoned login session
  private async expireLogin(session: LoginSession): Promise<void> {
    // ignore already-completed sessions
    if (session.finalized) return;
    session.finalized = true;
    session.state = { status: 'failed', error: 'Account login expired' };
    // cancel server-side polling best effort
    if (session.client) {
      await withDeadline(
        session.client.request('account/login/cancel', { loginId: session.loginId }),
        this.queryTimeoutMs,
        () => void session.client?.close()
      ).catch(() => undefined);
    }
    await this.cleanupLogin(session);
    this.retainLoginResult(session);
  }

  // release one login process and temporary home
  private async cleanupLogin(session: LoginSession): Promise<void> {
    // clear the expiry timer
    if (session.expiry) clearTimeout(session.expiry);
    session.expiry = undefined;
    session.unsubscribe?.();
    session.unsubscribe = undefined;
    const client = session.client;
    session.client = undefined;
    // close the long-lived process
    if (client) await client.close().catch(() => undefined);
    const tempHome = session.tempHome;
    session.tempHome = '';
    // remove the isolated home once
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  }

  // retain terminal login status briefly
  private retainLoginResult(session: LoginSession): void {
    const timer = setTimeout(() => {
      // delete only the original session
      if (this.logins.get(session.loginId) === session) this.logins.delete(session.loginId);
    }, completedLoginRetentionMs);
    timer.unref();
  }

  // serialize credential mutations after prior failures
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return await result;
  }
}

// accept bounded https verification urls
function safeVerificationUrl(value: unknown): string | undefined {
  const text = safeScalar(value, 2048);
  // reject missing urls
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
