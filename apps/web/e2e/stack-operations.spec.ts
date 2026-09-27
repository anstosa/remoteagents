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

test('keeps the stack flyout available during an operation', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div id="busy-root"></div>');
  await page.evaluate(async () => {
    const { renderProjectOpen } = await import('/e2e/project-open-fixture.tsx');
    renderProjectOpen(document.querySelector<HTMLElement>('#busy-root')!);
  });
  const toggle = page.getByRole('button', { name: 'Stack controls: working' });
  await expect(toggle).toBeEnabled();
  await expect(toggle.locator('.project-stack-server-icon')).toBeVisible();
  await expect(toggle.locator('.project-stack-status-dot.status-working')).toBeVisible();
  await toggle.click();
  const link = page.getByRole('link', { name: 'Open', exact: true });
  await expect(link).toHaveAttribute('aria-busy', 'true');
  await expect(link).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Building…' })).toBeDisabled();
});

test('consolidates managed project controls into one server flyout', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderProjectOpenControls } = await import('/e2e/project-open-fixture.tsx');
    renderProjectOpenControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const root = page.locator('#control-root');
  const toggle = root.getByRole('button', { name: 'Stack controls: down' });
  await expect(root.locator('.project-open-group > .project-stack-trigger')).toHaveCount(1);
  await expect(root.getByRole('link')).toHaveCount(0);
  await expect(root.getByRole('button')).toHaveCount(1);
  const [toggleBounds, dotBounds] = await Promise.all([toggle.boundingBox(), toggle.locator('.project-stack-status-dot').boundingBox()]);
  expect(toggleBounds).not.toBeNull();
  expect(dotBounds).not.toBeNull();
  // pin the status dot to the button's upper-right corner
  expect(Math.abs(dotBounds!.x + dotBounds!.width - (toggleBounds!.x + toggleBounds!.width - 3.2))).toBeLessThanOrEqual(1);
  expect(Math.abs(dotBounds!.y - (toggleBounds!.y + 3.2))).toBeLessThanOrEqual(1);
  await toggle.click();
  const footer = page.getByRole('group', { name: 'Project view controls' });
  const external = footer.getByRole('link', { name: 'Open', exact: true });
  const browser = footer.getByRole('button', { name: 'Split', exact: true });
  await expect(external).toHaveAttribute('href', 'https://project.example.com');
  await expect(external).toHaveCSS('white-space', 'nowrap');
  await expect(external.locator('svg')).toBeVisible();
  await expect(browser.locator('svg')).toBeVisible();
  await expect(footer).toHaveCSS('border-top-width', '1px');
  await expect(browser).toHaveCSS('border-left-width', '1px');
  const [externalBounds, browserBounds] = await Promise.all([external.boundingBox(), browser.boundingBox()]);
  expect(externalBounds).not.toBeNull();
  expect(browserBounds).not.toBeNull();
  expect(Math.abs(externalBounds!.x + externalBounds!.width - browserBounds!.x)).toBeLessThanOrEqual(1);
  const lastActionBounds = await page.getByRole('button', { name: 'Restart stack', exact: true }).boundingBox();
  const footerBounds = await footer.boundingBox();
  expect(lastActionBounds).not.toBeNull();
  expect(footerBounds).not.toBeNull();
  expect(lastActionBounds!.y + lastActionBounds!.height).toBeLessThan(footerBounds!.y);
  await expect(page.getByRole('button', { name: 'Start stack', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build stack', exact: true })).toBeVisible();
  await browser.click();
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Build stack', exact: true }).click();
  await expect(root.locator('.project-stack-trigger')).toHaveAccessibleName('Stack controls: working');
});

test('keeps project view controls available while the stack is stopped', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStoppedProjectOpenControls } = await import('/e2e/project-open-fixture.tsx');
    renderStoppedProjectOpenControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const root = page.locator('#control-root');
  await expect(root.getByRole('link')).toHaveCount(0);
  const toggle = root.getByRole('button', { name: 'Stack controls: down' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole('link', { name: 'Open', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toBeEnabled();
});

test('keeps direct project controls visible independently of managed stack state', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="direct-root"></div><div id="unavailable-root"></div></div>');
  await page.evaluate(async () => {
    const { renderDirectProjectOpenControls, renderUnavailableDirectProjectOpenControls } = await import('/e2e/project-open-fixture.tsx');
    renderDirectProjectOpenControls(document.querySelector<HTMLElement>('#direct-root')!);
    renderUnavailableDirectProjectOpenControls(document.querySelector<HTMLElement>('#unavailable-root')!);
  });

  const direct = page.locator('#direct-root');
  await expect(direct.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://external-preview.example/map/');
  // the Workspace toolbar's Browser button opens the split, so a direct project shows only its link
  await expect(direct.getByRole('button')).toHaveCount(0);

  const unavailable = page.locator('#unavailable-root');
  const unavailableToggle = unavailable.getByRole('button', { name: 'Stack controls: down' });
  await expect(unavailableToggle).toBeVisible();
  await expect(unavailable.getByRole('link')).toHaveCount(0);
  await unavailableToggle.click();
  const unavailableFooter = page.getByRole('group', { name: 'Project view controls' });
  await expect(unavailableFooter.getByRole('link', { name: 'Open', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
  await expect(unavailableFooter.getByRole('button', { name: 'Split', exact: true })).toBeEnabled();
});

test('shows stack controls when the worktree has commands but no project URL', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
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
  await expect(toggle).toHaveAccessibleName('Stack controls: working');
});

test('shows accessible running, stopped, and unknown states on stack-only controls', async ({ page }) => {
  // render every published running state
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStackOnlyStatuses } = await import('/e2e/project-open-fixture.tsx');
    renderStackOnlyStatuses(document.querySelector<HTMLElement>('#control-root')!);
  });

  const running = page.getByRole('button', { name: 'Stack controls: running' });
  const stopped = page.getByRole('button', { name: 'Stack controls: stopped' });
  const unknown = page.getByRole('button', { name: 'Stack controls: unknown' });
  await expect(running.locator('.project-stack-status-dot.status-running')).toBeVisible();
  await expect(stopped.locator('.project-stack-status-dot.status-stopped')).toBeVisible();
  await expect(unknown.locator('.project-stack-status-dot.status-unknown')).toBeVisible();
  // compare rendered state colors
  const statusColors = await Promise.all([running, stopped, unknown].map(control => control.locator('.project-stack-status-dot').evaluate(element => getComputedStyle(element).backgroundColor)));
  expect(new Set(statusColors).size).toBe(3);
  await expect(running).toHaveAttribute('title', 'Stack controls · running');
  await expect(stopped).toHaveAttribute('title', 'Stack controls · stopped');
  await expect(unknown).toHaveAttribute('title', 'Stack controls · unknown');
});

// a Start that is still waiting on its tunnel can be stopped or restarted, but not started again
test('offers Stop and Restart while the stack is Starting', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStartingProcessControls } = await import('/e2e/project-open-fixture.tsx');
    renderStartingProcessControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const toggle = page.getByRole('button', { name: 'Stack controls: working' });
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Start stack', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Restart stack', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop stack', exact: true }).click();
  // the Stop in flight locks the menu and names itself
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Restart stack', exact: true })).toBeDisabled();
});

