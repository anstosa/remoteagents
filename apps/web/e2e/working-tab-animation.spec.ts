import { expect, test } from '@playwright/test';

// keep work motion behind steady status content
test('moves only the working tab background while its label and dot stay steady', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: '⠋ Working', attention: 'working' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const workingTab = page.getByRole('tab', { name: 'Cora — Working' });
  await expect(workingTab).toBeVisible();
  const treatment = await workingTab.evaluate(element => {
    const dot = getComputedStyle(element, '::after');
    const label = getComputedStyle(element.querySelector('.tab-label')!);
    // classify movement by the painted part rather than its keyframe name
    const movingParts = element.getAnimations({ subtree: true }).map(animation => {
      const effect = animation.effect as KeyframeEffect;
      // separate descendant label motion
      if (effect.target !== element) return 'label';
      return effect.pseudoElement === '::before' ? 'background' : 'tab-or-dot';
    });
    return {
      movingParts,
      dotColor: dot.backgroundColor,
      dotWidth: dot.width,
      dotHeight: dot.height,
      labelColor: label.color
    };
  });

  expect(treatment.movingParts).toEqual(['background']);
  expect([treatment.dotWidth, treatment.dotHeight]).toEqual(['6px', '6px']);
  expect(treatment.dotColor).toBe(treatment.labelColor);
});

// limit completed motion to its text while retaining the success outline
test('flashes only completed text while its green tab and dot stay steady', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: 'Ready' }, { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeLabel: 'Delta', title: 'Ready', unread: true }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const successTab = page.getByRole('tab', { name: 'Delta — Prompt done — Unread' });
  await expect(successTab).toBeVisible();
  const treatment = await successTab.evaluate(element => {
    const tab = getComputedStyle(element);
    const dot = getComputedStyle(element, '::after');
    const label = element.querySelector('.tab-label')!;
    // classify movement by its rendered target
    const movingParts = element.getAnimations({ subtree: true }).map(animation => {
      const effect = animation.effect as KeyframeEffect;
      // identify the intended completion flash
      if (effect.target === label) return 'label';
      return effect.pseudoElement === '::after' ? 'dot' : 'tab';
    });
    return { movingParts, borderColor: tab.borderColor, dotColor: dot.backgroundColor, dotWidth: dot.width, dotHeight: dot.height };
  });
  expect(treatment.movingParts).toEqual(['label']);
  expect(treatment.borderColor).toBe(treatment.dotColor);
  expect([treatment.dotWidth, treatment.dotHeight]).toEqual(['6px', '6px']);
});

// preserve status colors while the motion preference stills every treatment
test('the Reduced motion setting preserves working and completed status without movement', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rac.reduced-motion', 'enabled'));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeLabel: 'Cora', title: '⠋ Working', attention: 'working' }, { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/delta', worktreeLabel: 'Delta', title: 'Ready', unread: true }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const workingTab = page.getByRole('tab', { name: 'Cora — Working' });
  const successTab = page.getByRole('tab', { name: 'Delta — Prompt done — Unread' });
  await expect(workingTab).toBeVisible();
  await expect(successTab).toBeVisible();
  expect(await workingTab.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  expect(await successTab.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  const colors = await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => ({ border: getComputedStyle(tab).borderColor, dot: getComputedStyle(tab, '::after').backgroundColor, label: getComputedStyle(tab.querySelector('.tab-label')!).color })));
  expect(colors[0].label).toBe(colors[0].dot);
  expect(colors[1].border).toBe(colors[1].dot);
  expect(colors[1].label).toBe(colors[1].dot);
});
