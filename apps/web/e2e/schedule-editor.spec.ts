import { expect, test, type Page } from '@playwright/test';

// pin the zone so the server-supplied instants render as fixed local sentences
test.use({ timezoneId: 'America/Los_Angeles' });

type Emitted = { type: string; body?: { cron: string; enabled: boolean; kind: string; target: unknown } };
const emitted = (page: Page) => page.evaluate(() => (window as unknown as { scheduleEmitted: Emitted[] }).scheduleEmitted);

const mount = async (page: Page) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderScheduleEditor } = await import('/e2e/schedule-editor-fixture.tsx');
    const root = document.createElement('div');
    root.style.width = '100%';
    document.body.replaceChildren(root);
    renderScheduleEditor(root);
  });
};

// the full slot walk, asserted identically at both viewports
const walk = async (page: Page) => {
  await mount(page);
  const editor = page.getByRole('group', { name: 'Schedule', exact: true });

  // unscheduled state and hint
  await expect(editor).toContainText('Not scheduled.');
  await expect(editor).toContainText('Starts as every day at 9:00 AM on atlas · main worktree');

  // create → daily 9:00 AM sentence
  await editor.getByRole('button', { name: 'Schedule this note' }).click();
  await expect(editor.getByRole('switch', { name: 'Schedule enabled' })).toHaveText('● Runs');
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every day');
  await expect(editor.getByRole('button', { name: 'Time' })).toHaveText('9:00 AM');
  await expect(editor).toContainText('Claude');
  await expect(editor).toContainText('atlas · main worktree');
  await expect(editor).toContainText('Next Mon 7 Sep 9:00 AM');
  await expect(editor).toContainText('Not run yet');
  await expect(editor.getByRole('button', { name: 'Remove schedule' })).toBeVisible();
  expect(await emitted(page)).toEqual([{ type: 'set', body: { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true } }]);

  // cadence popover: preset, description and the server preview
  await editor.getByRole('button', { name: 'Cadence' }).click();
  const cadence = editor.getByRole('dialog', { name: 'Cadence' });
  await expect(cadence.getByRole('button', { name: 'Daily at' })).toHaveAttribute('aria-pressed', 'true');
  await expect(cadence).toContainText('Every day at 9:00 AM');
  await expect(cadence).toContainText('Next Mon 7 Sep 9:00 AM · Tue 8 Sep 9:00 AM · Wed 9 Sep 9:00 AM');
  await page.keyboard.press('Escape');
  await expect(cadence).toHaveCount(0);

  // change the time → emits the new cron and updates the slot
  await editor.getByRole('button', { name: 'Time' }).click();
  await editor.getByLabel('Set time').fill('08:30');
  await expect(editor.getByRole('button', { name: 'Time' })).toHaveText('8:30 AM');
  expect((await emitted(page)).at(-1)).toEqual({ type: 'set', body: { cron: '30 8 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true } });
  await page.keyboard.press('Escape');

  // pause → the switch and footnote change
  await editor.getByRole('switch', { name: 'Schedule enabled' }).click();
  await expect(editor.getByRole('switch', { name: 'Schedule enabled' })).toHaveText('○ Paused');
  await expect(editor).toContainText('Paused · would next run Mon 7 Sep 9:00 AM');
  expect((await emitted(page)).at(-1)).toEqual({ type: 'set', body: { cron: '30 8 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: false } });

  // remove → back to unscheduled
  await editor.getByRole('button', { name: 'Remove schedule' }).click();
  await expect(editor).toContainText('Not scheduled.');
  expect((await emitted(page)).at(-1)).toEqual({ type: 'remove' });
};

test('walks every Schedule slot at a desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await walk(page);
});

test('walks every Schedule slot at a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page);
});