// a Stack process stopped on purpose reads stopped, whatever its tunnel last said; a failing
// tunnel still reads down for a running process and for a daemon-style stack
test('shows a stopped Stack process as stopped ahead of its tunnel', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderStoppedProcessStatuses } = await import('/e2e/project-open-fixture.tsx');
    renderStoppedProcessStatuses(document.querySelector<HTMLElement>('#control-root')!);
  });

  await expect(page.locator('.project-stack-status-text')).toHaveText(['stopped', 'stopped', 'down', 'down']);
});

// a crashed Stack process reads apart from a deliberate stop, and its code is in the tooltip
test('shows an exited Stack process with its exit code, ahead of a down tunnel', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderExitedProcessStatuses } = await import('/e2e/project-open-fixture.tsx');
    renderExitedProcessStatuses(document.querySelector<HTMLElement>('#control-root')!);
  });

  const crashed = page.getByRole('button', { name: 'Stack controls: dev exited (127)', exact: true });
  const signalled = page.getByRole('button', { name: 'Stack controls: dev exited', exact: true });
  await expect(crashed).toHaveAttribute('title', 'Stack controls · dev exited (127)');
  await expect(signalled).toHaveAttribute('title', 'Stack controls · dev exited');
  await expect(crashed.locator('.project-stack-status-text')).toHaveText('exited');
  await expect(crashed.locator('.project-stack-status-dot.status-exited')).toBeVisible();
  // Start reruns it from the menu
  await crashed.click();
  await expect(page.getByRole('button', { name: 'Start stack', exact: true })).toBeEnabled();
});

