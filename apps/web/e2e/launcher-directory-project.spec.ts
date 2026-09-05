import { expect, test, type Page, type Route } from '@playwright/test';

// A non-git `directory` Project (config `projects[]` pointing at a path that is not a git
// checkout) has no worktrees, so the launcher renders a Project-level Launch button in place
// of worktree rows, keeps "New worktree…" disabled with its reason, and launches through
// POST /api/projects/:id/launch — the same in-place spawn Scratch uses.
const codex = { launchable: true, program: '/bin/codex', stateSource: 'both', turnCapture: true, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false };
const noWorktreesReason = 'this project is not a git repository, so it has no worktrees to manage';

type LaunchPost = { path: string; body: unknown };

// Mount the app against a stubbed dashboard, recording every project launch POST body.
async function mount(page: Page, dashboard: Record<string, unknown>): Promise<LaunchPost[]> {
  const posts: LaunchPost[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (request.method() === 'POST' && /^\/api\/projects\/[^/]+\/launch$/u.test(url.pathname)) {
      posts.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({ status: 201, json: { agentId: 'agent-directory' } });
    }
    if (request.method() === 'GET') return route.fulfill({ json: {} });
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  return posts;
}

const directoryProject = () => ({ id: 'notes', label: 'Notes', mode: 'directory', available: true, manageWorktrees: false, manageWorktreesReason: noWorktreesReason, stalePaths: [], worktrees: [], launch: { kind: 'codex', origin: 'project' } });

// retain scratch alongside the project-level launch target
test('a non-git directory Project offers an in-place Launch and keeps New worktree… disabled', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex }, agents: [], projects: [directoryProject()] });

  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });

  // the Project section shows its label and a Project-level Launch row (its single launch target)
  await expect(launcher.locator('.launcher-project-header > span')).toHaveText('Notes');
  await expect(launcher.locator('.launcher-row-label')).toHaveText(['Scratch', 'Notes']);

  // "New worktree…" stays disabled, explaining there are no worktrees to manage
  const newWorktree = launcher.getByRole('button', { name: 'New worktree…' });
  await expect(newWorktree).toBeDisabled();
  await expect(newWorktree).toHaveAttribute('title', noWorktreesReason);

  // the Project-level Launch button launches the resolved kind in place, in one click
  const projectRow = launcher.locator('.launcher-project .launcher-row').last();
  await projectRow.getByRole('button', { name: 'Launch Codex' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/projects/notes/launch', body: { kind: 'codex', sandboxed: false } }]);
});
