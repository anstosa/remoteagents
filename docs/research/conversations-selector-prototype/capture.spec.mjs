import { test } from '@playwright/test';
const OUT = process.env.OUT; const FILE = process.env.FILE;
const sizes = { phone: { width: 390, height: 844, scale: 2 }, desktop: { width: 1280, height: 800, scale: 1 } };
const open = async (page, variant, scenario = 'idle') => { await page.goto(`file://${FILE}?variant=${variant}&scenario=${scenario}`); await page.locator('#ctl').waitFor(); await page.waitForTimeout(150); };
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
for (const [label, size] of Object.entries(sizes)) {
  test.describe(label, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale });
    test('A', async ({ page }) => {
      await open(page, 'A'); await shot(page, `${label}-A-1-closed`);
      await page.locator('#ctl').click(); await page.locator('.flyout').waitFor(); await shot(page, `${label}-A-2-flyout`);
      await page.locator('.more').click(); await page.locator('.dialog').waitFor(); await page.waitForTimeout(100); await shot(page, `${label}-A-3-dialog`);
      await page.locator('.dialog .search').fill('main'); await page.waitForTimeout(100); await shot(page, `${label}-A-4-dialog-search`);
      await open(page, 'A', 'working'); await page.locator('#ctl').click(); await page.locator('.flyout').waitFor(); await shot(page, `${label}-A-5-flyout-working`);
      await page.locator('.more').click(); await page.locator('.dialog').waitFor(); await page.waitForTimeout(100); await shot(page, `${label}-A-7-dialog-working`);
      await open(page, 'A', 'empty'); await page.locator('#ctl').click(); await page.locator('.flyout').waitFor(); await shot(page, `${label}-A-6-flyout-empty`);
    });
    test('B', async ({ page }) => {
      await open(page, 'B'); await page.locator('#ctl').click(); await page.locator('.sheet').waitFor(); await page.waitForTimeout(250); await shot(page, `${label}-B-1-sheet`);
      await page.locator('.sheet .search').fill('pi'); await page.waitForTimeout(100); await shot(page, `${label}-B-2-sheet-search`);
      await page.locator('.sheet .search').fill(''); await page.waitForTimeout(100); await page.locator('.sheet-title').click(); await page.waitForTimeout(100); await shot(page, `${label}-B-3-sheet-rename`);
    });
    test('C', async ({ page }) => {
      await open(page, 'C'); await shot(page, `${label}-C-1-closed`);
      await page.locator('.title-chip').click(); await page.waitForTimeout(100); await shot(page, `${label}-C-2-chip-edit`);
      await page.keyboard.press('Escape'); await page.locator('#ctl').click(); await page.locator('.flyout').waitFor(); await shot(page, `${label}-C-3-flyout`);
      await page.locator('.more').click(); await page.locator('.dialog').waitFor(); await page.getByRole('tab', { name: 'Claude' }).click(); await page.waitForTimeout(100); await shot(page, `${label}-C-4-dialog-claude-tab`);
    });
  });
}
