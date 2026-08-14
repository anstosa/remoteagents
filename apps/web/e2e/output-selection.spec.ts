import { expect, test } from '@playwright/test';

test('shows selection actions for xterm canvas selections', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        this.url = String(url);
        window.setTimeout(() => {
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          if (this.url.includes('/ws/logs/')) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: 'Selectable output text\n' }) }));
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
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/workspace', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'terminal-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByLabel('Live log')).toBeVisible();
  await expect(page.locator('.log-status')).toHaveText('Live');
  await expect(page.locator('.terminal-frame.active .xterm-screen')).toBeVisible();
  const screen = page.locator('.terminal-frame.active .xterm-screen');
  const selectedRow = page.locator('.terminal-frame.active .xterm-rows > div', { hasText: 'Selectable output text' });
  const [screenBounds, selectedRowBounds, cell] = await Promise.all([
    screen.boundingBox(),
    selectedRow.boundingBox(),
    page.locator('.terminal-frame.active .xterm-char-measure-element').first().evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width / (element.textContent?.length ?? 1), height: bounds.height };
    })
  ]);
  expect(screenBounds).not.toBeNull();
  expect(selectedRowBounds).not.toBeNull();
  const y = selectedRowBounds!.y + cell.height / 2;
  await page.mouse.move(screenBounds!.x + cell.width, y);
  await page.mouse.down();
  await page.mouse.move(screenBounds!.x + cell.width * 10, y, { steps: 4 });
  await page.mouse.up();

  const toolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(page.locator('.log')).toHaveClass(/selection-active/u);
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Add to prompt' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).not.toHaveValue('');
});

