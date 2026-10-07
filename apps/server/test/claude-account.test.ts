import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeUsageUrl, readClaudeAccount } from '../src/accounts/claude.js';

const now = Date.parse('2026-10-06T12:00:00Z');

describe('readClaudeAccount', () => {
  let configDir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'rac-claude-account-'));
    env = { RAC_CLAUDE_CONFIG_DIR: configDir };
  });
  afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

  // write the two files Claude keeps for a signed-in account
  const signIn = async (oauth: Record<string, unknown>) => {
    await writeFile(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
    await writeFile(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'tony@example.com' } }));
  };

  it('maps the five-hour and weekly usage onto the shared limit windows', async () => {
    await signIn({ accessToken: 'token-1', expiresAt: now + 60_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' });
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ five_hour: { utilization: 37.4, resets_at: '2026-10-06T14:00:00Z' }, seven_day: { utilization: 112, resets_at: null }, seven_day_opus: null });
    }) as typeof globalThis.fetch;
    const account = await readClaudeAccount({ env, fetch, now: () => now });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(claudeUsageUrl);
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: 'Bearer token-1' });
    expect(account).toEqual({
      id: 'claude', label: 'tony@example.com', active: true, email: 'tony@example.com', planType: 'max_20x',
      limits: {
        primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: Date.parse('2026-10-06T14:00:00Z') / 1000 },
        secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: null }
      }
    });
  });

  it('reports an expired token without calling the usage endpoint', async () => {
    await signIn({ accessToken: 'token-1', expiresAt: now - 1, subscriptionType: 'pro' });
    const fetch = (async () => { throw new Error('unexpected request'); }) as typeof globalThis.fetch;
    const account = await readClaudeAccount({ env, fetch, now: () => now });
    expect(account).toMatchObject({ label: 'tony@example.com', planType: 'pro', error: 'Claude sign-in expired. Start Claude to refresh it.' });
  });

  it('reports a missing sign-in and failed queries as account errors', async () => {
    expect(await readClaudeAccount({ env })).toEqual({ id: 'claude', label: 'Claude account', active: true, error: 'Not signed in to Claude.' });
    await signIn({ accessToken: 'token-1' });
    const fetch = (async () => new Response('busy', { status: 429 })) as typeof globalThis.fetch;
    expect(await readClaudeAccount({ env, fetch, now: () => now })).toMatchObject({ error: 'Claude usage query failed.' });
  });
});
