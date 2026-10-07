import { describe, expect, it } from 'vitest';
import { PullRequestService } from '../src/pull-requests/service.js';
import type { Command, Request } from '../src/pull-requests/github.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

// control command completion in cache race tests
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// return an empty successful pull request response
const emptyPullRequestResponse = async () => ({ ok: true, json: async () => [] });

// keep origin-cache checks independent of host credentials and token files
function cacheService(command: Command, request: Request = emptyPullRequestResponse, now?: () => number): PullRequestService {
  return new PullRequestService(command, request, now, () => undefined);
}

describe('dashboard GitHub origin cache', () => {
  // hot dashboard reads must not spawn another remote lookup
  it('reuses one origin lookup across url and repeated dashboard queries', async () => {
    const commands: string[] = [];
    const service = cacheService(async (_file, args) => {
      commands.push(args[1] ?? '');
      return { code: 0, stdout: 'git@github.com:octo/repo.git\n' };
    }, emptyPullRequestResponse);

    await expect(service.url('/workspace', 'feature/one')).resolves.toBeUndefined();
    await expect(service.cachedPullRequest('/workspace', 'feature/one')).resolves.toBeUndefined();
    await expect(service.cachedPullRequest('/workspace', 'feature/two')).resolves.toBeUndefined();

    expect(commands).toEqual(['/workspace']);
  });

  // branch-specific PR queries share workspace-level origin discovery
  it('coalesces concurrent origin lookups for different branches', async () => {
    const origin = deferred<{ code: number; stdout: string }>();
    let commands = 0;
    const service = cacheService(async () => {
      commands += 1;
      return await origin.promise;
    }, emptyPullRequestResponse);

    const first = service.url('/workspace', 'feature/one');
    const second = service.url('/workspace', 'feature/two');
    await Promise.resolve();
    expect(commands).toBe(1);

    origin.resolve({ code: 0, stdout: 'git@github.com:octo/repo.git\n' });
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(commands).toBe(1);
  });

  // external remote changes become visible within the bounded window
  it('expires positive, non-GitHub, and missing origin results', async () => {
    let now = 0;
    const origins = [
      { code: 0, stdout: 'git@github.com:octo/repo.git\n' },
      { code: 0, stdout: 'https://example.com/octo/repo.git\n' },
      { code: 2, stdout: '' },
      { code: 0, stdout: 'git@github.com:recovered/repo.git\n' }
    ];
    let commands = 0;
    const service = cacheService(async () => origins[commands++]!, emptyPullRequestResponse, () => now);

    await service.url('/workspace', 'feature/one');
    await service.cachedPullRequest('/workspace', 'feature/two');
    expect(commands).toBe(1);

    now = 30_000;
    await service.url('/workspace', 'feature/three');
    await service.cachedPullRequest('/workspace', 'feature/four');
    expect(commands).toBe(2);

    now = 60_000;
    await service.url('/workspace', 'feature/five');
    await service.cachedPullRequest('/workspace', 'feature/six');
    expect(commands).toBe(3);

    now = 90_000;
    await service.url('/workspace', 'feature/seven');
    await service.cachedPullRequest('/workspace', 'feature/eight');
    expect(commands).toBe(4);
  });

  // slow subprocesses do not consume the completed-result cache window
  it('starts the origin TTL when discovery completes', async () => {
    const origin = deferred<{ code: number; stdout: string }>();
    let now = 0;
    let commands = 0;
    const service = cacheService(async () => {
      commands += 1;
      return commands === 1 ? await origin.promise : { code: 0, stdout: 'git@github.com:octo/repo.git\n' };
    }, emptyPullRequestResponse, () => now);

    const initial = service.url('/workspace', 'feature/one');
    now = 20_000;
    origin.resolve({ code: 0, stdout: 'git@github.com:octo/repo.git\n' });
    await initial;
    now = 49_999;
    await service.url('/workspace', 'feature/two');
    expect(commands).toBe(1);

    now = 50_000;
    await service.url('/workspace', 'feature/three');
    expect(commands).toBe(2);
  });

  // sibling checkouts must not borrow each other's origin result
  it('keeps origin entries isolated by workspace', async () => {
    const workspaces: string[] = [];
    const service = cacheService(async (_file, args) => {
      workspaces.push(args[1] ?? '');
      return { code: 0, stdout: 'git@github.com:octo/repo.git\n' };
    }, emptyPullRequestResponse);

    await service.url('/one', 'feature/one');
    await service.url('/two', 'feature/two');
    await service.cachedPullRequest('/one', 'feature/three');

    expect(workspaces).toEqual(['/one', '/two']);
  });

  // transient spawn failures must remain retryable
  it('retries a rejected origin command', async () => {
    let commands = 0;
    const service = cacheService(async () => {
      commands += 1;
      // fail only the initial lookup
      if (commands === 1) throw new Error('git unavailable');
      return { code: 0, stdout: 'git@github.com:octo/repo.git\n' };
    }, emptyPullRequestResponse);

    await expect(service.url('/workspace', 'feature/one')).rejects.toThrow('git unavailable');
    await expect(service.url('/workspace', 'feature/two')).resolves.toBeUndefined();
    expect(commands).toBe(2);
  });

  // old checkout reads cannot repopulate the current generation
  it('does not let stale completion overwrite a post-invalidation origin', async () => {
    const firstOrigin = deferred<{ code: number; stdout: string }>();
    const secondOrigin = deferred<{ code: number; stdout: string }>();
    const origins = [firstOrigin, secondOrigin];
    let commands = 0;
    const requests: string[] = [];
    const service = cacheService(async () => await origins[commands++]!.promise, async (url) => {
      requests.push(url);
      return { ok: true, json: async () => [] };
    });

    const stale = service.url('/workspace', 'feature/stale');
    service.invalidateRepositories();
    const current = service.url('/workspace', 'feature/current');
    secondOrigin.resolve({ code: 0, stdout: 'git@github.com:new/repo.git\n' });
    await expect(current).resolves.toBeUndefined();
    firstOrigin.resolve({ code: 0, stdout: 'git@github.com:old/repo.git\n' });
    await expect(stale).resolves.toBeUndefined();

    await service.url('/workspace', 'feature/after');
    expect(commands).toBe(2);
    expect(requests.at(-1)).toContain('/repos/new/repo/pulls?');
  });

  // old failures cannot evict a replacement lookup
  it('does not let stale rejection delete a post-invalidation origin', async () => {
    const firstOrigin = deferred<{ code: number; stdout: string }>();
    const secondOrigin = deferred<{ code: number; stdout: string }>();
    const origins = [firstOrigin, secondOrigin];
    let commands = 0;
    const service = cacheService(async () => await origins[commands++]!.promise, emptyPullRequestResponse);

    const stale = service.url('/workspace', 'feature/stale');
    service.invalidateRepositories();
    const current = service.url('/workspace', 'feature/current');
    secondOrigin.resolve({ code: 0, stdout: 'git@github.com:new/repo.git\n' });
    await expect(current).resolves.toBeUndefined();
    firstOrigin.reject(new Error('stale command failure'));
    await expect(stale).rejects.toThrow('stale command failure');

    await service.url('/workspace', 'feature/after');
    expect(commands).toBe(2);
  });

  // mutation revalidation and on-demand links still check the live origin
  it('keeps open, supports, and actions URL origin discovery fresh', async () => {
    const origins = [
      'git@github.com:cached/repo.git\n',
      'https://example.com/unsupported/repo.git\n',
      'git@github.com:actions/repo.git\n',
      'git@github.com:open/repo.git\n'
    ];
    let commands = 0;
    const service = new PullRequestService(async () => ({ code: 0, stdout: origins[commands++]! }), async (url) => {
      // identify the viewer for the open lookup
      if (url.endsWith('/user')) return { ok: true, json: async () => ({ login: 'viewer' }) };
      return { ok: true, json: async () => [] };
    }, undefined, () => 'token');

    await service.url('/workspace', 'feature/cache');
    await expect(service.supports('/workspace')).resolves.toBe(false);
    await expect(service.actionsUrl('/workspace')).resolves.toBe('https://github.com/actions/repo/actions');
    await expect(service.open('/workspace')).resolves.toEqual({ own: [], others: [] });
    expect(commands).toBe(4);
  });
});