// inherit the isolated test server origin
test('long press selects mobile output without entering terminal input mode', async ({ browser, baseURL }) => {
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
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        this.url = String(url);
        window.setTimeout(() => {
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          if (this.url.includes('/ws/logs/')) {
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: 'Prefix text before Selectable output text\n' }) }));
          }
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
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'terminal-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
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
  await expect(page.getByLabel('Live log')).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  const dispatchPointer = (type: string, pointerId: number) => page.locator('.log-canvas').dispatchEvent(type, {
    bubbles: true,
    clientX: 80,
    clientY: 160,
    pointerId,
    pointerType: 'touch'
  });

  const selectableRow = page.locator('.terminal-frame.active .xterm-accessibility-tree [role="listitem"]', { hasText: 'Prefix text before Selectable output text' });
  await expect(selectableRow).toHaveText('Prefix text before Selectable output text');
  const selectionGeometry = await selectableRow.evaluate(row => {
    const prefixLength = 'Prefix text before '.length;
    const text = row.firstChild!;
    const range = document.createRange();
    range.setStart(text, prefixLength);
    range.setEnd(text, prefixLength + 'Selectable'.length);
    const selectionBounds = range.getBoundingClientRect();
    const measure = row.closest('.xterm')!.querySelector<HTMLElement>('.xterm-char-measure-element')!;
    const measuredCharacters = measure.textContent?.length ?? 0;
    const cellWidth = measure.getBoundingClientRect().width / measuredCharacters;
    return {
      cellWidth,
      expectedLeft: row.getBoundingClientRect().left + cellWidth * prefixLength,
      expectedWidth: cellWidth * 'Selectable'.length,
      bottom: selectionBounds.bottom,
      height: selectionBounds.height,
      left: selectionBounds.left,
      rowHeight: row.getBoundingClientRect().height,
      width: selectionBounds.width
    };
  });
  expect(selectionGeometry.left).toBeCloseTo(selectionGeometry.expectedLeft, 0);
  expect(selectionGeometry.width).toBeCloseTo(selectionGeometry.expectedWidth, 0);
  expect(selectionGeometry.height).toBeLessThanOrEqual(selectionGeometry.rowHeight + 1);
  const rowBounds = await selectableRow.boundingBox();
  expect(rowBounds).not.toBeNull();
  const longPressPoint = { clientX: selectionGeometry.expectedLeft + selectionGeometry.cellWidth * 2, clientY: rowBounds!.y + rowBounds!.height / 2 };
  await selectableRow.dispatchEvent('pointerdown', { bubbles: true, ...longPressPoint, pointerId: 1, pointerType: 'touch' });
  // Android may cancel the pointer when native selection takes ownership of
  // the long press. The eventual compatibility click must remain consumed.
  await page.waitForTimeout(200);
  await selectableRow.dispatchEvent('pointercancel', { bubbles: true, ...longPressPoint, pointerId: 1, pointerType: 'touch' });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  const nativeMenuAllowed = await selectableRow.evaluate((row, point) => row.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    ...point
  })), longPressPoint);
  expect(nativeMenuAllowed).toBe(true);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
  await selectableRow.evaluate(row => {
    // Playwright cannot display Android's native handles, so emulate only the
    // browser's range creation after the uncancelled long-press context menu.
    row.dispatchEvent(new Event('selectionstart', { bubbles: true, cancelable: true }));
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
  await selectableRow.dispatchEvent('click', { bubbles: true, ...longPressPoint });

  await expect(page.locator('.log')).not.toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('Selectable');
  const nativeSelectionStyle = await selectableRow.evaluate(row => {
    const style = getComputedStyle(row, '::selection');
    return { background: style.backgroundColor, color: style.color };
  });
  expect(nativeSelectionStyle.background).toBe('rgb(203, 166, 247)');
  expect(nativeSelectionStyle.color).toBe('rgb(17, 17, 27)');
  const selectionToolbar = page.getByRole('toolbar', { name: 'Output selection actions' });
  await expect(selectionToolbar).toBeVisible();
  await expect(selectionToolbar.getByRole('button', { name: 'Create note' })).toBeVisible();
  await expect(selectionToolbar.getByRole('button', { name: 'Append to note' })).toHaveCount(0);
  await expect(selectionToolbar.getByRole('button', { name: 'Add to prompt' })).toBeVisible();
  await expect(selectionToolbar.getByRole('button', { name: 'Copy' })).toBeVisible();
  expect((await selectionToolbar.boundingBox())!.y).toBeGreaterThanOrEqual(selectionGeometry.bottom);
  await expect(page.locator('.log-canvas')).toHaveCSS('filter', 'none');
  await selectionToolbar.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Selectable');
  await selectionToolbar.getByRole('button', { name: 'Create note' }).click();
  await expect(page.getByRole('dialog', { name: 'Note' }).locator('header strong')).toHaveText('Selectable');
  const notePreview = page.getByLabel('Note preview');
  await expect(notePreview).toContainText('Selectable');
  const noteEditor = page.getByRole('textbox', { name: 'Note content' });
  await notePreview.click();
  await expect(noteEditor).toHaveValue('Selectable');
  const restoreNote = page.getByRole('button', { name: 'Restore note' });
  await expect(restoreNote).toHaveAttribute('aria-pressed', 'true');
  await restoreNote.click();
  await expect(page.getByRole('button', { name: 'Expand note' })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => savedNotes).toContain('Selectable');
  await selectableRow.evaluate(row => {
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
  await expect(selectionToolbar.getByRole('button', { name: 'Append to note' })).toBeVisible();
  await selectionToolbar.getByRole('button', { name: 'Append to note' }).click();
  await expect.poll(() => savedNotes).toContain('Selectable\n\nSelectable');
  await selectableRow.evaluate(row => {
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
  await selectionToolbar.getByRole('button', { name: 'Add to prompt' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Selectable');
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
  await expect(page.locator('.terminal-frame.active .xterm-accessibility')).toHaveCSS('pointer-events', 'auto');
  await expect(page.locator('.terminal-frame.active .xterm-accessibility-tree')).toHaveCSS('user-select', 'text');
  await page.locator('.terminal-frame.active .xterm-accessibility-tree').evaluate(tree => {
    const row = tree.querySelector<HTMLElement>('[role="listitem"]');
    const rowText = row?.firstChild;
    if (rowText !== null && rowText !== undefined) {
      window.getSelection()?.collapse(rowText, 0);
      document.dispatchEvent(new Event('selectionchange'));
    }
    const marker = document.createElement('span');
    marker.textContent = 'Selected terminal output';
    tree.append(marker);
    const range = document.createRange();
    range.selectNodeContents(marker);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  const log = page.locator('.log');
  const outputPane = page.locator('.log-output');
  await expect(log).toHaveClass(/selection-active/u);
  await expect(page.locator('.log-canvas')).toHaveCSS('filter', 'none');
  const selectionTreatment = await outputPane.evaluate(element => {
    const border = getComputedStyle(element, '::after');
    const highlight = getComputedStyle(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!, '::selection');
    return { borderColor: border.borderTopColor, glow: border.boxShadow, highlight: highlight.backgroundColor };
  });
  expect(selectionTreatment.borderColor).toBe('rgb(184, 184, 184)');
  expect(selectionTreatment.glow).toContain('rgba(208, 208, 208');
  expect(selectionTreatment.highlight).toBe('rgb(203, 166, 247)');
  expect(await log.evaluate(element => getComputedStyle(element, '::after').content)).toBe('none');
  const [selectedOutputBounds, selectedNoteBounds] = await Promise.all([outputPane.boundingBox(), page.getByRole('dialog', { name: 'Note' }).boundingBox()]);
  expect(selectedOutputBounds!.y + selectedOutputBounds!.height).toBeCloseTo(selectedNoteBounds!.y, 0);
  await page.keyboard.press('y');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Selected terminal output');
  await expect(log).toHaveClass(/selection-copied/u);
  expect(await page.locator('.terminal-frame.active .xterm-accessibility-tree span').evaluate(element => getComputedStyle(element, '::selection').backgroundColor)).toBe('rgb(166, 227, 161)');
  await expect(log).not.toHaveClass(/selection-copied/u);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('Control+Shift+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Selected terminal output');
  await expect(log).toHaveClass(/selection-copied/u);
  await expect(log).not.toHaveClass(/selection-copied/u);
  const selectedCanvas = page.locator('.log-canvas');
  await selectedCanvas.dispatchEvent('pointerdown', { bubbles: true, clientX: 12, clientY: 12, pointerId: 3, pointerType: 'touch' });
  await page.evaluate(() => {
    // Emulate the browser collapsing its native range after pointer-down but
    // before dispatching the compatibility click.
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  await selectedCanvas.dispatchEvent('pointerup', { bubbles: true, clientX: 12, clientY: 12, pointerId: 3, pointerType: 'touch' });
  await selectedCanvas.dispatchEvent('click', { bubbles: true, clientX: 12, clientY: 12 });
  await expect(log).not.toHaveClass(/selection-active/u);
  await expect(log).not.toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('');

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Copy this prompt selection');
  await prompt.selectText();
  await prompt.press('Control+C');
  await expect(prompt).toHaveClass(/selection-copied/u);
  await expect.poll(() => prompt.evaluate(element => getComputedStyle(element, '::selection').backgroundColor)).toBe('rgb(166, 227, 161)');
  await expect(prompt).not.toHaveClass(/selection-copied/u);
  await prompt.evaluate(input => input.setSelectionRange(input.value.length, input.value.length));
  await prompt.blur();

  await dispatchPointer('pointerdown', 2);
  await dispatchPointer('pointerup', 2);
  await page.locator('.log-canvas').dispatchEvent('click', { bubbles: true, clientX: 80, clientY: 160 });
  await expect(page.locator('.log')).toHaveClass(/input-active/u);
  const inputTreatment = await outputPane.evaluate(element => {
    const border = getComputedStyle(element, '::after');
    return { borderColor: border.borderTopColor, glow: border.boxShadow };
  });
  expect(inputTreatment.borderColor).toBe('rgb(137, 220, 235)');
  expect(inputTreatment.glow).not.toBe('none');
  expect(inputTreatment.glow).toContain('inset');
  await expect(page.locator('.prompt-composer')).toBeHidden();
  await expect(page.locator('.mobile-terminal-keys')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to prompt' })).toHaveCount(0);

  await context.close();
});
