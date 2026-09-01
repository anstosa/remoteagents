import { expect, test } from '@playwright/test';

test('saves prompts per agent and consumes a saved prompt back into the composer', async ({ page }) => {
  const savedPromptText = 'Review the release risks.';
  let saved = [{ id: 'saved-prompt-001', text: savedPromptText }];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: saved } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'POST') {
      const prompt = request.postDataJSON() as { prompt: string };
      const created = { id: 'saved-prompt-002', text: prompt.prompt };
      saved = [created, ...saved];
      return route.fulfill({ status: 201, json: created });
    }
    const consumed = /^\/api\/agents\/agent-1\/saved-prompts\/([^/]+)$/u.exec(url.pathname);
    if (consumed && request.method() === 'DELETE') {
      const prompt = saved.find(candidate => candidate.id === decodeURIComponent(consumed[1]!));
      saved = saved.filter(candidate => candidate.id !== prompt?.id);
      return prompt === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ json: prompt });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const saveGroup = page.getByRole('group', { name: 'Saved prompt controls' });
  const save = saveGroup.getByRole('button', { name: 'Save', exact: true });
  await expect(save.locator('svg')).toHaveCount(1);
  const savedToggle = saveGroup.getByRole('button', { name: 'Saved prompts (1)' });
  await expect(saveGroup.locator('.save-prompt + .saved-prompts-toggle')).toHaveCount(1);
  await expect(savedToggle.locator('.saved-prompts-count')).toHaveText('1');
  const [saveBounds, toggleBounds] = await Promise.all([save.boundingBox(), savedToggle.boundingBox()]);
  expect(saveBounds).not.toBeNull();
  expect(toggleBounds).not.toBeNull();
  expect(Math.abs(saveBounds!.x + saveBounds!.width - toggleBounds!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(saveBounds!.y - toggleBounds!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(saveBounds!.height - toggleBounds!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(toggleBounds!.width - toggleBounds!.height)).toBeLessThanOrEqual(1);
  const badgeBounds = await savedToggle.locator('.saved-prompts-count').boundingBox();
  expect(badgeBounds).not.toBeNull();
  expect(badgeBounds!.x + badgeBounds!.width / 2).toBeGreaterThan(toggleBounds!.x + toggleBounds!.width * .8);
  expect(badgeBounds!.y + badgeBounds!.height / 2).toBeLessThan(toggleBounds!.y + toggleBounds!.height * .2);
  await expect(savedToggle).toBeEnabled();
  await savedToggle.click();
  const savedPanel = page.locator('.saved-prompts-panel');
  const savedRow = page.getByRole('button', { name: savedPromptText, exact: true });
  await expect(savedPanel).toBeVisible();
  await expect(savedPanel).toHaveClass(/more-menu/u);
  await expect(savedPanel.locator('header strong')).toHaveText('Saved prompts');
  await expect(savedPanel.locator('.saved-prompt-position')).toHaveCount(0);
  await expect(savedPanel.getByText('Select one to move it back into the prompt.')).toHaveCount(0);
  const [panelBounds, rowBounds, viewportWidth] = await Promise.all([savedPanel.boundingBox(), savedRow.boundingBox(), page.evaluate(() => innerWidth)]);
  expect(panelBounds).not.toBeNull();
  expect(rowBounds).not.toBeNull();
  expect(panelBounds!.width).toBeGreaterThanOrEqual(viewportWidth - 17);
  expect(panelBounds!.width).toBeLessThanOrEqual(viewportWidth - 15);
  expect(rowBounds!.height).toBeLessThanOrEqual(56);
  expect(await savedRow.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      borderWidth: style.borderWidth,
      boxShadow: style.boxShadow,
      paddingBlock: `${style.paddingTop} ${style.paddingBottom}`
    };
  })).toEqual({
    background: 'rgba(0, 0, 0, 0)',
    borderWidth: '0px',
    boxShadow: 'none',
    paddingBlock: '11.2px 11.2px'
  });
  await savedRow.hover();
  await expect(savedRow).toHaveCSS('background-color', 'rgb(49, 50, 68)');
  await savedRow.click();

  await expect(prompt).toHaveValue(savedPromptText);
  await expect(saveGroup.locator('.saved-prompts-toggle')).toHaveCount(0);
  expect(await save.evaluate(element => {
    const style = getComputedStyle(element);
    return style.borderTopRightRadius === style.borderTopLeftRadius && style.borderBottomRightRadius === style.borderBottomLeftRadius;
  })).toBe(true);

  await prompt.fill('Summarize the release risks.');
  await expect(saveGroup.locator('+ .queue-prompt-group .queue')).toHaveAttribute('aria-label', 'Queue');
  await expect(saveGroup.locator('+ .queue-prompt-group .queue')).toHaveText('');
  await prompt.press('Control+s');

  const confirmed = saveGroup.getByRole('button', { name: 'Saved', exact: true });
  await expect(confirmed).toHaveClass(/saved/u);
  await expect(confirmed.locator('svg')).toHaveCount(1);
  await expect(prompt).toHaveValue('');
  const restoredToggle = saveGroup.getByRole('button', { name: 'Saved prompts (1)' });
  await expect(restoredToggle).toBeEnabled();
  await expect(restoredToggle.locator('.saved-prompts-count')).toHaveText('1');
  expect(saved).toEqual([{ id: 'saved-prompt-002', text: 'Summarize the release risks.' }]);
});

