import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigDir } from '../adapters/claude-conversations.js';
import type { AccountRateLimitWindow, AccountSummary } from './service.js';
import { record } from './validation.js';

export const claudeUsageUrl = 'https://api.anthropic.com/api/oauth/usage';

export type ClaudeAccountOptions = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number; now?: () => number };

const expiredSignIn = 'Claude sign-in expired. Start Claude to refresh it.';

// parse one optional json file, treating absent or malformed files as missing
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return record(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

// keep one bounded control-free display string
function displayString(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(text) ? text : undefined;
}

// map one usage window onto the shared limit shape
function usageWindow(value: unknown, windowDurationMins: number): AccountRateLimitWindow | undefined {
  const window = record(value);
  if (typeof window?.utilization !== 'number' || !Number.isFinite(window.utilization)) return undefined;
  const resetsAt = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : Number.NaN;
  return { usedPercent: Math.min(100, Math.max(0, Math.round(window.utilization))), windowDurationMins, resetsAt: Number.isFinite(resetsAt) ? Math.floor(resetsAt / 1000) : null };
}

// Read the signed-in Claude account and its subscription usage. Only the access token Claude
// last wrote is used; refreshing it here would rotate the refresh token under running agents.
export async function readClaudeAccount({ env = process.env, fetch: fetchUsage = fetch, timeoutMs = 15_000, now = Date.now }: ClaudeAccountOptions = {}): Promise<AccountSummary> {
  const configDir = claudeConfigDir(env);
  // Claude keeps .claude.json in an explicit config dir, otherwise in the home directory
  const globalConfig = env.RAC_CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ? join(configDir, '.claude.json') : join(env.HOME ?? homedir(), '.claude.json');
  const [credentials, config] = await Promise.all([readJson(join(configDir, '.credentials.json')), readJson(globalConfig)]);
  const oauth = record(credentials?.claudeAiOauth);
  const email = displayString(record(config?.oauthAccount)?.emailAddress, 254);
  // prefer the tier ("max_20x") over the bare subscription ("max")
  const tier = displayString(oauth?.rateLimitTier, 64)?.match(/^default_claude_([a-z0-9_]+)$/u)?.[1];
  const subscription = displayString(oauth?.subscriptionType, 64);
  const planType = tier ?? (subscription && /^[a-z0-9_]+$/u.test(subscription) ? subscription : undefined);
  const summary: AccountSummary = { id: 'claude', label: email ?? 'Claude account', active: true, ...(email ? { email } : {}), ...(planType ? { planType } : {}) };
  const token = displayString(oauth?.accessToken, 8192);
  if (!token) return { ...summary, error: 'Not signed in to Claude.' };
  if (typeof oauth?.expiresAt === 'number' && oauth.expiresAt <= now()) return { ...summary, error: expiredSignIn };
  try {
    const response = await fetchUsage(claudeUsageUrl, { headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401) return { ...summary, error: expiredSignIn };
    if (!response.ok) return { ...summary, error: 'Claude usage query failed.' };
    const usage = record(await response.json());
    const primary = usageWindow(usage?.five_hour, 300);
    const secondary = usageWindow(usage?.seven_day, 10_080);
    return primary || secondary ? { ...summary, limits: { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) } } : summary;
  } catch {
    return { ...summary, error: 'Claude usage query failed.' };
  }
}
