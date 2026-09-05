import { expect, test } from '@playwright/test';

// verify source line breaks
test('preserves a single source line break inside note paragraphs', async ({ page }) => {
  await page.goto('/');
  // mount isolated preview
  await page.evaluate(async () => {
    const { renderNoteMarkdownLines } = await import('/e2e/note-markdown-lines-fixture.tsx');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    renderNoteMarkdownLines(root, 'First **line**\nSecond [line](https://example.com)');
  });

  const paragraph = page.getByLabel('Note preview').locator('p');
  await expect(paragraph).toHaveJSProperty('innerText', 'First line\nSecond line');
  await expect(paragraph.locator('strong')).toHaveText('line');
  await expect(paragraph.getByRole('link', { name: 'line' })).toHaveAttribute('href', 'https://example.com');
});
