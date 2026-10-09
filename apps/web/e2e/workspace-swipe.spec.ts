import { expect, test, type Locator, type Page } from '@playwright/test';

// use real touch delivery on a phone-sized workspace selector
test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

// expose three ordered worktrees without external sessions or network dependencies
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    // authenticate the local fixture
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'swipe-csrf', active: true, deviceName: 'Test device' } });
    // keep the dropdown order explicit and stable
    if (path === '/api/dashboard') return route.fulfill({ json: {
      generation: 1, agents: [],
      projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: ['Cora', 'Owen', 'Dave'].map((label, order) => ({
        id: label.toLowerCase(), projectId: 'repo', label, path: `/worktrees/${label.toLowerCase()}`, branch: label.toLowerCase(),
        main: false, detached: false, locked: false, available: true, pinned: true, order
      })) }]
    } });
    // provide empty worktree collections
    if (path.endsWith('/notes')) return route.fulfill({ json: { notes: [] } });
    if (path.endsWith('/panes')) return route.fulfill({ json: { panes: [] } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(/^Cora —/u);
});

// swipe the actual control through the browser's native touch pipeline
const swipe = async (page: Page, control: Locator, dx: number, dy = 0, cancel = false) => {
  const bounds = await control.boundingBox();
  // require visible geometry before dispatching input
  if (bounds === null) throw new Error('workspace dropdown is not visible');
  const x = Math.round(bounds.x + bounds.width / 2);
  const y = Math.round(bounds.y + bounds.height / 2);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    // deliver a deliberate drag rather than jumping straight to the endpoint
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + Math.round(dx * step / 8), y: y + Math.round(dy * step / 8) }] });
      await page.evaluate(() => new Promise<number>(resolve => requestAnimationFrame(resolve)));
    }
    // finish at rest so the next tap is not consumed to stop a synthetic fling
    for (let frame = 0; frame < 3; frame++) {
      await page.evaluate(() => new Promise<number>(resolve => requestAnimationFrame(resolve)));
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y: y + dy }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
};

// open the chooser with an upward gesture without changing the active workspace
test('swipes up to open workspaces without switching and selects normally', async ({ page }) => {
  const dropdown = page.getByRole('tab', { selected: true });
  const sheet = page.getByRole('dialog', { name: 'Workspaces' });
  await swipe(page, dropdown, 0, -90);
  await expect(dropdown).toHaveAccessibleName(/^Cora —/u);
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName(/^Cora —/u);
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await swipe(page, dropdown, -20, -70);
  await expect(dropdown).toHaveAccessibleName(/^Cora —/u);
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName(/^Cora —/u);
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: /^Dave\s/u }).tap();
  await expect(dropdown).toHaveAccessibleName(/^Dave —/u);
  await expect(sheet).toHaveCount(0);
});

// navigate by one menu entry per gesture without wrapping or opening the chooser
test('swipes one worktree in either direction and stops at both ends', async ({ page }) => {
  test.setTimeout(60_000);
  const dropdown = page.getByRole('tab', { selected: true });
  const sheet = page.getByRole('dialog', { name: 'Workspaces' });
  // include boundary swipes and repeated direction changes
  for (const [distance, label] of [[90, 'Cora'], [-90, 'Owen'], [-90, 'Dave'], [-90, 'Dave'], [90, 'Owen'], [90, 'Cora']] as const) {
    await swipe(page, dropdown, distance);
    await expect(dropdown).toHaveAccessibleName(new RegExp(`^${label} —`, 'u'));
    await expect(page.getByRole('tabpanel')).toHaveAccessibleName(new RegExp(`^${label} —`, 'u'));
    await expect(sheet).toHaveCount(0);
  }
  // a fresh tap still opens the chooser and normal selection still works
  await dropdown.tap();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: /^Dave\s/u }).tap();
  await expect(dropdown).toHaveAccessibleName(/^Dave —/u);
  await expect(sheet).toHaveCount(0);
});

// ignore incomplete and non-dominant gestures without disabling taps or keyboard activation
test('ignores downward, short, diagonal and canceled gestures', async ({ page }) => {
  const dropdown = page.getByRole('tab', { selected: true });
  const sheet = page.getByRole('dialog', { name: 'Workspaces' });
  await swipe(page, dropdown, 0, 90);
  await expect(dropdown).toHaveAccessibleName(/^Cora —/u);
  await expect(sheet).toHaveCount(0);
  await swipe(page, dropdown, 0, -20);
  await expect(dropdown).toHaveAccessibleName(/^Cora —/u);
  await expect(sheet).toHaveCount(0);
  await swipe(page, dropdown, -15);
  await expect(dropdown).toHaveAccessibleName(/^Cora —/u);
  // a short horizontal gesture may still count as a tap
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await swipe(page, dropdown, -70, -70);
  await expect(dropdown).toHaveAccessibleName(/^Cora —/u);
  await expect(sheet).toHaveCount(0);
  await swipe(page, dropdown, -90, 0, true);
  await expect(dropdown).toHaveAccessibleName(/^Cora —/u);
  await expect(sheet).toHaveCount(0);
  await swipe(page, dropdown, 0, -90, true);
  await expect(dropdown).toHaveAccessibleName(/^Cora —/u);
  await expect(sheet).toHaveCount(0);
  await dropdown.tap();
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await dropdown.press('Enter');
  await expect(sheet).toBeVisible();
});
