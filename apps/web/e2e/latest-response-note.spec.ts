import { expect, test } from '@playwright/test';

test('saves the newest response with at least fifty words and only highlights current overflowing replies', async ({ page }) => {
  const notes: Array<{ id: string; text: string; title?: string }> = [];
  const savedTexts: string[] = [];
  // define exact response-size boundaries
  const fortyNineWordResponse = Array.from({ length: 49 }, (_value, index) => `short-${index + 1}`).join(' ');
  const fiftyWordResponse = Array.from({ length: 50 }, (_value, index) => `boundary-${index + 1}`).join(' ');
  const firstResponse = ['Summary', '', '- Run `pnpm test` before saving', ...Array.from({ length: 24 }, (_value, index) => `- Detail ${index + 1}`)].join('\n');
  let historyAnswer = fortyNineWordResponse;
  let created = 0;
  await page.addInitScript(() => {
    const sockets: MockWebSocket[] = [];
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        this.url = String(url);
        sockets.push(this);
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
    Object.defineProperty(window, '__emitLogFrame', {
      value: (frame: { text: string; latestAssistantMessage?: string; latestAssistantMessageOverflows?: boolean }) => sockets.find(socket => socket.url.includes('/ws/logs/'))?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ v: 1, type: 'reset', ...frame }) }))
    });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // return the current completed history fixture
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [{ id: 'prompt-history-001', text: 'Previous request', createdAt: '2026-08-12T12:00:00.000Z', answer: historyAnswer, answeredAt: '2026-08-12T12:01:00.000Z' }] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { title?: string } | null;
      const note = { id: `note-identifier-00${++created}`, text: '', ...(payload?.title === undefined ? {} : { title: payload.title }) };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const noteMatch = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(url.pathname);
    if (noteMatch && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === noteMatch[1])!;
      note.text = (request.postDataJSON() as { text: string }).text;
      savedTexts.push(note.text);
      return route.fulfill({ json: note });
    }
    if (noteMatch && request.method() === 'PATCH') {
      const note = notes.find(candidate => candidate.id === noteMatch[1])!;
      note.title = (request.postDataJSON() as { title: string }).title;
      return route.fulfill({ json: note });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const notesButton = page.getByRole('button', { name: 'Notes' });
  await expect(notesButton).toBeEnabled({ timeout: 15_000 });
  const emit = async (text: string, latestAssistantMessage?: string, latestAssistantMessageOverflows?: boolean) => await page.evaluate(([nextText, message, overflows]) => (
    window as unknown as { __emitLogFrame: (frame: { text: string; latestAssistantMessage?: string; latestAssistantMessageOverflows?: boolean }) => void }
  ).__emitLogFrame({ text: nextText, ...(message === undefined ? {} : { latestAssistantMessage: message, latestAssistantMessageOverflows: overflows }) }), [text, latestAssistantMessage, latestAssistantMessageOverflows] as const);

  const saveLatest = page.getByRole('button', { name: 'Save latest response' });
  await emit('Short response complete', 'Short response', false);
  await expect(notesButton).not.toHaveClass(/latest-response-available/u);
  await notesButton.click();
  await expect(saveLatest).toBeDisabled();
  await notesButton.click();

  historyAnswer = fiftyWordResponse;
  await notesButton.click();
  await expect(saveLatest).toBeEnabled();
  await notesButton.click();

  historyAnswer = firstResponse;
  await notesButton.click();
  await expect(saveLatest).toBeVisible();
  await saveLatest.click();
  const pane = page.getByRole('dialog', { name: 'Note' });
  const noteTitle = pane.locator('header strong');
  const renameNote = page.getByRole('button', { name: 'Rename note' });
  await expect(noteTitle).toHaveText('Summary');
  const [titleBounds, renameBounds] = await Promise.all([noteTitle.boundingBox(), renameNote.boundingBox()]);
  expect(renameBounds!.x - (titleBounds!.x + titleBounds!.width)).toBeLessThan(12);
  await renameNote.click();
  const noteName = page.getByRole('textbox', { name: 'Note name' });
  await expect(noteName).toHaveValue('Summary');
  await noteName.fill('Release checklist');
  await page.getByRole('button', { name: 'Save note name' }).click();
  await expect(pane.locator('header strong')).toHaveText('Release checklist');
  const preview = page.getByLabel('Note preview');
  await expect(preview).toContainText('Summary');
  await expect(preview).toContainText('Detail 1');
  await expect(preview.locator('code')).toHaveText('pnpm test');
  await expect(page.getByRole('textbox', { name: 'Note content' })).toHaveCount(0);
  await preview.click();
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await expect(editor).toHaveValue(firstResponse);
  await expect(notesButton).not.toHaveClass(/latest-response-available/u);
  await expect.poll(() => savedTexts).toContain(firstResponse);

  await page.getByRole('button', { name: 'Close note' }).click();
  await notesButton.click();
  await expect(page.getByRole('button', { name: 'Release checklist', exact: true })).toBeVisible();
  await notesButton.click();

  await emit('Same completed response refreshed', firstResponse, true);
  await expect(notesButton).not.toHaveClass(/latest-response-available/u);
  await notesButton.click();
  await expect(saveLatest).toBeVisible();
  await expect(saveLatest).toBeDisabled();
  await notesButton.click();

  const secondResponse = `${firstResponse}\n- New completion`;
  await emit('A different long response complete', secondResponse, true);
  await expect(notesButton).toHaveClass(/latest-response-available/u);
  const dot = await notesButton.evaluate(element => {
    const style = getComputedStyle(element, '::before');
    return { content: style.content, left: Number.parseFloat(style.left), top: Number.parseFloat(style.top), width: Number.parseFloat(style.width) };
  });
  expect(dot.content).not.toBe('none');
  expect(dot.left).toBeLessThan(8);
  expect(dot.top).toBeLessThan(8);
  expect(dot.width).toBeGreaterThan(0);

  await notesButton.click();
  await expect(page.getByRole('button', { name: 'Save latest response' })).toBeVisible();
});
