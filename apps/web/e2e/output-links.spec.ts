import { expect, test } from '@playwright/test';
import { outputLinkSegments } from '../src/output-links';

test('maps wrapped output links to visible terminal-cell overlays', () => {
  expect(outputLinkSegments(
    { start: { x: 78, y: 4 }, end: { x: 10, y: 5 } },
    80,
    24,
    0
  )).toEqual([
    { column: 77, row: 3, columns: 3 },
    { column: 0, row: 4, columns: 10 }
  ]);
});

test('clips output link overlays to the visible viewport', () => {
  expect(outputLinkSegments(
    { start: { x: 70, y: 8 }, end: { x: 12, y: 11 } },
    80,
    2,
    9
  )).toEqual([
    { column: 0, row: 0, columns: 80 },
    { column: 0, row: 1, columns: 12 }
  ]);
});

test('keeps native output links stable, clickable, and available to the context menu', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async () => {
    const { renderOutputLinks } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinks(document.querySelector<HTMLElement>('#output-links')!);
  });
  await expect(page.locator('#output-links')).toHaveAttribute('data-ready', 'true');
  const link = page.locator('.output-link-overlay');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', 'https://example.com/output');
  await expect(link).toHaveCSS('cursor', 'pointer');
  await page.evaluate(() => {
    document.body.dataset.linkMutations = '0';
    new MutationObserver(records => {
      const changes = records.flatMap(record => [...record.addedNodes, ...record.removedNodes]).filter(node => node instanceof Element && (node.matches('.output-link-overlay') || node.querySelector('.output-link-overlay'))).length;
      document.body.dataset.linkMutations = String(Number(document.body.dataset.linkMutations ?? '0') + changes);
    }).observe(document.querySelector('#output-links')!, { childList: true, subtree: true });
  });
  const bounds = await link.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.evaluate(async () => {
    const { startOutputLinkRefresh } = await import('/e2e/output-links-fixture.ts');
    startOutputLinkRefresh();
  });
  await page.waitForTimeout(100);
  const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
  await expect.poll(async () => await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('output-link-overlay') ?? false, point)).toBe(true);
  const popupPromise = page.waitForEvent('popup');
  await page.mouse.click(point.x, point.y);
  const popup = await popupPromise;
  await popup.close();
  await expect(page.locator('body')).toHaveAttribute('data-opened', 'true');
  await page.waitForTimeout(250);
  await expect(page.locator('body')).toHaveAttribute('data-link-mutations', '0');
  await page.evaluate(() => {
    document.addEventListener('contextmenu', event => {
      const link = (event.target as Element).closest('a');
      document.body.dataset.contextLink = link?.getAttribute('href') ?? '';
    }, { once: true });
  });
  let rightClickOpened = false;
  page.once('popup', popup => { rightClickOpened = true; void popup.close(); });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.waitForTimeout(100);
  expect(rightClickOpened).toBe(false);
  await expect(page.locator('body')).toHaveAttribute('data-context-link', 'https://example.com/output');
  await page.evaluate(async () => {
    const { stopOutputLinkRefresh } = await import('/e2e/output-links-fixture.ts');
    stopOutputLinkRefresh();
  });
});
