import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock';
import type { ComparisonFile, ComparisonPatch } from '../src/code-panel/comparison';

// a minimal valid unified diff for one modified file, enough for the panel's parser
const modifiedPatch = (path: string) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n`;
const trackedFile = (path: string): ComparisonFile => ({ change: { code: ' M', path, additions: 1, deletions: 1 }, kind: 'tracked', patch: modifiedPatch(path), capped: false });
const patchOf = (files: ComparisonFile[]): ComparisonPatch => ({ kind: 'working', base: 'HEAD', gitBase: 'HEAD', files, fingerprint: files.map(file => file.change.path).join('|'), truncated: false });

const codePanel = (page: Page) => page.getByRole('region', { name: 'Code changes' });
const agentOutput = (page: Page) => page.locator('.log-output');

// a phone with the agent's Workspace open and its Code panel opened from the git popup
const mount = async (page: Page) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', worktreeId: 'cora', sessionId: 'socket:$1', home: '/worktrees/cora', branch: 'feature/mobile', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] }, title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    if (url.pathname === '/api/worktrees/cora/comparison') return route.fulfill({ json: patchOf([trackedFile('src/app.ts')]) });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1');
  await pushBytes(page, 'agent-1', 'Ready\n');
  await page.getByRole('button', { name: /^Git status:/u }).click();
  await page.getByRole('button', { name: 'View changes', exact: true }).click();
};

// On a phone the Code panel must join the panel carousel (like note / browser / terminal) rather
// than stacking on top of the agent output — even when it is the only extra panel open.
test('shows the Code panel as a switchable mobile panel, not stacked on the agent', async ({ page }) => {
  await mount(page);

  // opening the Code panel adds it to the phone carousel and scrolls to it, the newly opened panel
  // (the regression: without the Code panel counting as a panel, it stacked on the agent output).
  // It fills the screen, and the dots offer the way back to the agent.
  const split = page.locator('.log-split');
  await expect(split).toHaveClass(/\bmobile-code-view\b/u);
  await expect(codePanel(page)).toBeInViewport({ ratio: 0.99 });
  await expect(agentOutput(page)).not.toBeInViewport();

  // the agent's dot returns to the agent output, moving the Code panel off screen
  const showAgent = page.getByRole('group', { name: 'Panels' }).getByRole('button', { name: 'Show agent output' });
  await expect(showAgent).toBeVisible();
  await showAgent.click();
  await expect(split).toHaveClass(/\bmobile-agent-view\b/u);
  await expect(agentOutput(page)).toBeInViewport({ ratio: 0.99 });
  await expect(codePanel(page)).not.toBeInViewport();
});

// the view options drop from the header's top-right as a card sized to its options, as on desktop
test('opens the view options as a card beneath the header, not a full-height drawer', async ({ page }) => {
  await mount(page);
  await expect(codePanel(page)).toBeInViewport({ ratio: 0.99 });
  await codePanel(page).getByRole('button', { name: 'More code panel actions' }).click();
  await page.getByRole('group', { name: 'More code panel actions' }).getByRole('button', { name: 'View options' }).click();
  const flyout = codePanel(page).getByRole('dialog', { name: 'View options' });
  await expect(flyout).toBeVisible();
  const [flyoutBox, panelBox] = await Promise.all([flyout.boundingBox(), codePanel(page).boundingBox()]);
  expect(flyoutBox!.height).toBeLessThan(panelBox!.height / 2);
  expect(flyoutBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
  expect(flyoutBox!.x + flyoutBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
});
