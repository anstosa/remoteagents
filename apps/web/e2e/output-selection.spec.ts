import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes } from './pane-stream-mock.js';

// The selection toolbar over the streamed pane: selecting output (a terminal drag on
// desktop, a native long-press selection on a phone) reveals the create-note / append /
// add-to-prompt / copy actions and the yank + Ctrl+Shift+C copy shortcuts, and the
// composer keeps its own copy shortcuts. The component owns the terminal, touch scroll
// and tap-to-focus; this asserts the app wiring around a pane selection.

test('shows selection actions for a terminal drag selection and adds to the prompt', async ({ page }) => {
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/workspace', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  // Several rows down so the selectable row clears the top-left server switcher (the
  // stream writes top-down; the old snapshot bottom-aligned its text).
  await pushBytes(page, 'agent-1', '\r\n\r\n\r\n\r\n\r\n\r\n\r\n\r\nSelectable output text\r\n');
  await expect(page.locator('.log-status')).toHaveText('Live');
  const screen = page.locator('.log-canvas .xterm-screen');
  await expect(screen).toBeVisible();
  const selectedRow = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Selectable output text' });
  const [screenBounds, selectedRowBounds, cell] = await Promise.all([
    screen.boundingBox(),
    selectedRow.boundingBox(),
    page.locator('.log-canvas .xterm-char-measure-element').first().evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width / (element.textContent?.length ?? 1), height: bounds.height };
    })
  ]);
  const y = selectedRowBounds!.y + cell.height / 2;
  await page.mouse.move(screenBounds!.x + cell.width, y);
  await page.mouse.down();
  await page.mouse.move(screenBounds!.x + cell.width * 10, y, { steps: 4 });
  await page.mouse.up();

  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(page.locator('.log')).toHaveClass(/selection-active/u);
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Create note' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Copy' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).not.toHaveValue('');
});

test('a native output selection creates and appends notes, copies, and guards the composer', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 428, height: 952 }
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const notes: Array<{ id: string; text: string; title?: string }> = [];
  const savedNotes: string[] = [];
  let createdNotes = 0;
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { title?: string } | null;
      const note = { id: `note-identifier-00${++createdNotes}`, text: '', ...(payload?.title === undefined ? {} : { title: payload.title }) };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const noteMatch = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(url.pathname);
    if (noteMatch && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === noteMatch[1])!;
      note.text = (request.postDataJSON() as { text: string }).text;
      savedNotes.push(note.text);
      return route.fulfill({ json: note });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Prefix text before Selectable output text\r\n');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  // A phone renders the accessibility tree (screenReaderMode); select one word from it,
  // exactly as a native long-press would leave the browser range.
  const selectableRow = page.locator('.log-canvas .xterm-accessibility-tree [role="listitem"]', { hasText: 'Prefix text before Selectable output text' });
  await expect(selectableRow).toHaveText('Prefix text before Selectable output text');
  const selectWord = () => selectableRow.evaluate(row => {
    const text = row.firstChild!;
    const start = 'Prefix text before '.length;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + 'Selectable'.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await selectWord();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Selectable');

  // The selection does not steal terminal focus, and the toolbar offers the note/prompt
  // actions (Append is absent until a note is open).
  await expect(page.locator('.log')).not.toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Create note' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Append to note' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Add to prompt' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Copy' })).toBeVisible();

  await toolbar.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Selectable');

  await toolbar.getByRole('button', { name: 'Create note' }).click();
  await expect(page.getByRole('dialog', { name: 'Note' }).locator('header strong')).toHaveText('Selectable');
  const notePreview = page.getByLabel('Note preview');
  await expect(notePreview).toContainText('Selectable');
  const noteEditor = page.getByRole('textbox', { name: 'Note content' });
  await notePreview.click();
  await expect(noteEditor).toHaveValue('Selectable');
  await page.getByRole('button', { name: 'Show agent output' }).click();
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeHidden();
  await expect.poll(() => savedNotes).toContain('Selectable');

  // With a note open, Append is offered and appends.
  await selectWord();
  await expect(toolbar.getByRole('button', { name: 'Append to note' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Append to note' }).click();
  await expect.poll(() => savedNotes).toContain('Selectable\n\nSelectable');

  // Add to prompt fills the composer.
  await selectWord();
  await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Selectable');

  // The yank and Ctrl+Shift+C copy shortcuts do not fire while the composer owns keys.
  await page.evaluate(() => navigator.clipboard.writeText('prompt-shortcut-guard'));
  const guardedPrompt = page.getByRole('textbox', { name: 'Prompt' });
  await guardedPrompt.focus();
  await guardedPrompt.fill('Draft');
  await guardedPrompt.press('y');
  await expect(guardedPrompt).toHaveValue('Drafty');
  await guardedPrompt.press('Control+Shift+c');
  await expect(guardedPrompt).toHaveValue('Drafty');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('prompt-shortcut-guard');
  await guardedPrompt.blur();

  // With the composer unfocused, yank and Ctrl+Shift+C copy the output selection and flash.
  await selectWord();
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('y');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Selectable');
  const log = page.locator('.log');
  await expect(log).toHaveClass(/selection-copied/u);
  await expect(log).not.toHaveClass(/selection-copied/u);
  await selectWord();
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Selectable');
  await expect(log).toHaveClass(/selection-copied/u);

  await context.close();
});
