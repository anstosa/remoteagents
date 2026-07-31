import { expect, test } from '@playwright/test';

test('places the update chip in the tab bar beside notification controls', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <nav class="tabs" role="tablist" style="width: 800px">
      <button role="tab">Agent</button>
      <button class="notification-control" type="button">Enable alerts</button>
      <button class="update-ready" type="button">Update available <span>Reload</span></button>
      <span class="launcher"><button class="new-agent-tab" type="button">+</button></span>
    </nav>
    <section class="panel" style="width: 800px; height: 500px"></section>
  `);

  const tabs = page.getByRole('tablist');
  const notification = page.getByRole('button', { name: 'Enable alerts' });
  const banner = page.getByRole('button', { name: 'Update available Reload' });
  await expect(tabs.locator(':scope > .update-ready')).toHaveCount(1);
  await expect(page.locator('.panel .update-ready')).toHaveCount(0);
  const [notificationBounds, bannerBounds] = await Promise.all([notification.boundingBox(), banner.boundingBox()]);
  expect(notificationBounds).not.toBeNull();
  expect(bannerBounds).not.toBeNull();
  expect(Math.abs(notificationBounds!.y + notificationBounds!.height / 2 - (bannerBounds!.y + bannerBounds!.height / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(notificationBounds!.height - bannerBounds!.height)).toBeLessThanOrEqual(1);
});
