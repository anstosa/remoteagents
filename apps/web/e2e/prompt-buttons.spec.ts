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

test('uses consistent Workspace toolbar styles, tints an open panel’s button and keeps the composer send gradient', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <section class="prompt agent-composer">
      <div class="agent-composer-column">
        <button class="queue icon-button" aria-label="Queue"><svg viewBox="0 0 24 24"><path d="M22 2 11 13"></path></svg></button>
      </div>
    </section>
    <section class="workspace-toolbar">
      <div class="workspace-toolbar-actions">
        <button class="terminal-picker-toggle toolbar-button" aria-label="Terminal"><svg viewBox="0 0 24 24"></svg><span class="toolbar-label">Terminal</span></button>
        <button class="toolbar-button browser-toggle panel-open" aria-label="Browser" aria-pressed="true"><svg viewBox="0 0 24 24"></svg><span class="toolbar-label">Browser</span></button>
        <button class="more icon-button" aria-label="More"></button>
        <span class="project-open-group">
          <a class="project-open status-healthy" href="#"><i></i>Open</a>
        </span>
        <span class="project-open-group has-stack-actions">
          <button class="project-stack-toggle project-stack-trigger toolbar-button" aria-label="Stack"><svg class="project-stack-server-icon" viewBox="0 0 24 24"></svg><i class="project-stack-status-dot status-healthy"></i></button>
        </span>
      </div>
    </section>
  `);

  const neutral = ['Terminal', 'More', 'Open', 'Stack'].map(name => page.getByRole(name === 'Open' ? 'link' : 'button', { name }));
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

  // an open panel's button takes that panel's colour (the browser's blue)
  await page.mouse.move(0, 0);
  const browser = page.getByRole('button', { name: 'Browser' });
  const browserStyle = await readStyle(browser);
  expect(browserStyle.color).toBe('rgb(137, 180, 250)');
  expect(browserStyle.backgroundColor).not.toBe(neutralStyles[0].backgroundColor);

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

// preserve inline desktop counts while pinning icon-mode badges to button corners
test('places phone toolbar counts and git status over their icon buttons', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <section class="workspace-toolbar-actions">
      <button class="terminal-picker-toggle toolbar-button" aria-label="Terminal"><svg viewBox="0 0 24 24"></svg><span class="toolbar-label">Terminal</span><span class="saved-prompts-count">2</span></button>
      <button class="notes-toggle toolbar-button" aria-label="Notes"><svg viewBox="0 0 24 24"></svg><span class="toolbar-label">Notes</span><span class="saved-prompts-count notes-count">3</span></button>
      <span class="git-status-wrap"><button class="git-status-summary dirty" aria-label="Git status"><svg class="git-branch-icon" viewBox="0 0 24 24"></svg><span class="git-status-dot"></span><span class="git-branch">main</span><span class="git-status-separator">·</span><span class="git-worktree-state">Changed</span></button></span>
    </section>
  `);
  await expect(page.getByRole('button', { name: 'Terminal' }).locator('.saved-prompts-count')).toHaveCSS('position', 'static');
  await expect(page.locator('.git-status-dot')).toBeHidden();

  await page.setViewportSize({ width: 428, height: 880 });
  const buttons = [page.getByRole('button', { name: 'Terminal' }), page.getByRole('button', { name: 'Notes' }), page.getByRole('button', { name: 'Git status' })];
  // check each badge against its own button, not the toolbar row
  for (const button of buttons) {
    const badge = button.locator('.saved-prompts-count, .git-status-dot');
    await expect(badge).toHaveCSS('position', 'absolute');
    const [buttonBox, badgeBox, iconBox] = await Promise.all([button.boundingBox(), badge.boundingBox(), button.locator('svg').boundingBox()]);
    expect(buttonBox).not.toBeNull();
    expect(badgeBox).not.toBeNull();
    expect(iconBox).not.toBeNull();
    expect(badgeBox!.x).toBeGreaterThan(buttonBox!.x + buttonBox!.width / 2);
    expect(badgeBox!.y).toBeLessThan(buttonBox!.y + buttonBox!.height / 4);
    expect(Math.abs(iconBox!.x + iconBox!.width / 2 - (buttonBox!.x + buttonBox!.width / 2))).toBeLessThanOrEqual(1);
  }
});
