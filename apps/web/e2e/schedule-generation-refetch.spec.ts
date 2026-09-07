import { expect, test, type Page } from '@playwright/test';

// pin the zone so the server-supplied nextRun renders as a fixed local sentence
test.use({ timezoneId: 'America/Los_Angeles' });

// The server refreshes the dashboard after every Run outcome, but a Schedule's lastRun and nextRun are
// REST-only, not on the dashboard payload. So while the notes fly-out or a note pane is open, a dashboard
// generation change must refetch this tab's notes, updating the clock badge and the "Last run" footnote.

// A dashboard WebSocket mock that exposes window.__emitDashboard to push new generations from a test.
async function installDashboardSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let dashboardSocket: MockWebSocket | undefined;
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly OPEN = 1;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        this.url = String(url);
        if (this.url.includes('/ws/dashboard')) dashboardSocket = this;
        window.setTimeout(() => {
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        });
      }
      send() {}
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, '__emitDashboard', { configurable: true, value: (dashboard: unknown) => dashboardSocket?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ v: 1, type: 'dashboard', dashboard }) })) });
    Object.defineProperty(window, '__dashboardSocketReady', { configurable: true, value: () => dashboardSocket?.readyState === MockWebSocket.OPEN && dashboardSocket.onmessage !== null });
  });
}

const emitGeneration = (page: Page, generation: number, agents: unknown[], projects: unknown[] = []) =>
  page.evaluate(([g, a, p]) => (window as typeof window & { __emitDashboard: (d: unknown) => void }).__emitDashboard({ generation: g, agents: a, projects: p }), [generation, agents, projects] as const);
const socketReady = (page: Page) => page.evaluate(() => (window as typeof window & { __dashboardSocketReady: () => boolean }).__dashboardSocketReady());

test('refetches the fly-out badge on a generation change, and catches up on reopen after one while closed', async ({ page }) => {
  await installDashboardSocket(page);
  const agents = [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }];
  const schedule = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'cora' }, enabled: true, updatedAt: '2026-01-01T00:00:00-08:00' };
  let runFailed = false;
  let notesGets = 0;
  const note = () => ({ id: 'note-identifier-001', text: 'Draft the weekly report', title: 'Weekly report', nextRun: '2026-01-02T17:00:00.000Z', schedule: { ...schedule, lastRun: runFailed ? { at: '2026-01-01T17:00:00.000Z', status: 'failed', detail: 'launch refused' } : { at: '2026-01-01T17:00:00.000Z', status: 'launched', agentId: 'agent-1' } } });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents, projects: [] } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') { notesGets += 1; return route.fulfill({ json: { notes: [note()] } }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await expect(page.getByTitle('Scheduled')).toBeVisible();
  await expect.poll(() => notesGets).toBe(1);
  await expect.poll(() => socketReady(page)).toBe(true);

  // a Run failed and the server bumped the generation; with the fly-out open, the tab refetches and reddens
  runFailed = true;
  await emitGeneration(page, 2, agents);
  await expect(page.getByTitle('Last run needs attention')).toBeVisible();
  await expect.poll(() => notesGets).toBe(2);

  // close the fly-out, advance the generation while closed (a later Run recovered), then reopen: the effect
  // left its baseline stale while closed, so reopening catches up and the badge returns to plain
  await page.locator('.flyout-backdrop').click();
  await expect(page.getByTitle('Last run needs attention')).toBeHidden();
  runFailed = false;
  await emitGeneration(page, 3, agents);
  await expect.poll(() => notesGets).toBe(2);
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await expect(page.getByTitle('Scheduled')).toBeVisible();
  await expect.poll(() => notesGets).toBe(3);
});

test('refreshes the open note pane\'s Last run footnote on a generation change', async ({ page }) => {
  test.setTimeout(60_000);
  await installDashboardSocket(page);
  const worktree = { id: 'wt-main', projectId: 'atlas', label: 'main', path: '/worktrees/atlas', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main', launch: { kind: 'claude' } };
  const agents = [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/atlas', worktreeId: 'wt-main', worktreeLabel: 'main', projectId: 'atlas', kind: 'claude', title: 'Ready' }];
  const projects = [{ id: 'atlas', label: 'atlas', mode: 'repository', available: true, worktrees: [worktree] }];
  const schedule = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, updatedAt: '2026-01-01T00:00:00-08:00' };
  let runFailed = false;
  const note = () => ({ id: 'note-identifier-001', text: 'Draft the weekly report', title: 'Weekly', nextRun: '2026-09-07T09:00:00-07:00', schedule: { ...schedule, lastRun: runFailed ? { at: '2026-01-01T17:00:00.000Z', status: 'failed', detail: 'launch refused' } : { at: '2026-01-01T17:00:00.000Z', status: 'launched', agentId: 'agent-1' } } });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents, projects } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/schedule/preview') return route.fulfill({ json: { next: ['2026-09-07T09:00:00-07:00'] } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [note()] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes' }).click();
  await page.locator('.note-choice').filter({ hasText: 'Weekly' }).click();
  const editor = page.getByRole('group', { name: 'Schedule', exact: true });
  await expect(editor.locator('.schedule-last')).toContainText('launched');
  await expect.poll(() => socketReady(page)).toBe(true);

  // a later scheduled Run failed and bumped the generation; the open pane refetches and reddens the footnote
  runFailed = true;
  await emitGeneration(page, 2, agents, projects);
  await expect(editor.locator('.schedule-last')).toContainText('failed, launch refused');
  await expect(editor.locator('.schedule-last')).toHaveClass(/bad/);
});
