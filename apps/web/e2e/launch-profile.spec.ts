import { expect, test, type Page, type Route } from '@playwright/test';

// A configured, launchable adapter capability with the given program.
const adapter = (program: string, extra: Record<string, unknown> = {}) => ({ launchable: true, program, stateSource: 'reported', turnCapture: false, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false, ...extra });
const codex = adapter('/bin/codex', { stateSource: 'both', turnCapture: true });
const claude = adapter('/bin/claude');

type Dashboard = Record<string, unknown>;
type LaunchPost = { path: string; body: unknown };

// Mount the app against a stubbed dashboard, recording every launch-family POST body.
async function mount(page: Page, dashboard: Dashboard): Promise<LaunchPost[]> {
  const posts: LaunchPost[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // record and satisfy the three launch-family routes the controls call
    if (request.method() === 'POST' && (url.pathname === '/api/agents/launch' || /\/api\/worktrees\/[^/]+\/launch$/u.test(url.pathname) || /\/api\/agents\/[^/]+\/restart$/u.test(url.pathname))) {
      posts.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({ status: 201, json: { agentId: 'agent-launched' } });
    }
    if (request.method() === 'GET') return route.fulfill({ json: {} });
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  return posts;
}

const pinnedWorktree = (launch: unknown, overrides: Record<string, unknown> = {}) => ({ id: 'cora', label: 'Cora', path: '/worktrees/cora', available: true, pinned: true, order: 1, launch, ...overrides });

test('launches the resolved kind in one click and lists every configured kind in the menu', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] });
  const primary = page.getByRole('button', { name: 'Launch Claude' });
  await expect(primary).toBeEnabled();
  await page.getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.locator('.launch-menu');
  await expect(menu.getByText('Launch · Cora')).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Codex/ })).toBeVisible();
  // the resolved kind is annotated with why it resolved
  await expect(menu.getByText('last used here')).toBeVisible();
  await menu.getByRole('menuitem', { name: /Codex/ }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', sandboxed: false } }]);
});

test('one click on the primary launches the resolved kind unsandboxed', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' })] });
  await page.getByRole('button', { name: 'Launch Codex' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'codex', sandboxed: false } }]);
});

test('a sandbox-capable kind defaults to a locked launch and offers a without-sandbox row', async ({ page }) => {
  // simulate the chunk-4 wire: a launchable Claude that reports a console-enforceable sandbox
  const sandboxedClaude = adapter('/bin/claude', { sandbox: true });
  const posts = await mount(page, { generation: 1, adapters: { codex, claude: sandboxedClaude }, agents: [], worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] });
  // the primary names the sandboxed default with a lock
  await expect(page.getByRole('button', { name: 'Launch Claude' }).locator('.launch-lock')).toBeVisible();
  await page.getByRole('button', { name: 'Choose agent' }).click();
  const menu = page.locator('.launch-menu');
  await expect(menu.getByText('Sandbox enforced by console')).toBeVisible();
  await expect(menu.getByText('Without sandbox — this launch only')).toBeVisible();
  // the without-sandbox row launches the same kind unsandboxed
  await menu.locator('.launch-row-unsandboxed').filter({ hasText: 'Claude' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'claude', sandboxed: false } }]);
});

test('the primary launches a sandbox-capable kind sandboxed', async ({ page }) => {
  const sandboxedClaude = adapter('/bin/claude', { sandbox: true });
  const posts = await mount(page, { generation: 1, adapters: { claude: sandboxedClaude }, agents: [], worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })] });
  await page.getByRole('button', { name: 'Launch Claude' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/worktrees/cora/launch', body: { kind: 'claude', sandboxed: true } }]);
});

