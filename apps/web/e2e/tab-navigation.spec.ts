import { expect, test } from '@playwright/test';

test('Shift+Arrow cycles agent tabs in both directions with wraparound', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="root"></div>');
  await page.evaluate(async () => {
    const { renderTabNavigation } = await import('/e2e/tab-navigation-fixture.tsx');
    renderTabNavigation(document.querySelector<HTMLElement>('#root')!);
  });

  await page.getByRole('tab', { name: 'Alpha' }).focus();

  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByRole('tab', { name: 'Bravo' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByRole('tab', { name: 'Charlie' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Charlie' })).toHaveAttribute('aria-selected', 'true');

});

test('Shift+Arrow edits the selection instead of changing tabs when the prompt is focused', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="root"></div>');
  await page.evaluate(async () => {
    const { renderTabNavigation } = await import('/e2e/tab-navigation-fixture.tsx');
    renderTabNavigation(document.querySelector<HTMLElement>('#root')!);
  });

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.focus();
  await prompt.evaluate(input => (input as HTMLInputElement).setSelectionRange(4, 4));
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveJSProperty('selectionStart', 4);
  await expect(prompt).toHaveJSProperty('selectionEnd', 5);
});

test('modified Shift+Arrow shortcuts do not change tabs', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="root"></div>');
  await page.evaluate(async () => {
    const { renderTabNavigation } = await import('/e2e/tab-navigation-fixture.tsx');
    renderTabNavigation(document.querySelector<HTMLElement>('#root')!);
  });

  await page.getByRole('textbox', { name: 'Prompt' }).focus();
  await page.keyboard.press('Control+Shift+ArrowRight');
  await expect(page.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
});
