import { expect, test, type Page } from '@playwright/test';
import { dashboardSocketReady, emitDashboard, installDashboardSocket } from './dashboard-socket-fixture.js';

const sendPath = 'M22 2 11 13M22 2l-7 20-4-9-9-4Z';
const queuePath = 'M4 6h10M4 11h10M4 16h7M18 13v6m-3-3h6';

// push one attention state
const emitAttention = (page: Page, generation: number, attention: 'working' | 'finished' | 'question' | undefined) => {
  const agent = { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: attention === 'working' ? 'Working' : 'Ready', attention };
  return emitDashboard(page, { generation, agents: [agent], projects: [] });
};

// send and queue retain one prompt action while attention changes
test('sends or queues a note with the matching icon as agent attention changes', async ({ page }) => {
  await installDashboardSocket(page);
  const queuedPrompts: Array<{ prompt: string; attachments: unknown[] }> = [];
  const note = { id: 'note-identifier-001', text: 'Draft the weekly report' };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', attention: 'finished' }], projects: [] } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [note] } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queuedPrompts.push(request.postDataJSON() as { prompt: string; attachments: unknown[] });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  const send = page.getByRole('button', { name: /^Send note: Draft the weekly report/u });
  await expect(send).toHaveAttribute('title', 'Send note');
  await expect(send.locator('path')).toHaveAttribute('d', sendPath);
  await expect(send.locator('svg')).toHaveCSS('fill', 'none');
  await send.click();
  await expect.poll(() => queuedPrompts).toEqual([{ prompt: 'Draft the weekly report', attachments: [] }]);
  await expect(page.getByText('Queued', { exact: true })).toBeVisible();

  await expect.poll(() => dashboardSocketReady(page)).toBe(true);
  await emitAttention(page, 2, 'working');
  const queue = page.getByRole('button', { name: /^Queue note: Draft the weekly report/u });
  await expect(queue).toHaveAttribute('title', 'Queue note');
  await expect(queue.locator('path')).toHaveAttribute('d', queuePath);
  await expect(queue.locator('svg')).toHaveCSS('fill', 'none');
  await queue.click();
  await expect.poll(() => queuedPrompts).toHaveLength(2);
  expect(queuedPrompts[1]).toEqual({ prompt: 'Draft the weekly report', attachments: [] });

  // question state returns to send in the open flyout
  await emitAttention(page, 3, 'question');
  await expect(page.getByRole('button', { name: /^Send note: Draft the weekly report/u })).toBeVisible();
  const noteChoice = page.getByRole('button', { name: /^Draft the weekly report/u });
  await expect(noteChoice).toBeEnabled();
  await noteChoice.click();
  const pane = page.getByRole('dialog', { name: 'Note' });
  const paneSend = pane.getByRole('button', { name: 'Send note as prompt', exact: true });
  await expect(paneSend).toHaveAttribute('title', 'Send note as prompt');
  await expect(paneSend.locator('path')).toHaveAttribute('d', sendPath);
  await expect(paneSend.locator('svg')).toHaveCSS('fill', 'none');

  // working state updates the open pane
  await emitAttention(page, 4, 'working');
  const paneQueue = pane.getByRole('button', { name: 'Queue note as prompt', exact: true });
  await expect(paneQueue).toHaveAttribute('title', 'Queue note as prompt');
  await expect(paneQueue.locator('path')).toHaveAttribute('d', queuePath);
  await expect(paneQueue.locator('svg')).toHaveCSS('fill', 'none');

  // missing attention defaults to send
  await emitAttention(page, 5, undefined);
  await expect(pane.getByRole('button', { name: 'Send note as prompt', exact: true })).toBeVisible();
});

// Run a note from an idle worktree tab: the flyout explains Run becomes Launch and run, the
// pane toolbar offers a "Launch and run" pill, and both post the Launch-and-run route.
test('launches and runs a note from an idle worktree tab', async ({ page }) => {
  let runRequest: { url: string; persistedText: string } | undefined;
  const notes: Array<{ id: string; text: string }> = [{ id: 'note-identifier-001', text: 'Existing launch note' }];
  let created = 1;
  const worktree = { id: 'wt-main', projectId: 'atlas', label: 'main', path: '/worktrees/atlas', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main', launch: { kind: 'claude', origin: 'worktree' } };
  const adapters = { claude: { launchable: true, program: '/bin/claude', stateSource: 'both', turnCapture: true, bookmarks: true, inlineQuestions: false, commands: true, sandbox: false } };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters, agents: [], projects: [{ id: 'atlas', label: 'atlas', mode: 'repository', available: true, worktrees: [worktree] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'POST') {
      const note = { id: `note-identifier-00${++created}`, text: '' };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const noteMatch = /^\/api\/worktrees\/wt-main\/notes\/([^/]+)$/u.exec(url.pathname);
    if (noteMatch && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === noteMatch[1]);
      if (note !== undefined) note.text = (request.postDataJSON() as { text: string }).text;
      return route.fulfill({ json: note });
    }
    const runMatch = /^\/api\/worktrees\/wt-main\/notes\/([^/]+)\/run$/u.exec(url.pathname);
    if (runMatch && request.method() === 'POST') {
      // capture the note text the server would read at run time — proves the draft was persisted first
      runRequest = { url: url.pathname, persistedText: notes.find(candidate => candidate.id === runMatch[1])?.text ?? '' };
      return route.fulfill({ status: 201, json: { agentId: 'agent-2' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // the flyout explains that Run launches an agent first on this idle worktree
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await expect(page.getByText('No agent on this tab: Run becomes Launch and run (Claude on main).')).toBeVisible();
  const launch = page.getByRole('button', { name: /^Launch and run note: Existing launch note/u });
  await expect(launch).toHaveAttribute('title', 'Launch and run note');
  await expect(launch.locator('path')).toHaveCount(2);
  await expect(launch.locator('path').nth(0)).toHaveAttribute('d', 'M7 4v11l9-5.5L7 4Z');
  await expect(launch.locator('path').nth(1)).toHaveAttribute('d', 'M4 20h16');

  // author a note; the toolbar send becomes a Launch and run pill
  await page.getByRole('button', { name: '+ New note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Note' });
  await dialog.getByRole('textbox', { name: 'Note content' }).fill('Summarize the standup');
  const pill = dialog.getByRole('button', { name: 'Launch and run note' });
  await expect(pill).toHaveText('Launch and run');
  await pill.click();

  await expect.poll(() => runRequest?.url).toBe(`/api/worktrees/wt-main/notes/${notes[0]!.id}/run`);
  // the draft was persisted before the Run fired, so the server reads the current text
  expect(runRequest?.persistedText).toBe('Summarize the standup');
  await expect(page.getByRole('status').filter({ hasText: 'main is running the note' })).toBeVisible();
});