test('an unavailable kind is disabled in the menu with its reason', async ({ page }) => {
  const unavailable = adapter('/bin/claude', { launchable: false, unavailableReason: '/bin/claude is not executable' });
  await mount(page, { generation: 1, adapters: { codex, claude: unavailable }, agents: [], worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' })] });
  await page.getByRole('button', { name: 'Choose agent' }).click();
  const claudeRow = page.locator('.launch-menu').getByRole('menuitem', { name: /Claude/ });
  await expect(claudeRow).toBeDisabled();
  await expect(claudeRow).toContainText('/bin/claude is not executable');
});

test('zero configured adapters disables the primary with the config hint and a disabled chevron', async ({ page }) => {
  await mount(page, { generation: 1, adapters: {}, agents: [], worktrees: [pinnedWorktree({})] });
  // scope to the card's split button — the "+" launcher tab shares the "Launch agent" name
  const primary = page.locator('.prompt-actions .launch-primary');
  await expect(primary).toHaveText('Launch agent');
  await expect(primary).toBeDisabled();
  await expect(page.locator('.prompt-actions .launch-chevron')).toBeDisabled();
  await expect(page.getByText('No agents configured — add an adapters entry to the console config.')).toBeVisible();
});

test('configured but none launchable disables the primary yet still opens the menu', async ({ page }) => {
  const brokenCodex = adapter('/bin/codex', { launchable: false, unavailableReason: '/bin/codex is not executable' });
  await mount(page, { generation: 1, adapters: { codex: brokenCodex }, agents: [], worktrees: [pinnedWorktree({})] });
  await expect(page.locator('.prompt-actions .launch-primary')).toBeDisabled();
  await expect(page.getByText('No configured agent is launchable right now')).toBeVisible();
  await page.locator('.prompt-actions .launch-chevron').click();
  await expect(page.locator('.launch-menu').getByRole('menuitem', { name: /Codex/ })).toBeDisabled();
});

test('a remembered kind that is no longer launchable is skipped with a footnote', async ({ page }) => {
  const unavailable = adapter('/bin/claude', { launchable: false, unavailableReason: '/bin/claude is not executable' });
  await mount(page, { generation: 1, adapters: { codex, claude: unavailable }, agents: [], worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default', skipped: { kind: 'claude', origin: 'worktree', reason: '/bin/claude is not executable' } })] });
  await page.getByRole('button', { name: 'Choose agent' }).click();
  await expect(page.locator('.launch-menu-note')).toContainText('Remembered Claude (here) skipped — /bin/claude is not executable');
});

test('the launcher offers Scratch and each worktree the same split button', async ({ page }) => {
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [], worktrees: [pinnedWorktree({ kind: 'claude', origin: 'worktree' })], scratchLaunch: { kind: 'codex', origin: 'scratch' } });
  await page.getByRole('button', { name: 'Launch agent' }).click();
  const launcher = page.locator('.launcher-menu');
  await expect(launcher.getByText('~ Scratch')).toBeVisible();
  // each worktree row carries its own resolved-kind split button
  await expect(launcher.locator('.launcher-row').filter({ hasText: 'Cora' }).getByRole('button', { name: 'Launch Claude' })).toBeVisible();
  // the scratch row primary launches its own resolved kind
  await launcher.locator('.launcher-row').filter({ hasText: 'Scratch' }).getByRole('button', { name: 'Launch Codex' }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/agents/launch', body: { kind: 'codex', sandboxed: false } }]);
});

test('an idle agent restarts as another kind from its power menu', async ({ page }) => {
  const agent = { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0, launch: { kind: 'codex', origin: 'worktree' } };
  const posts = await mount(page, { generation: 1, adapters: { codex, claude }, agents: [agent], worktrees: [] });
  await page.getByRole('button', { name: 'Agent power options' }).click();
  await page.getByRole('menuitem', { name: 'Restart as…' }).click();
  // the Launch menu opens as a second page within the power-menu flyout
  const menu = page.locator('.agent-power-menu');
  await expect(menu.getByText('Restart · Cora')).toBeVisible();
  await menu.getByRole('menuitem', { name: /Claude/ }).click();
  await expect.poll(() => posts).toEqual([{ path: '/api/agents/agent-1/restart', body: { kind: 'claude', sandboxed: false } }]);
});

test('agent tabs carry the kind glyph and a lock when sandboxed, idle worktree tabs carry none', async ({ page }) => {
  const agent = { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', kind: 'claude', attention: 'finished', sandboxed: true, queuedPromptCount: 0 };
  await mount(page, { generation: 1, adapters: { codex, claude }, agents: [agent], worktrees: [pinnedWorktree({ kind: 'codex', origin: 'default' }, { id: 'delta', label: 'Delta', order: 2 })] });
  // the Claude agent tab shows its glyph and a lock
  const agentTab = page.getByRole('tab', { name: /Cora/ });
  await expect(agentTab.locator('.launch-tab-badge .launch-kind-mark')).toHaveText('✳');
  await expect(agentTab.locator('.launch-tab-badge .launch-lock')).toBeVisible();
  // the idle worktree tab carries no badge
  await expect(page.getByRole('tab', { name: /Delta/ }).locator('.launch-tab-badge')).toHaveCount(0);
});
