import { expect, test } from '@playwright/test';
import { outputLinkSegments, outputUrlMatchesHost } from '../src/output-links';

// verify output host matching
test('matches output URLs to the configured stack host', () => {
  expect(outputUrlMatchesHost('https://project.example.com/details?view=files', 'https://project.example.com')).toBe(true);
  expect(outputUrlMatchesHost('https://outside.example.com/details', 'https://project.example.com')).toBe(false);
  expect(outputUrlMatchesHost('not a URL', 'https://project.example.com')).toBe(false);
});

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

test('opens the complete target for links split across captured terminal rows', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async () => {
    const { renderCapturedWrappedOutputLink } = await import('/e2e/output-links-fixture.ts');
    await renderCapturedWrappedOutputLink(document.querySelector<HTMLElement>('#output-links')!);
  });
  const container = page.locator('#output-links');
  await expect(container).toHaveAttribute('data-ready', 'true');
  const uri = await container.getAttribute('data-uri');
  expect(uri).not.toBeNull();
  const links = page.locator('.output-link-overlay');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', uri!);
  await expect(links.last()).toHaveAttribute('href', uri!);
  const popupPromise = page.waitForEvent('popup');
  await links.last().click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(uri!);
  await popup.close();
});

// retain URL punctuation that becomes interior after joining captured rows
for (const separator of ['?', ':', ',', '.']) {
  // verify every separator against terminal output rather than a string-only helper
  test(`joins captured URL rows ending in ${separator}`, async ({ page }) => {
    const uri = `https://example.com/path${separator}item=12345&view=all`;
    await page.goto('/');
    await page.setContent('<div id="output-links"></div>');
    await page.evaluate(async uri => {
      const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
      await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `Visit ${uri.slice(0, 25)}\r\n${uri.slice(25)} for details.`, 31);
    }, uri);
    const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
    await expect(links).toHaveCount(2);
    await expect(links.first()).toHaveAttribute('href', uri);
    await expect(links.last()).toHaveAttribute('href', uri);
  });
}

// do not turn sentence punctuation and a real newline into a fabricated URL
for (const separator of ['?', ':', ',', '.']) {
  // keep a hard-break counterexample for each newly accepted punctuation boundary
  test(`does not append prose after a captured URL ending in ${separator}`, async ({ page }) => {
    const uri = 'https://example.com/path';
    await page.goto('/');
    await page.setContent('<div id="output-links"></div>');
    await page.evaluate(async ({ uri, separator }) => {
      const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
      await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `Visit ${uri}${separator}\r\nNext line`, 31);
    }, { uri, separator });
    const links = page.getByRole('link');
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute('href', uri);
  });
}

// retain numeric URL continuations such as an explicit port
test('joins a captured URL split before a numeric port', async ({ page }) => {
  const uri = 'https://example.com:8443';
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async uri => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `${' '.repeat(11)}${uri.slice(0, 20)}\r\n${uri.slice(20)}`, 31);
  }, uri);
  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', uri);
  await expect(links.last()).toHaveAttribute('href', uri);
});

// carry a complete destination through every captured continuation row
test('joins three captured URL rows into one destination', async ({ page }) => {
  const uri = 'https://example.com/path?item=12345&filter=complete&sort=updated&view=details';
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async uri => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `Visit ${uri.slice(0, 25)}\r\n${uri.slice(25, 56)}\r\n${uri.slice(56)} for details.`, 31);
  }, uri);
  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(3);
  // every visible row must open the same full destination
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
  const popupPromise = page.waitForEvent('popup');
  await links.last().click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(uri);
  await popup.close();
});

// reconstruct a scheme that was captured before both slashes were printed
test('joins captured rows split inside the URL scheme', async ({ page }) => {
  const uri = 'https://example.com/path?item=12';
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async uri => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `${' '.repeat(24)}${uri.slice(0, 6)}\r\n${uri.slice(6)}`);
  }, uri);
  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', uri);
  await expect(links.last()).toHaveAttribute('href', uri);
});

// retain native soft-wrap behavior alongside captured-row reconstruction
test('keeps the full destination across native xterm soft wraps', async ({ page }) => {
  const uri = 'https://example.com/path?item=12345&filter=complete&sort=updated&view=details';
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async uri => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `Visit ${uri} for details.`, 31);
  }, uri);
  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(3);
  // every soft-wrapped segment must retain the entire query string
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
});

// preserve real whitespace at a soft-wrap boundary instead of extending the URL
test('does not append the next wrapped word after a URL delimiter', async ({ page }) => {
  const uri = 'https://example.com/path';
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async uri => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `Visit ${uri} next word`, 31);
  }, uri);
  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAttribute('href', uri);
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
