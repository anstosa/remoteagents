import { expect, test } from '@playwright/test';

test('saves prompts per agent and consumes a saved prompt back into the composer', async ({ page }) => {
  const longSavedPrompt = 'Review the latest changes and summarize every user-facing risk, deployment concern, compatibility issue, and follow-up action before the release.';
  let saved = [{ id: 'saved-prompt-001', text: longSavedPrompt }];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
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
  const savedRow = page.getByRole('button', { name: longSavedPrompt });
  await expect(savedPanel).toBeVisible();
  await expect(savedPanel).toHaveClass(/more-menu/u);
  await expect(savedPanel.getByText('Select one to move it back into the prompt.')).toHaveCount(0);
  const [panelBounds, rowBounds] = await Promise.all([savedPanel.boundingBox(), savedRow.boundingBox()]);
  expect(panelBounds).not.toBeNull();
  expect(rowBounds).not.toBeNull();
  expect(panelBounds!.width).toBeGreaterThan(24 * 16);
  expect(panelBounds!.width).toBeLessThanOrEqual(1280);
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
    paddingBlock: '10.4px 10.4px'
  });
  await savedRow.hover();
  await expect(savedRow).toHaveCSS('background-color', 'rgb(49, 50, 68)');
  await savedRow.click();

  await expect(prompt).toHaveValue(longSavedPrompt);
  await expect(saveGroup.locator('.saved-prompts-toggle')).toHaveCount(0);
  expect(await save.evaluate(element => {
    const style = getComputedStyle(element);
    return style.borderTopRightRadius === style.borderTopLeftRadius && style.borderBottomRightRadius === style.borderBottomLeftRadius;
  })).toBe(true);

  await prompt.fill('Summarize the release risks.');
  await expect(saveGroup.locator('+ .queue')).toHaveAttribute('aria-label', 'Queue');
  await expect(saveGroup.locator('+ .queue')).toHaveText('');
  await save.click();

  const confirmed = saveGroup.getByRole('button', { name: 'Saved', exact: true });
  await expect(confirmed).toHaveClass(/saved/u);
  await expect(confirmed.locator('svg')).toHaveCount(1);
  await expect(prompt).toHaveValue('');
  const restoredToggle = saveGroup.getByRole('button', { name: 'Saved prompts (1)' });
  await expect(restoredToggle).toBeEnabled();
  await expect(restoredToggle.locator('.saved-prompts-count')).toHaveText('1');
  expect(saved).toEqual([{ id: 'saved-prompt-002', text: 'Summarize the release risks.' }]);
});
