import { expect, test } from '@playwright/test';

test('animates working tabs from left to right with a peach status dot', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeLabel: 'Cora', title: '⠋ Working', attention: 'working' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const workingTab = page.getByRole('tab', { name: 'Cora — Working' });
  await expect(workingTab).toBeVisible();
  const treatment = await workingTab.evaluate(element => {
    const sweep = getComputedStyle(element, '::before');
    const dot = getComputedStyle(element, '::after');
    const label = getComputedStyle(element.querySelector('.tab-label')!);
    return {
      sweepAnimation: sweep.animationName,
      sweepDirection: sweep.animationDirection,
      sweepBackground: sweep.backgroundImage,
      sweepFilter: sweep.filter,
      labelAnimation: label.animationName,
      labelAnimationDirection: label.animationDirection,
      labelAnimationDuration: label.animationDuration,
      labelBackground: label.backgroundImage,
      dotAnimation: dot.animationName,
      dotColor: dot.backgroundColor,
      dotRadius: dot.borderRadius
    };
  });

  expect(treatment.sweepAnimation).toBe('tab-working-sweep');
  expect(treatment.sweepDirection).toBe('normal');
  expect(treatment.sweepBackground).toContain('linear-gradient');
  expect(treatment.sweepFilter).toContain('blur');
  expect(treatment.labelAnimation).toBe('tab-working-text-glow');
  expect(treatment.labelAnimationDirection).toBe('reverse');
  expect(treatment.labelAnimationDuration).toBe('3s');
  expect(treatment.labelBackground).toContain('linear-gradient');
  expect(treatment.dotAnimation).toBe('tab-working-dot');
  expect(treatment.dotColor).toBe('rgb(250, 179, 135)');
  expect(treatment.dotRadius).toBe('50%');
});

test('animates an unread success tab with a green glow and status dot', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeLabel: 'Cora', title: 'Ready' }, { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/delta', worktreeLabel: 'Delta', title: 'Ready', unread: true }], projects: [] } });
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
    return { tabAnimation: tab.animationName, dotAnimation: dot.animationName, dotColor: dot.backgroundColor };
  });
  expect(treatment.tabAnimation).toBe('tab-unread-success');
  expect(treatment.dotAnimation).toBe('tab-unread-dot');
  expect(treatment.dotColor).toBe('rgb(166, 227, 161)');
});
