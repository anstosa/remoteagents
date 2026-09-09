import { expect, test } from '@playwright/test';

// Ctrl+S while typing in the composer saves the current text as a new Note and clears the prompt.
test('saves the composer draft as a note and clears the prompt on Ctrl+S', async ({ page }) => {
  const notes: Array<{ id: string; text: string; title?: string }> = [];
  const posted: Array<{ title?: string; text?: string }> = [];
  let created = 0;
  await page.addInitScript(() => {
    // keep the dashboard socket inert so the composer renders without a live connection
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { title?: string; text?: string };
      posted.push(payload);
      const note = { id: `note-identifier-00${++created}`, text: payload.text ?? '', ...(payload.title === undefined ? {} : { title: payload.title }) };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  await expect(composer).toBeVisible();

  // an empty composer has no draft to save: Ctrl+S posts nothing
  await composer.focus();
  await composer.press('Control+s');
  await composer.fill('Draft this idea into a note');
  await composer.press('Control+s');

  // the draft is posted as one titled note (title derived from its first line), then the composer clears
  await expect.poll(() => posted).toEqual([{ title: 'Draft this idea into a note', text: 'Draft this idea into a note' }]);
  await expect(composer).toHaveValue('');

  // the new note appears in the refreshed notes fly-out
  const notesButton = page.getByRole('button', { name: 'Notes (1)' });
  await expect(notesButton).toBeVisible();
  await notesButton.click();
  await expect(page.getByRole('button', { name: 'Draft this idea into a note', exact: true })).toBeVisible();
});
