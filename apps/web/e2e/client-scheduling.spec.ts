import { expect, test } from '@playwright/test';

// `pollWhileVisible` (client-scheduling.ts) throttles background polling while the tab is
// hidden and resumes on return. Preserved from the retired client-resource-usage spec, whose
// snapshot-cache tests went with the machinery this covers the still-live poll scheduler.
test('reduces hidden client polling and refreshes when visible', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
    Object.defineProperty(window, '__setTestVisibility', {
      configurable: true,
      value: (next: DocumentVisibilityState) => {
        visibility = next;
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
  });

  let dashboardRequests = 0;
  let versionRequests = 0;
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      dashboardRequests += 1;
      return route.fulfill({ json: { generation: dashboardRequests, agents: [], projects: [] } });
    }
    if (url.pathname === '/api/ui-version') {
      versionRequests += 1;
      return route.fulfill({ json: { version: '/src/main.tsx' } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByText('No sessions')).toBeVisible();
  const visibleDashboardRequests = dashboardRequests;
  const visibleVersionRequests = versionRequests;

  await page.evaluate(() => (window as typeof window & { __setTestVisibility: (next: DocumentVisibilityState) => void }).__setTestVisibility('hidden'));
  await page.clock.fastForward(29_000);
  await page.waitForTimeout(0);
  expect(dashboardRequests).toBe(visibleDashboardRequests);
  expect(versionRequests).toBe(visibleVersionRequests);

  await page.clock.fastForward(2_000);
  await expect.poll(() => dashboardRequests).toBe(visibleDashboardRequests + 1);
  expect(versionRequests).toBe(visibleVersionRequests);

  await page.evaluate(() => (window as typeof window & { __setTestVisibility: (next: DocumentVisibilityState) => void }).__setTestVisibility('visible'));
  await expect.poll(() => dashboardRequests).toBeGreaterThan(visibleDashboardRequests);
  await expect.poll(() => versionRequests).toBeGreaterThan(visibleVersionRequests);
});
