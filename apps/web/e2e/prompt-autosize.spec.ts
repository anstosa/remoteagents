import { expect, test } from '@playwright/test';

test('grows the prompt to show all content plus one blank line and shrinks again', async ({ page }) => {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeVisible();
  const initialHeight = await prompt.evaluate(input => input.getBoundingClientRect().height);

  const lines = Array.from({ length: 8 }, (_, index) => `Prompt line ${index + 1}`);
  await prompt.fill(lines.join('\n'));
  await expect.poll(() => prompt.evaluate(input => input.getBoundingClientRect().height)).toBeGreaterThan(initialHeight);
  const dimensions = await prompt.evaluate((input, lineCount) => {
    const style = getComputedStyle(input);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const chrome = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    return { height: input.getBoundingClientRect().height, minimum: lineHeight * (lineCount + 1) + chrome, maximum: lineHeight * (lineCount + 2) + chrome };
  }, lines.length);
  expect(dimensions.height).toBeGreaterThanOrEqual(dimensions.minimum - 1);
  expect(dimensions.height).toBeLessThan(dimensions.maximum + 1);

  await prompt.fill('Short prompt');
  await expect.poll(() => prompt.evaluate(input => input.getBoundingClientRect().height)).toBeLessThan(dimensions.height);
  expect(await prompt.evaluate(input => input.getBoundingClientRect().height)).toBeCloseTo(initialHeight, 0);
});
