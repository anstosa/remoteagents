import { describe, expect, it } from 'vitest';
import { PullRequestService, githubRepository } from '../src/pull-requests/service.js';

describe('GitHub pull request lookup', () => {
  it('recognizes GitHub origin formats', () => {
    expect(githubRepository('git@github.com:octo/repo.git')).toEqual({ owner: 'octo', name: 'repo' });
    expect(githubRepository('https://github.com/octo/repo.git')).toEqual({ owner: 'octo', name: 'repo' });
    expect(githubRepository('https://example.com/octo/repo.git')).toBeUndefined();
  });

  it('returns an open pull request URL and caches the request', async () => {
    const requests: string[] = [];
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async (url, init) => {
      requests.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer private-token');
      return { ok: true, json: async () => [{ html_url: 'https://github.com/octo/repo/pull/42' }] };
    }, undefined, () => 'private-token');

    await expect(service.url('/workspace', 'feature/voice')).resolves.toBe('https://github.com/octo/repo/pull/42');
    await expect(service.url('/workspace', 'feature/voice')).resolves.toBe('https://github.com/octo/repo/pull/42');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('head=octo%3Afeature%2Fvoice');
  });

  it('does not expose an untrusted PR URL', async () => {
    const service = new PullRequestService(async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), async () => ({ ok: true, json: async () => [{ html_url: 'https://example.com/pull/42' }] }));
    await expect(service.url('/workspace', 'feature')).resolves.toBeUndefined();
  });
});
