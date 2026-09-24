import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, paneAckTotal, seedPaneSize, pushBytes } from './pane-stream-mock.js';

// The selection toolbar over the streamed pane: selecting output (a terminal drag on
// desktop, a native long-press selection on a phone) reveals the create-note / append /
// add-to-prompt / copy actions and the yank + Ctrl+Shift+C copy shortcuts, and the
// composer keeps its own copy shortcuts. The component owns the terminal, touch scroll
// and tap-to-focus; this asserts the app wiring around a pane selection.

// serve the minimal agent panel contract for selection-only regressions
const routeSelectionApi = (page: Page) => page.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  // authenticate the test console
  if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
  // expose one selectable agent
  if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/workspace', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
  // disable optional push setup
  if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
  // authorize the mocked pane
  if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
  // return no saved prompts
  if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
  // return no prompt history
  if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
  return route.fulfill({ status: 404, json: { error: 'not mocked' } });
});

// create the browser range left by a native long press
const selectNativeRange = (row: Locator, start: number, end: number) => row.evaluate((element, offsets) => {
  const range = document.createRange();
  range.setStart(element.firstChild!, offsets.start);
  range.setEnd(element.firstChild!, offsets.end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}, { start, end });

test('shows selection actions for a terminal drag selection and adds to the prompt', async ({ page }) => {
  await installPaneMock(page);
  await routeSelectionApi(page);

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

// repaint xterm's selection rather than only toggling a native selection class
test('flashes a copied desktop selection green then restores its highlight', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', `${'\r\n'.repeat(8)}Copy feedback selection`);
  const row = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Copy feedback selection' });
  await expect(row).toBeVisible();
  const bounds = await row.boundingBox();
  expect(bounds).not.toBeNull();
  const selectedY = bounds!.y + bounds!.height / 2;
  await page.mouse.move(bounds!.x + 1, selectedY);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 90, selectedY, { steps: 4 });
  await page.mouse.up();

  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(toolbar).toBeVisible();
  const highlight = page.locator('.log-canvas .xterm-selection > div').first();
  await expect(highlight).toHaveCSS('background-color', 'rgb(203, 166, 247)');

  // exercise both focused terminal shortcuts and the toolbar's unfocused selection
  for (const action of ['Control+c', 'toolbar', 'y', 'Control+Shift+c']) {
    // clear clipboard evidence before each copy path
    await page.evaluate(() => navigator.clipboard.writeText(''));
    // toolbar copy must also repaint an inactive xterm selection
    if (action === 'toolbar') {
      await page.getByRole('textbox', { name: 'Prompt' }).focus();
      await toolbar.getByRole('button', { name: 'Copy' }).click();
    } else {
      await page.locator('.log-canvas .xterm-helper-textarea').focus();
      await page.keyboard.press(action);
    }
    await expect(highlight).toHaveCSS('background-color', 'rgb(166, 227, 161)');
    // wait for clipboard completion independently of the visible flash
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
    await expect(highlight).toHaveCSS('background-color', 'rgb(203, 166, 247)');
    await expect(toolbar).toBeVisible();
  }
});

// keep native selection intact through copy feedback and follow-up actions
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
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', title: 'Ready', queuedPromptCount: 0 }], projects: [] } });
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
  // restore the same word after note and prompt actions
  const selectWord = () => selectNativeRange(selectableRow, 'Prefix text before '.length, 'Prefix text before Selectable'.length);
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
  await expect(page.locator('.log')).toHaveClass(/selection-copied/u);
  await expect(page.locator('.log')).not.toHaveClass(/selection-copied/u);
  // restoring highlight colors must not replace the native range's text node
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Selectable');

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

// exercise platform-specific xterm selection notification paths
for (const platform of ['Linux x86_64', 'Win32', 'MacIntel']) {
  // preserve terminal selection while live output waits behind it
  test(`freezes desktop output while a terminal selection is active on ${platform}`, async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // choose xterm's platform behavior before loading the application
    await page.addInitScript(value => Object.defineProperty(navigator, 'platform', { get: () => value }), platform);
    await installPaneMock(page);
    await routeSelectionApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', `${'\r\n'.repeat(8)}Freeze selected output`);
    await expect(page.locator('.log-status')).toHaveText('Live');

    const selectedRow = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Freeze selected output' });
    await expect(selectedRow).toBeVisible();
    // settle focus changes before beginning the drag
    await page.locator('.log-canvas .xterm-helper-textarea').focus();
    await page.waitForTimeout(100);
    const selectedRowBounds = await selectedRow.boundingBox();
    const selectedY = selectedRowBounds!.y + selectedRowBounds!.height / 2;
    await page.mouse.move(selectedRowBounds!.x + 1, selectedY);
    await page.mouse.down();
    await page.mouse.move(selectedRowBounds!.x + selectedRowBounds!.width / 8, selectedY, { steps: 4 });
    const renderedBeforeMouseUp = await selectedRow.textContent();
    const acknowledgedBeforeMouseUp = await paneAckTotal(page, 'agent-1');
    await pushBytes(page, 'agent-1', '\r\x1b[2Karrived during drag');
    // give the real parser a chance to overwrite the row while the mouse stays down
    await page.waitForTimeout(100);
    await expect(selectedRow).toHaveText(renderedBeforeMouseUp!);
    expect(await paneAckTotal(page, 'agent-1')).toBe(acknowledgedBeforeMouseUp);
    await page.mouse.up();

    const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
    await expect(page.locator('.log')).toHaveClass(/selection-active/u);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Copy' }).click();
    // read the first copied selection
    const selectedText = await page.evaluate(() => navigator.clipboard.readText());
    expect(selectedText).not.toBe('');
    const renderedText = await selectedRow.textContent();
    const acknowledgedBeforePause = await paneAckTotal(page, 'agent-1');

    await pushBytes(page, 'agent-1', '\r\x1b[2Kbuffered first');
    await pushBytes(page, 'agent-1', ' + second\r\n');
    await toolbar.getByRole('button', { name: 'Copy' }).click();

    await expect(selectedRow).toHaveText(renderedText!);
    // read the selection copied after output arrived
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selectedText);
    expect(await paneAckTotal(page, 'agent-1')).toBe(acknowledgedBeforePause);

    await page.mouse.click(selectedRowBounds!.x + selectedRowBounds!.width * .75, selectedY);
    await expect(toolbar).toBeHidden();
    await expect(page.locator('.log-canvas .xterm-rows > div', { hasText: 'buffered first + second' })).toBeVisible();
    // wait for the ordered flush to be acknowledged
    await expect.poll(() => paneAckTotal(page, 'agent-1')).toBeGreaterThan(acknowledgedBeforePause);
  });
}

