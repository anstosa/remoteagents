import { expect, test, type Page, type Route } from '@playwright/test';

type NoteCreatePayload = { title?: string; text?: string; attachments?: Array<{ name: string; data: string }> };

// serve one composer and delegate its note creation request
const mockComposerNoteSave = async (page: Page, createNote: (route: Route) => Promise<void> | void) => {
  await page.addInitScript(() => {
    // keep the dashboard socket inert
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // open the inert socket asynchronously
      constructor(readonly url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      // ignore fixture writes
      send() {}
      // close the fixture socket
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the local console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    // disable optional integrations
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    // let the test control note creation completion
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') return createNote(route);
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

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

test('saves composer attachments atomically and preserves text typed after the submitted snapshot', async ({ page }) => {
  let submitted: NoteCreatePayload | undefined;
  let finishSave!: () => void;
  // hold the response while the user starts a new draft
  const saveFinished = new Promise<void>(resolve => { finishSave = resolve; });
  await mockComposerNoteSave(page, async route => {
    submitted = route.request().postDataJSON() as NoteCreatePayload;
    await saveFinished;
    return route.fulfill({ status: 201, json: { id: 'note-identifier-001', title: submitted.title, text: submitted.text ?? '', attachments: [{ name: 'submitted.txt', size: 17 }] } });
  });

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  const fileInput = page.locator('.prompt input[type="file"]');
  await composer.fill('Save this draft with its file.');
  await fileInput.setInputFiles({ name: 'submitted.txt', mimeType: 'text/plain', buffer: Buffer.from('submitted context') });
  await composer.press('Control+s');
  await expect.poll(() => submitted).toMatchObject({
    text: 'Save this draft with its file.',
    attachments: [{ name: 'submitted.txt', data: Buffer.from('submitted context').toString('base64') }]
  });

  // preserve text typed after the submitted snapshot
  await composer.fill('A new draft typed while saving.');
  finishSave();
  await expect(composer).toHaveValue('A new draft typed while saving.');
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
});

test('saves attachment-only drafts and retains the entire draft when creation fails', async ({ page }) => {
  let submitted: NoteCreatePayload | undefined;
  await mockComposerNoteSave(page, route => {
    submitted = route.request().postDataJSON() as NoteCreatePayload;
    return route.fulfill({ status: 503, json: { error: 'temporary failure' } });
  });

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Prompt' });
  await page.locator('.prompt input[type="file"]').setInputFiles({ name: 'only-context.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment only') });
  await composer.focus();
  await composer.press('Control+s');

  await expect.poll(() => submitted).toMatchObject({
    text: '',
    attachments: [{ name: 'only-context.txt', data: Buffer.from('attachment only').toString('base64') }]
  });
  await expect(composer).toHaveValue('');
  await expect(page.getByLabel('Selected attachments')).toContainText('only-context.txt');
});