test('closes the saved prompts flyout after selecting one of several drafts', async ({ page }) => {
  const saved = [
    { id: 'saved-prompt-001', text: 'First saved draft' },
    { id: 'saved-prompt-002', text: 'Second saved draft' }
  ];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: saved } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts/saved-prompt-001' && request.method() === 'DELETE') return route.fulfill({ json: saved[0] });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Saved prompts (2)' }).click();
  const panel = page.locator('.saved-prompts-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'First saved draft', exact: true }).click();

  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: 'Saved prompts (1)' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('First saved draft');
});

// keep long saved-prompt lists within one scrollable flyout
test('scrolls a long saved prompt list within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  // build enough drafts to exceed the viewport
  const saved = Array.from({ length: 30 }, (_, index) => ({ id: `saved-prompt-${index}`, text: `Saved draft ${index + 1}` }));
  // serve one long saved-prompt list
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one active test session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render one active agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    // skip push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // grant one log ticket
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return the long draft list
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: saved } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Saved prompts (30)' }).click();
  const panel = page.locator('.saved-prompts-panel');
  const list = panel.locator('.saved-prompts-list');
  await expect(panel).toBeVisible();
  // measure one rendered scrolling region
  const metrics = await list.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    panelBottom: element.parentElement?.getBoundingClientRect().bottom ?? 0,
    viewportHeight: innerHeight
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.panelBottom).toBeLessThanOrEqual(metrics.viewportHeight);
  // scroll through the rendered draft list
  await list.hover();
  await page.mouse.wheel(0, 1_200);
  // confirm the browser moved the list
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});

test('queues a saved draft from its purple send button through the saved-prompt endpoint', async ({ page }) => {
  const savedDraft = { id: 'saved-prompt-001', text: 'Queue this saved draft' };
  let saved = [savedDraft];
  const calls: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: saved } });
    if (url.pathname === `/api/agents/agent-1/saved-prompts/${savedDraft.id}/queue` && request.method() === 'POST') {
      calls.push(`queue:${savedDraft.id}`);
      saved = [];
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Keep this composer text');
  await page.getByRole('button', { name: 'Saved prompts (1)' }).click();
  const panel = page.locator('.saved-prompts-panel');
  const restore = panel.getByRole('button', { name: savedDraft.text, exact: true });
  const send = panel.getByRole('button', { name: `Queue saved draft: ${savedDraft.text}` });
  await expect(send.locator('svg')).toHaveCount(1);
  await expect(send).toHaveCSS('color', 'rgb(203, 166, 247)');
  const [restoreBounds, sendBounds] = await Promise.all([restore.boundingBox(), send.boundingBox()]);
  expect(restoreBounds).not.toBeNull();
  expect(sendBounds).not.toBeNull();
  expect(sendBounds!.x).toBeGreaterThanOrEqual(restoreBounds!.x + restoreBounds!.width - 1);

  await send.click();

  await expect.poll(() => calls).toEqual([`queue:${savedDraft.id}`]);
  await expect(prompt).toHaveValue('Keep this composer text');
  await expect(page.getByRole('button', { name: 'Saved prompts (1)' })).toHaveCount(0);
  expect(saved).toEqual([]);
});

