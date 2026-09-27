import { expect, test } from '@playwright/test';

// keep status indicators the same size across buttons, tabs and inline labels
test('renders status color dots at one shared diameter', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <button class="server-switcher-button server-switcher-settings"><span class="server-switcher-settings-update-dot"></span></button>
    <button class="server-switcher-button"><span class="server-switcher-attention working"></span></button>
    <nav class="tabs"><button class="status-working">Working</button><button class="unread">Unread</button></nav>
    <span class="agent-switcher-attention"></span>
    <span class="agent-state-pill working">Working</span>
    <section class="workspace-toolbar-actions">
      <button class="notes-toggle unsaved latest-response-available toolbar-button"><svg viewBox="0 0 24 24"></svg></button>
      <span class="git-status-wrap"><button class="git-status-summary dirty"><svg class="git-branch-icon" viewBox="0 0 24 24"></svg><span class="git-status-dot"></span></button></span>
      <button class="project-stack-toggle toolbar-button"><i class="project-stack-status-dot"></i></button>
      <a class="project-open status-healthy" href="#"><i></i>Open</a>
    </section>
    <span class="status live"><i></i>Live</span>
    <span class="panel-dots"><button class="panel-dot terminal-dot"></button></span>
  `);
  await page.setViewportSize({ width: 428, height: 880 });

  const dots = [
    ['.server-switcher-settings-update-dot'],
    ['.server-switcher-attention'],
    ['.tabs .status-working', '::after'],
    ['.tabs .unread', '::after'],
    ['.agent-switcher-attention'],
    ['.agent-state-pill', '::before'],
    ['.notes-toggle.unsaved', '::after'],
    ['.notes-toggle.latest-response-available', '::before'],
    ['.git-status-dot'],
    ['.project-stack-status-dot'],
    ['.project-open > i'],
    ['.status.live > i'],
    ['.panel-dots .panel-dot', '::before']
  ] as const;
  // compare CSS boxes so pseudo-elements and temporarily hidden dots are covered
  for (const [selector, pseudo] of dots) {
    const size = await page.locator(selector).evaluate((element, target) => {
      const style = getComputedStyle(element, target);
      return { width: style.width, height: style.height };
    }, pseudo);
    expect(size, selector).toEqual({ width: '6px', height: '6px' });
  }
  // keep corner status discs free of outlines that enlarge their visible footprint
  await expect(page.locator('.git-status-dot')).toHaveCSS('border-top-width', '0px');
  await expect(page.locator('.project-stack-status-dot')).toHaveCSS('border-top-width', '0px');
  await expect(page.locator('.server-switcher-attention')).toHaveCSS('border-top-width', '0px');
});

// a pending operation should not retain a stale unread highlight
test('uses transition colors over unread colors on workspace controls', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <nav class="tabs"><button class="workspace-dropdown active status-transitioning unread">Starting</button></nav>
    <div class="workspace-sheet"><div class="workspace-sheet-row status-transitioning unread"><button class="workspace-sheet-entry" aria-current="true"><span class="workspace-sheet-copy"><strong>Starting</strong></span></button></div></div>
  `);
  const tab = await page.locator('.workspace-dropdown').evaluate(element => ({
    border: getComputedStyle(element).borderColor,
    color: getComputedStyle(element).color,
    unreadDot: getComputedStyle(element, '::after').content
  }));
  const row = await page.locator('.workspace-sheet-row').evaluate(element => {
    const entry = element.querySelector('.workspace-sheet-entry')!;
    return {
      border: getComputedStyle(element).borderColor,
      dot: getComputedStyle(entry, '::after').backgroundColor,
      label: getComputedStyle(entry.querySelector('strong')!).color,
      animation: getComputedStyle(element).animationName
    };
  });
  expect(tab.border).toBe(tab.color);
  expect(tab.unreadDot).toBe('none');
  expect(row.border).toBe(tab.border);
  expect(row.dot).toBe(tab.border);
  expect(row.label).toBe(tab.border);
  expect(row.animation).toBe('none');
});
