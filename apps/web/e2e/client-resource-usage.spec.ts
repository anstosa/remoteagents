import { expect, test } from '@playwright/test';
import { BoundedTextCache, nextLiveSnapshot, retainedTextTail } from '../src/client-cache';
import { createAnimationFrameTextBatcher } from '../src/client-scheduling';

test('bounds cached text by entry count and retained tail length', () => {
  const cache = new BoundedTextCache(2, 8);

  cache.set('one', '1234567890');
  cache.append('one', 'abc');
  cache.set('two', 'two');
  cache.set('three', 'three');

  expect(cache.get('one')).toBeUndefined();
  expect(cache.get('two')).toBe('two');
  expect(cache.get('three')).toBe('three');
  expect(cache.size).toBe(2);

  cache.append('three', '12345678');
  expect(cache.get('three')).toBe('12345678');
  cache.retain(new Set(['three']));
  expect(cache.get('two')).toBeUndefined();
  expect(cache.size).toBe(1);
});

test('does not split Unicode pairs or retain a partial terminal control line', () => {
  expect(retainedTextTail('12345😀67890', 6)).toBe('67890');
  const retained = retainedTextTail(`old\n\x1b[31mred text\nplain tail`, 18);
  expect(retained.startsWith('\x1b[0m')).toBe(true);
  expect(retained).toContain('plain tail');
  expect(retained).not.toContain('[31m');
});

test('retains complete reset viewports while bounding accumulated append output', () => {
  const largestPlainViewport = 'x'.repeat(500 * 300 + 299);
  expect(nextLiveSnapshot('old output', 'reset', largestPlainViewport)).toHaveLength(largestPlainViewport.length);
  expect(nextLiveSnapshot('x'.repeat(1_000_000), 'append', 'tail')).toHaveLength(1_000_000);
});

test('coalesces terminal append text once per animation frame and clears stale batches', () => {
  const frames: FrameRequestCallback[] = [];
  const cancelled: number[] = [];
  const writes: string[] = [];
  const batcher = createAnimationFrameTextBatcher(
    value => writes.push(value),
    callback => { frames.push(callback); return frames.length; },
    frame => { cancelled.push(frame); }
  );

  batcher.push('alpha ');
  batcher.push('\x1b[31mred');
  batcher.push(' text\x1b[0m');
  expect(frames).toHaveLength(1);
  frames.shift()!(0);
  expect(writes).toEqual(['alpha \x1b[31mred text\x1b[0m']);

  batcher.push('stale');
  batcher.clear();
  expect(cancelled).toEqual([1]);
  frames.shift()!(0);
  expect(writes).toHaveLength(1);
});

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