test('deletes a saved draft from its red trash button without changing the composer', async ({ page }) => {
  const savedDraft = { id: 'saved-prompt-001', text: 'Delete this saved draft' };
  let saved = [savedDraft];
  const calls: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: saved } });
    if (url.pathname === `/api/agents/agent-1/saved-prompts/${savedDraft.id}` && request.method() === 'DELETE') {
      calls.push(`delete:${savedDraft.id}`);
      saved = [];
      return route.fulfill({ json: savedDraft });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Keep this composer text');
  await page.getByRole('button', { name: 'Saved prompts (1)' }).click();
  const panel = page.locator('.saved-prompts-panel');
  const restore = panel.getByRole('button', { name: savedDraft.text, exact: true });
  const send = panel.getByRole('button', { name: `Queue saved draft: ${savedDraft.text}` });
  const remove = panel.getByRole('button', { name: `Delete saved draft: ${savedDraft.text}` });
  await expect(remove.locator('svg')).toHaveCount(1);
  await expect(remove).toHaveCSS('color', 'rgb(243, 139, 168)');
  const [restoreBounds, sendBounds, deleteBounds] = await Promise.all([restore.boundingBox(), send.boundingBox(), remove.boundingBox()]);
  expect(restoreBounds).not.toBeNull();
  expect(sendBounds).not.toBeNull();
  expect(deleteBounds).not.toBeNull();
  expect(sendBounds!.x).toBeGreaterThanOrEqual(restoreBounds!.x + restoreBounds!.width - 1);
  expect(deleteBounds!.x).toBeGreaterThanOrEqual(sendBounds!.x + sendBounds!.width - 1);

  await remove.click();

  await expect.poll(() => calls).toEqual([`delete:${savedDraft.id}`]);
  await expect(prompt).toHaveValue('Keep this composer text');
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: 'Saved prompts (1)' })).toHaveCount(0);
  expect(saved).toEqual([]);
});

test('saves attachment bytes, shows their names, and restores them into the composer', async ({ page }) => {
  const attachmentData = Buffer.from('saved context').toString('base64');
  let saved: Array<{ id: string; text: string; attachments: Array<{ name: string; size: number }> }> = [];
  let savedRequest: unknown;
  let queuedRequest: unknown;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: saved } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'POST') {
      savedRequest = request.postDataJSON();
      const created = { id: 'saved-prompt-attachment-001', text: 'Keep this context', attachments: [{ name: 'context.txt', size: 13 }] };
      saved = [created];
      return route.fulfill({ status: 201, json: created });
    }
    if (url.pathname === '/api/agents/agent-1/saved-prompts/saved-prompt-attachment-001' && request.method() === 'DELETE') {
      saved = [];
      return route.fulfill({ json: { id: 'saved-prompt-attachment-001', text: 'Keep this context', attachments: [{ name: 'context.txt', data: attachmentData }] } });
    }
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queuedRequest = request.postDataJSON();
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Keep this context');
  const defaultAllowed = await prompt.evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File(['saved context'], 'context.txt', { type: 'text/plain' }));
    return element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  expect(defaultAllowed).toBe(true);
  const fileChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await (await fileChooser).setFiles({ name: 'context.txt', mimeType: 'text/plain', buffer: Buffer.from('saved context') });
  await expect(page.getByLabel('Selected attachments')).toContainText('context.txt');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => savedRequest).toEqual({ prompt: 'Keep this context', attachments: [{ name: 'context.txt', data: attachmentData }] });
  await expect(prompt).toHaveValue('');
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);

  await page.getByRole('button', { name: 'Saved prompts (1)' }).click();
  await expect(page.locator('.saved-prompt-copy small')).toHaveText('context.txt');
  await page.locator('.saved-prompt-restore').click();
  await expect(prompt).toHaveValue('Keep this context');
  await expect(page.getByLabel('Selected attachments')).toContainText('context.txt');

  await page.getByRole('button', { name: 'Queue' }).click();
  await expect.poll(() => queuedRequest).toEqual({ prompt: 'Keep this context', attachments: [{ name: 'context.txt', data: attachmentData }] });
});
