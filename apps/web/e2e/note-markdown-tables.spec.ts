import { expect, test, type Page } from '@playwright/test';

// mount the real renderer with synthetic note text
const renderNote = async (page: Page, text: string) => {
  // avoid warming the application entrypoint or contacting its api
  await page.goto('/e2e/note-markdown-fixture.html');
  // isolate the preview from live application state
  await page.evaluate(async markdown => {
    const { renderNoteMarkdownLines } = await import('/e2e/note-markdown-lines-fixture.tsx');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    renderNoteMarkdownLines(root, markdown);
  }, text);
  await expect(page.getByLabel('Note preview')).toBeVisible();
};

// preserve inline formatting and column alignment
test('renders pipe tables with aligned columns, escaped pipes, and safe inline markdown', async ({ page }) => {
  await renderNote(page, [
    '| **Feature** \\| surface | State | Count |',
    '| :--- | :---: | ---: |',
    '| [Guide](https://example.com/docs) | *ready* | `a\\|b` |',
    '| <img src=x onerror=alert(1)> | [unsafe](javascript:alert) | ~~old~~ |'
  ].join('\n'));

  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText(['Feature | surface', 'State', 'Count']);
  await expect(table.locator('th strong')).toHaveText('Feature');
  await expect(table.getByRole('cell')).toHaveText(['Guide', 'ready', 'a|b', '<img src=x onerror=alert(1)>', 'unsafe', 'old']);
  await expect(table.getByRole('link', { name: 'Guide' })).toHaveAttribute('href', 'https://example.com/docs');
  await expect(table.locator('em')).toHaveText('ready');
  await expect(table.locator('code')).toHaveText('a|b');
  await expect(table.locator('del')).toHaveText('old');
  await expect(table.locator('img, script, a[href^="javascript:"]')).toHaveCount(0);
  // apply alignment to both headers and body cells
  for (const [index, alignment] of ['left', 'center', 'right'].entries()) {
    await expect(table.getByRole('columnheader').nth(index)).toHaveCSS('text-align', alignment);
    await expect(table.getByRole('cell').nth(index)).toHaveCSS('text-align', alignment);
  }
});

// preserve backslashes before an escaped pipe inside code
test('keeps a pipe escaped even when another backslash precedes it', async ({ page }) => {
  await renderNote(page, '| Value | State |\n| --- | --- |\n| `a\\\\|b` | Ready |');
  const table = page.getByRole('table');
  await expect(table.getByRole('cell')).toHaveText(['a\\|b', 'Ready']);
  await expect(table.locator('code')).toHaveText('a\\|b');
});

// normalize optional borders and uneven body rows
test('accepts borderless tables and fills missing cells while ignoring excess cells', async ({ page }) => {
  await renderNote(page, 'Name | State\n:- | -:\nConsole | Ready\nShort\nExtra | Known | Ignored');
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Name', 'State']);
  await expect(table.getByRole('cell')).toHaveText(['Console', 'Ready', 'Short', '', 'Extra', 'Known']);
});

// detect a table before paragraph accumulation consumes it
test('recognizes a table directly after prose and stops at the next block', async ({ page }) => {
  await renderNote(page, 'Summary:\nName | State\n--- | ---\nConsole | Ready\n## Next\nDone');
  const preview = page.getByLabel('Note preview');
  await expect(preview.locator(':scope > p')).toHaveText(['Summary:', 'Done']);
  await expect(preview.getByRole('table').getByRole('cell')).toHaveText(['Console', 'Ready']);
  await expect(preview.getByRole('heading', { name: 'Next' })).toBeVisible();
});

// allow empty bodies and a single column
test('renders header-only tables, single columns, and inconsistent outer pipes', async ({ page }) => {
  await renderNote(page, 'Header\n| --- |\n\nName | State\n--- | ---\n| Console | Ready\nMore | Done |');
  const tables = page.getByRole('table');
  await expect(tables).toHaveCount(2);
  await expect(tables.first().getByRole('columnheader')).toHaveText(['Header']);
  await expect(tables.first().getByRole('row')).toHaveCount(1);
  await expect(tables.nth(1).getByRole('cell')).toHaveText(['Console', 'Ready', 'More', 'Done']);
});

