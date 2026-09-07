import { expect, test } from '@playwright/test';

// Run a note from the flyout on a tab that already has an agent: it posts the note's text
// through the normal prompt route and shows the same Queued status the note pane's send shows.
test('runs a note as a prompt on an agent tab and shows Queued', async ({ page }) => {
  let queuedPrompt: { prompt: string; attachments: unknown[] } | undefined;
  const note = { id: 'note-identifier-001', text: 'Draft the weekly report' };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [note] } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queuedPrompt = request.postDataJSON() as { prompt: string; attachments: unknown[] };
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  const flyout = page.getByRole('button', { name: /^Run note:/u });
  await expect(flyout).toBeVisible();
  await flyout.click();
  await expect.poll(() => queuedPrompt).toEqual({ prompt: 'Draft the weekly report', attachments: [] });
  await expect(page.getByText('Queued', { exact: true })).toBeVisible();
});

// Run a note from an idle worktree tab: the flyout explains Run becomes Launch and run, the
// pane toolbar offers a "Launch and run" pill, and both post the Launch-and-run route.
test('launches and runs a note from an idle worktree tab', async ({ page }) => {
  let runRequest: { url: string; persistedText: string } | undefined;
  const notes: Array<{ id: string; text: string }> = [];
  let created = 0;
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
  await page.getByRole('button', { name: 'Notes (0)' }).click();
  await expect(page.getByText('No agent on this tab: Run becomes Launch and run (Claude on main).')).toBeVisible();

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
