import { expect, test } from '@playwright/test';
import { stackActionLabel, stackOperationLabel } from '../src/stack-operations';

test('uses action-specific stack operation labels', () => {
  expect(stackActionLabel('build')).toBe('Build stack');
  expect(stackOperationLabel('start')).toBe('Starting');
  expect(stackOperationLabel('stop')).toBe('Stopping');
  expect(stackOperationLabel('build')).toBe('Building');
  expect(stackOperationLabel('restart')).toBe('Restarting');
  expect(stackOperationLabel('migrate')).toBe('Migrating');
});

test('renders the project link as a labelled busy control during an operation', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div id="busy-root"></div>');
  await page.evaluate(async () => {
    const { renderProjectOpen } = await import('/e2e/project-open-fixture.tsx');
    renderProjectOpen(document.querySelector<HTMLElement>('#busy-root')!);
  });
  const link = page.getByRole('link', { name: 'Building…' });
  await expect(link).toHaveAttribute('aria-busy', 'true');
  await expect(link).toHaveAttribute('aria-disabled', 'true');
  await expect(link.locator('.spinner')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stack controls' })).toBeDisabled();
});

test('joins stack controls onto Open and runs actions from its dropdown', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="prompt-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderProjectOpenControls } = await import('/e2e/project-open-fixture.tsx');
    renderProjectOpenControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const root = page.locator('#control-root');
  const open = root.getByRole('link', { name: 'Open' });
  const toggle = root.getByRole('button', { name: 'Stack controls' });
  await expect(root.locator('.project-open + .project-stack-toggle')).toHaveCount(1);
  const [openBounds, toggleBounds] = await Promise.all([open.boundingBox(), toggle.boundingBox()]);
  expect(openBounds).not.toBeNull();
  expect(toggleBounds).not.toBeNull();
  expect(Math.abs(openBounds!.x + openBounds!.width - toggleBounds!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(openBounds!.y - toggleBounds!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(openBounds!.height - toggleBounds!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(toggleBounds!.width - toggleBounds!.height)).toBeLessThanOrEqual(1);

  await toggle.click();
  await expect(page.getByRole('button', { name: 'Start stack', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build stack', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Build stack', exact: true }).click();
  await expect(root).toHaveAttribute('data-action', 'build');
  await expect(root.getByRole('link', { name: 'Building…' })).toHaveAttribute('aria-busy', 'true');
});
