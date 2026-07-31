import { expect, test } from '@playwright/test';

test('uses a static working-tab indicator without continuous animation', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({
      json: {
        generation: 1,
        agents: [
          { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: '⠋ Working in Cora' },
          { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/delta', title: '⠙ Working in Delta' },
          { id: 'agent-3', sessionId: 'socket:$3', workspace: '/worktrees/echo', title: '⠹ Working in Echo' }
        ],
        worktrees: []
      }
    });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[123]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[123]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.locator('.tab-label')).toHaveCount(3);
  await expect(page.locator('.tab-label-letter')).toHaveCount(0);

  const animations = await page.evaluate(() => Array.from(document.querySelectorAll('.tab-label')).flatMap(element => element.getAnimations()));
  expect(animations).toHaveLength(0);
});
