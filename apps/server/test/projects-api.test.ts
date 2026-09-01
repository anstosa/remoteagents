import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { testConfig, testWorktree } from './helpers/config.js';
import { authenticatedHeaders, testAuthService, testHost } from './helpers/auth.js';

// The dashboard project shape and the pin route are unit-covered in worktree-pin.test.ts;
// this exercises the same wire through the real bootstrap→login browser session.
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('projects dashboard over an authenticated session', () => {
  it('serves the dashboard as projects each carrying their worktrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-projects-api-'));
    dirs.push(root);
    const worktree = testWorktree({ id: 'proj:/repo' });
    const discovery = {
      worktreesNow: () => [worktree],
      invalidateWorktrees: () => {},
      dashboard: async () => ({ generation: 1, adapters: {}, agents: [], projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [{ id: worktree.id, projectId: 'proj', label: 'Proj', path: '/repo', available: true, pinned: true, main: true, detached: false, locked: false, order: 0, branch: 'main' }] }] }),
    } as never;
    const app = await buildApp(testConfig(), { auth: await testAuthService(), discovery, worktreeStore: new WorktreeLaunchStore({ file: join(root, 'worktrees.json') }) });
    try {
      const headers = await authenticatedHeaders(app);
      const response = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: testHost, cookie: headers.cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // the flat worktrees[] is retired; every Worktree is nested under its Project
      expect(body).not.toHaveProperty('worktrees');
      expect(body.projects).toHaveLength(1);
      expect(body.projects[0].worktrees[0]).toMatchObject({ id: 'proj:/repo', main: true, order: 0, branch: 'main' });
    } finally { await app.close(); }
  });
});