// release temporary pauses even when a mouse gesture never creates selected text
for (const ending of ['pointerup', 'pointercancel', 'blur']) {
  // exercise each gesture completion path without an existing selection
  test(`resumes output after an empty selection gesture ends with ${ending}`, async ({ page }) => {
    await installPaneMock(page);
    await routeSelectionApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', `${'\r\n'.repeat(8)}Original output`);
    const row = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Original output' });
    await expect(row).toBeVisible();
    const bounds = (await row.boundingBox())!;
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await pushBytes(page, 'agent-1', '\r\x1b[2KReleased output');
    // finish normally or reproduce the browser's cancellation/focus-loss signal
    if (ending === 'pointerup') await page.mouse.up();
    else await page.evaluate(type => window.dispatchEvent(new Event(type)), ending);
    await expect(page.locator('.log-canvas .xterm-rows > div', { hasText: 'Released output' })).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Output selection actions' })).toBeHidden();
    await page.mouse.up();
  });
}

// leave application-owned mouse gestures live rather than treating them as selection
test('keeps output live during a mouse-reporting drag', async ({ page }) => {
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', `${'\r\n'.repeat(8)}Mouse reporting\x1b[?1000h`);
  const row = page.locator('.log-canvas .xterm-rows > div', { hasText: 'Mouse reporting' });
  await expect(row).toBeVisible();
  const bounds = (await row.boundingBox())!;
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 90, bounds.y + bounds.height / 2);
  await pushBytes(page, 'agent-1', '\r\x1b[2KLive application output');
  await expect(page.locator('.log-canvas .xterm-rows > div', { hasText: 'Live application output' })).toBeVisible();
  await page.mouse.up();
  await expect(page.getByRole('toolbar', { name: 'Output selection actions' })).toBeHidden();
});

// preserve native phone selection while live output waits behind it
test('freezes coarse-pointer output while a native selection is active', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 428, height: 952 }
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await installPaneMock(page);
  await routeSelectionApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Freeze native selected output');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  const selectedRow = page.locator('.log-canvas .xterm-accessibility-tree [role="listitem"]', { hasText: 'Freeze native selected output' });
  await expect(selectedRow).toHaveText('Freeze native selected output');
  await selectNativeRange(selectedRow, 0, 'Freeze'.length);

  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(page.locator('.log')).toHaveClass(/selection-active/u);
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: 'Copy' }).click();
  // read the native selection before output arrives
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Freeze');
  const acknowledgedBeforePause = await paneAckTotal(page, 'agent-1');

  await pushBytes(page, 'agent-1', '\r\x1b[2Kbuffered first');
  await pushBytes(page, 'agent-1', ' + second\r\n');
  await toolbar.getByRole('button', { name: 'Copy' }).click();

  expect(await paneAckTotal(page, 'agent-1')).toBe(acknowledgedBeforePause);
  await expect(selectedRow).toHaveText('Freeze native selected output');
  // read the live browser selection after output arrives
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Freeze');
  // read the copy action after output arrives
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Freeze');

  // clear the browser range without relying on xterm's inside-row collapse
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(toolbar).toBeHidden();
  const flushedRow = page.locator('.log-canvas .xterm-accessibility-tree [role="listitem"]', { hasText: 'buffered first + second' });
  await expect(flushedRow).toBeVisible();
  // wait for the ordered flush to be acknowledged
  await expect.poll(() => paneAckTotal(page, 'agent-1')).toBeGreaterThan(acknowledgedBeforePause);

  // restore native selection after the first flush
  await selectNativeRange(flushedRow, 0, 'buffered'.length);
  await expect(toolbar).toBeVisible();
  // read the restored native selection
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('buffered');
  const acknowledgedBeforeOutsideClear = await paneAckTotal(page, 'agent-1');
  await pushBytes(page, 'agent-1', '\x1b[1A\r\x1b[2Koutside clear released\r\n');
  expect(await paneAckTotal(page, 'agent-1')).toBe(acknowledgedBeforeOutsideClear);
  await expect(flushedRow).toHaveText('buffered first + second');

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  // move the collapsed browser selection outside the output
  await prompt.evaluate(element => {
    window.getSelection()?.collapse(element, 0);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(toolbar).toBeHidden();
  await expect(page.locator('.log-canvas .xterm-accessibility-tree [role="listitem"]', { hasText: 'outside clear released' })).toBeVisible();
  // wait for the outside clear to release output
  await expect.poll(() => paneAckTotal(page, 'agent-1')).toBeGreaterThan(acknowledgedBeforeOutsideClear);

  await context.close();
});