// the process's own output and the last one-shot command's output are separate menu entries
test("shows a Stack process's output in the log dialog, refreshing while it is open", async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderProcessOutputControls } = await import('/e2e/project-open-fixture.tsx');
    renderProcessOutputControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  const toggle = page.getByRole('button', { name: 'Stack controls: running' });
  await toggle.click();
  await page.getByRole('button', { name: 'Show dev output' }).click();
  const dialog = page.getByRole('dialog', { name: 'dev output' });
  await expect(dialog.locator('pre')).toContainText('ready in 120ms');
  await expect(dialog.locator('footer')).toHaveText('Running');
  // it keeps polling while open, following new output from the bottom
  const output = dialog.locator('pre');
  await expect(output).toContainText('request 3');
  await expect.poll(() => output.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
  // until the operator scrolls up to read, where new output leaves them
  await output.evaluate(element => { element.scrollTop = 0; });
  await expect(output).toContainText('request 6');
  expect(await output.evaluate(element => element.scrollTop)).toBe(0);
  await dialog.getByRole('button', { name: 'Close stack output' }).click();
  await expect(dialog).toHaveCount(0);

  await toggle.click();
  await page.getByRole('button', { name: 'Show last command output' }).click();
  const commandDialog = page.getByRole('dialog', { name: 'Stack output' });
  await expect(commandDialog.locator('pre')).toHaveText('built in 3s');
  await expect(commandDialog.locator('header strong')).toHaveText('Build stack output');
});

test("opens a running Stack process's own pane as a Terminal from its output dialog", async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderProcessOutputControls } = await import('/e2e/project-open-fixture.tsx');
    renderProcessOutputControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  await page.getByRole('button', { name: 'Stack controls: running' }).click();
  await page.getByRole('button', { name: 'Show dev output' }).click();
  const dialog = page.getByRole('dialog', { name: 'dev output' });
  await dialog.getByRole('button', { name: 'Open as Terminal' }).click();
  // it asks for the process pane, named for the process, and gets out of the way
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { openedTerminals?: unknown }).openedTerminals)).toEqual([{ paneId: '%17', name: 'dev' }]);
});

test('offers no last command output without one-shot commands, and shows an exited process with its code', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<link rel="stylesheet" href="/src/styles.css"><div class="workspace-toolbar-actions"><div id="control-root"></div></div>');
  await page.evaluate(async () => {
    const { renderExitedProcessOutputControls } = await import('/e2e/project-open-fixture.tsx');
    renderExitedProcessOutputControls(document.querySelector<HTMLElement>('#control-root')!);
  });

  await page.getByRole('button', { name: 'Stack controls: dev exited (127)' }).click();
  await expect(page.getByRole('button', { name: 'Show last command output' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show dev output' }).click();
  const dialog = page.getByRole('dialog', { name: 'dev output' });
  await expect(dialog.locator('pre')).toHaveText('bash: line 1: pnpm: command not found');
  await expect(dialog.locator('footer')).toHaveText('Exited (127)');
  // a dead pane is no live Terminal
  await expect(dialog.getByRole('button', { name: 'Open as Terminal' })).toHaveCount(0);
});
