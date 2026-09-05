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
  const browser = root.getByRole('button', { name: 'Open project in split view' });
  const toggle = root.getByRole('button', { name: 'Stack controls' });
  await expect(root.locator('.project-open + .project-browser-toggle + .project-stack-toggle')).toHaveCount(1);
  const [openBounds, browserBounds, toggleBounds] = await Promise.all([open.boundingBox(), browser.boundingBox(), toggle.boundingBox()]);
  expect(openBounds).not.toBeNull();
  expect(browserBounds).not.toBeNull();
  expect(toggleBounds).not.toBeNull();
  expect(Math.abs(openBounds!.x + openBounds!.width - browserBounds!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(browserBounds!.x + browserBounds!.width - toggleBounds!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(openBounds!.y - toggleBounds!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(openBounds!.height - toggleBounds!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(browserBounds!.width - browserBounds!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(toggleBounds!.width - toggleBounds!.height)).toBeLessThanOrEqual(1);

  await browser.click();
  await expect(root).toHaveAttribute('data-browser', 'open');

  await toggle.click();
  await expect(page.getByRole('button', { name: 'Start stack', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build stack', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Build stack', exact: true }).click();
  await expect(root).toHaveAttribute('data-action', 'build');
  await expect(root.getByRole('link', { name: 'Building…' })).toHaveAttribute('aria-busy', 'true');
});

test('hides the browser split control while the stack is stopped', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="prompt-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStoppedProjectOpenControls } = await import('/e2e/project-open-fixture.tsx');
    renderStoppedProjectOpenControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const root = page.locator('#control-root');
  await expect(root.getByRole('link', { name: 'Open' })).toBeVisible();
  await expect(root.getByRole('button', { name: 'Open project in split view' })).toHaveCount(0);
  await expect(root.getByRole('button', { name: 'Stack controls' })).toBeVisible();
  await expect(root.locator('.project-open-group')).not.toHaveClass(/has-browser-control/u);
});

test('keeps direct project controls visible independently of managed stack state', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="prompt-actions"><div id="direct-root"></div><div id="unavailable-root"></div></div>');
  await page.evaluate(async () => {
    const { renderDirectProjectOpenControls, renderUnavailableDirectProjectOpenControls } = await import('/e2e/project-open-fixture.tsx');
    renderDirectProjectOpenControls(document.querySelector<HTMLElement>('#direct-root')!);
    renderUnavailableDirectProjectOpenControls(document.querySelector<HTMLElement>('#unavailable-root')!);
  });

  const direct = page.locator('#direct-root');
  await expect(direct.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://external-preview.example/map/');
  const directSplit = direct.getByRole('button', { name: 'Open project in split view' });
  await expect(directSplit).toBeEnabled();
  await expect(direct.getByRole('button', { name: 'Stack controls' })).toHaveCount(0);
  await directSplit.click();
  await expect(direct).toHaveAttribute('data-browser', 'open');

  const unavailable = page.locator('#unavailable-root');
  await expect(unavailable.getByRole('link', { name: 'Open' })).toHaveAttribute('aria-disabled', 'true');
  await expect(unavailable.getByRole('button', { name: 'Open project in split view' })).toBeDisabled();
  await expect(unavailable.getByRole('button', { name: 'Stack controls' })).toBeVisible();
});

test('shows stack controls when the worktree has commands but no project URL', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="prompt-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStackOnlyControls } = await import('/e2e/project-open-fixture.tsx');
    renderStackOnlyControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const root = page.locator('#control-root');
  await expect(root.getByRole('link')).toHaveCount(0);
  const toggle = root.getByRole('button', { name: 'Stack controls' });
  await expect(toggle).toBeVisible();
  const cornerRadius = await toggle.evaluate(element => Number.parseFloat(getComputedStyle(element).borderTopLeftRadius));
  expect(cornerRadius).toBeGreaterThan(0);
  await toggle.click();
  await page.getByRole('button', { name: 'Restart stack', exact: true }).click();
  await expect(root).toHaveAttribute('data-action', 'restart');
});

test('shows accessible running, stopped, and unknown states on stack-only controls', async ({ page }) => {
  // render every published running state
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="prompt-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStackOnlyStatuses } = await import('/e2e/project-open-fixture.tsx');
    renderStackOnlyStatuses(document.querySelector<HTMLElement>('#control-root')!);
  });

  const running = page.getByRole('button', { name: 'Stack controls: running' });
  const stopped = page.getByRole('button', { name: 'Stack controls: stopped' });
  const unknown = page.getByRole('button', { name: 'Stack controls: unknown' });
  await expect(running.locator('.status.live > i')).toBeVisible();
  await expect(stopped.locator('.status.disconnected > i')).toBeVisible();
  await expect(unknown.locator('.status.inactive > i')).toBeVisible();
  // compare rendered state colors
  const statusColors = await Promise.all([running, stopped, unknown].map(control => control.locator('.status > i').evaluate(element => getComputedStyle(element).backgroundColor)));
  expect(new Set(statusColors).size).toBe(3);
  await expect(running).toHaveAttribute('title', 'Stack controls · running');
  await expect(stopped).toHaveAttribute('title', 'Stack controls · stopped');
  await expect(unknown).toHaveAttribute('title', 'Stack controls · unknown');
});
