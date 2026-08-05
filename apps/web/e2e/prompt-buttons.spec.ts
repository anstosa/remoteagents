import { expect, test, type Locator } from '@playwright/test';

type ControlStyle = {
  backgroundColor: string;
  borderColor: string;
  color: string;
  filter: string;
};

const readStyle = async (locator: Locator): Promise<ControlStyle> => locator.evaluate(element => {
  const style = getComputedStyle(element);
  return {
    backgroundColor: style.backgroundColor,
    borderColor: style.borderTopColor,
    color: style.color,
    filter: style.filter
  };
});

test('uses consistent prompt control styles while preserving destructive and queue emphasis', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <section class="prompt">
      <div class="prompt-actions">
        <button class="swap-agent icon-button" aria-label="Swap"></button>
        <button class="more icon-button" aria-label="More"></button>
        <span class="project-open-group has-stack-actions">
          <a class="project-open status-healthy" href="#"><i></i>Open</a>
          <button class="project-stack-toggle icon-button" aria-label="Stack"></button>
        </span>
        <span class="save-prompt-group">
          <button class="save-prompt outline-button icon-button" aria-label="Save"><svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5V3Z"></path></svg></button>
          <button class="saved-prompts-toggle icon-button" aria-label="Saved"></button>
        </span>
        <button class="danger icon-button" aria-label="Delete"></button>
        <button class="queue icon-button" aria-label="Queue"><svg viewBox="0 0 24 24"><path d="M22 2 11 13"></path></svg></button>
      </div>
    </section>
  `);

  const neutral = ['Swap', 'More', 'Open', 'Stack'].map(name => page.getByRole(name === 'Open' ? 'link' : 'button', { name }));
  await expect.poll(async () => {
    const styles = await Promise.all(neutral.map(readStyle));
    return [
      new Set(styles.map(style => style.backgroundColor)).size,
      new Set(styles.map(style => style.borderColor)).size,
      new Set(styles.map(style => style.color)).size
    ];
  }).toEqual([1, 1, 1]);
  const neutralStyles = await Promise.all(neutral.map(readStyle));
  expect(new Set(neutralStyles.map(style => style.backgroundColor)).size).toBe(1);
  expect(new Set(neutralStyles.map(style => style.borderColor)).size).toBe(1);
  expect(new Set(neutralStyles.map(style => style.color)).size).toBe(1);

  const hoveredStyles: ControlStyle[] = [];
  for (const control of neutral) {
    await control.hover();
    await page.waitForTimeout(175);
    hoveredStyles.push(await readStyle(control));
  }
  expect(new Set(hoveredStyles.map(style => style.backgroundColor)).size).toBe(1);
  expect(new Set(hoveredStyles.map(style => style.borderColor)).size).toBe(1);
  expect(new Set(hoveredStyles.map(style => style.color)).size).toBe(1);
  expect(hoveredStyles[0].backgroundColor).not.toBe(neutralStyles[0].backgroundColor);

  for (const name of ['Save', 'Saved']) {
    const control = page.getByRole('button', { name, exact: true });
    await control.hover();
    await page.waitForTimeout(175);
    expect(await readStyle(control)).toEqual(hoveredStyles[0]);
  }

  const danger = page.getByRole('button', { name: 'Delete' });
  expect((await readStyle(danger)).color).toBe('rgb(243, 139, 168)');
  await danger.hover();
  await page.waitForTimeout(175);
  expect((await readStyle(danger)).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');

  const queue = page.getByRole('button', { name: 'Queue' });
  await expect(queue.locator('svg')).toHaveCount(1);
  const queueBounds = await queue.boundingBox();
  expect(queueBounds).not.toBeNull();
  expect(Math.abs(queueBounds!.width - queueBounds!.height)).toBeLessThanOrEqual(1);
  await expect(queue).toHaveCSS('background-image', /linear-gradient/u);
  await queue.hover();
  await page.waitForTimeout(175);
  await expect(queue).toHaveCSS('filter', 'brightness(1.08)');
});
