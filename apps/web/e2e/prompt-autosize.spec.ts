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

test('caps the prompt at half the viewport and scrolls overflowing content', async ({ page }) => {
  await page.setViewportSize({ width: 1_000, height: 600 });
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
  await prompt.fill(Array.from({ length: 100 }, (_, index) => `Prompt line ${index + 1}`).join('\n'));

  const dimensions = await prompt.evaluate(input => ({
    height: input.getBoundingClientRect().height,
    scrollHeight: input.scrollHeight,
    overflowY: getComputedStyle(input).overflowY
  }));
  expect(dimensions.height).toBeLessThanOrEqual(300);
  expect(dimensions.height).toBeGreaterThan(299);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height);
  expect(dimensions.overflowY).toBe('auto');
});

// preserve prompt ligature shaping
test('uses the upstream ligature font in the prompt composer', async ({ page }) => {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    // serve one controlled browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve one idle agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    // disable optional browser services
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toHaveCSS('font-family', /JetBrains Mono Prompt/u);
  await expect(prompt).toHaveCSS('font-variant-ligatures', 'contextual');
  await expect(prompt).toHaveCSS('font-feature-settings', '"calt"');
  await expect(prompt).toHaveCSS('text-rendering', 'optimizelegibility');
  const loadedFaces = await prompt.evaluate(async () => (await document.fonts.load('400 16px "JetBrains Mono Prompt"', '.. ... -> -> ')).length);
  expect(loadedFaces).toBe(1);
  const promptBounds = await prompt.boundingBox();
  expect(promptBounds).not.toBeNull();
  // require one visible prompt region
  if (promptBounds === null) throw new Error('prompt bounds unavailable');
  // compare shaping without unrelated border antialiasing
  const promptTextScreenshot = () => page.screenshot({ clip: { x: promptBounds.x + 4, y: promptBounds.y + 4, width: 160, height: 36 } });

  await prompt.pressSequentially('...');
  await prompt.evaluate(input => input.blur());
  const typedDots = await promptTextScreenshot();
  await prompt.fill('...');
  await prompt.evaluate(input => input.blur());
  const settledDots = await promptTextScreenshot();
  expect(typedDots.equals(settledDots)).toBe(true);

  await prompt.fill('');
  await prompt.pressSequentially('-> ');
  await prompt.evaluate(input => input.blur());
  const typedArrow = await promptTextScreenshot();
  await prompt.fill('-> ');
  await prompt.evaluate(input => input.blur());
  const settledArrow = await promptTextScreenshot();
  expect(typedArrow.equals(settledArrow)).toBe(true);
  await prompt.evaluate(input => { input.style.fontFeatureSettings = '"calt" 0'; });
  const unligatedArrow = await promptTextScreenshot();
  // prove the contextual arrow glyph is visible
  expect(settledArrow.equals(unligatedArrow)).toBe(false);
  await expect(prompt).toHaveValue('-> ');
});