// prevent short rows from expanding into excessive empty cells
test('keeps an oversized sparse table readable without padding thousands of cells', async ({ page }) => {
  // stay within the saved-note text limit
  const headers = Array.from({ length: 200 }, (_, index) => `Column ${index}`);
  // model rows with many omitted columns
  const rows = Array.from({ length: 100 }, (_, index) => `Row ${index}`);
  // preserve the original source when table expansion is unsafe
  const markdown = [headers.join(' | '), headers.map(() => '---').join(' | '), ...rows].join('\n');
  expect(markdown.length).toBeLessThan(30_000);
  await renderNote(page, markdown);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByLabel('Note preview')).toHaveJSProperty('innerText', markdown);
});

// consume rejected tables without reparsing delimiter-shaped body rows
test('keeps delimiter-shaped rows inside an oversized table fallback', async ({ page }) => {
  // use a valid-size table whose body also resembles table headers
  const markdown = ['h|h', '-|-', ...Array.from({ length: 5_100 }, () => '-|-')].join('\n');
  expect(markdown.length).toBeLessThan(30_000);
  await renderNote(page, markdown);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByLabel('Note preview')).toHaveJSProperty('innerText', markdown);
});

// share the expansion limit across all tables in one note
test('preserves later table source when earlier tables exhaust the note budget', async ({ page }) => {
  // keep each table individually within a reasonable size
  const headers = Array.from({ length: 100 }, (_, index) => `Column ${index}`).join(' | ');
  // provide a valid delimiter for every column
  const delimiter = Array.from({ length: 100 }, () => '---').join(' | ');
  // fill only the first column of each row
  const first = [headers, delimiter, ...Array.from({ length: 60 }, (_, index) => `First row ${index}`)].join('\n');
  // make the combined expansion exceed one note's budget
  const second = [headers, delimiter, ...Array.from({ length: 60 }, (_, index) => `Second row ${index}`)].join('\n');
  await renderNote(page, `${first}\n\n${second}`);
  await expect(page.getByRole('table')).toHaveCount(1);
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(61);
  await expect(page.getByLabel('Note preview').locator('p')).toHaveJSProperty('innerText', second);
});

// keep table-like text literal unless the delimiter matches
for (const [name, markdown] of [
  ['mismatched columns', '| Name | State |\n| --- |\n| Console | Ready |'],
  ['invalid delimiter', '| Name | State |\n| --- | nope |\n| Console | Ready |'],
  ['ordinary pipes', 'Use red | blue\nThen green | yellow'],
  ['escaped separators', 'Name \\| State\n--- \\| ---\nConsole \\| Ready']
]) {
  // avoid false-positive tables
  test(`keeps ${name} as paragraph text`, async ({ page }) => {
    await renderNote(page, markdown);
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByLabel('Note preview').locator('p')).toHaveJSProperty('innerText', markdown);
  });
}

// retain literal examples inside fenced code
test('does not parse pipe tables inside code fences', async ({ page }) => {
  const markdown = '| Name | State |\n| --- | --- |\n| Console | Ready |';
  await renderNote(page, `\`\`\`md\n${markdown}\n\`\`\``);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByLabel('Note preview').locator('pre code')).toHaveText(markdown);
});

// contain wide tables within the note on small screens
test('scrolls tables horizontally on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await renderNote(page, '| Feature | State | Count |\n| --- | --- | --- |\n| Console | Ready | 42 |');
  const scroller = page.locator('.note-table-scroll');
  await expect(scroller).toBeVisible();
  await expect(scroller).toHaveCSS('overflow-x', 'auto');
  // measure the actual overflow boundary
  const widths = await scroller.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, viewport: innerWidth }));
  expect(widths.scroll).toBeGreaterThan(widths.client);
  expect(widths.client).toBeLessThanOrEqual(widths.viewport);
  // confirm off-screen columns are reachable
  await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  // read the scroll position after moving it
  expect(await scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});
