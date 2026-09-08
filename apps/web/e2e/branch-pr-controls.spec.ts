import { expect, test, type Locator, type Page } from '@playwright/test';

type DashboardMount = {
  dashboard: unknown;
  onPrompt?: (body: unknown) => void | Promise<void>;
  onHistoryRequest?: () => void;
};

// fail explicitly when layout geometry is unavailable
async function renderedBox(locator: Locator) {
  const box = await locator.boundingBox();
  // require a rendered element
  if (box === null) throw new Error(`Rendered bounds unavailable for ${await locator.evaluate(element => { /* identify the missing target */ return element.outerHTML; })}`);
  return box;
}

// prove one scrollable control can be brought fully onscreen
async function expectReachableWithin(locator: Locator, container: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const [box, containerBox] = await Promise.all([renderedBox(locator), renderedBox(container)]);
  expect(box.y).toBeGreaterThanOrEqual(containerBox.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(containerBox.y + containerBox.height + 1);
}

// mount one deterministic dashboard scenario
async function mountDashboard(page: Page, options: DashboardMount) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // publish the requested worktrees
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: options.dashboard });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // connect active agent logs
    if (/^\/api\/agents\/[^/]+\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    // serve empty prompt collections
    if (/^\/api\/agents\/[^/]+\/(?:saved-prompts|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // track prompt history refreshes
    if (/^\/api\/agents\/[^/]+\/prompt-history$/u.test(url.pathname)) {
      options.onHistoryRequest?.();
      return route.fulfill({ json: { prompts: [] } });
    }
    // expose repository tabs
    if (/^\/api\/agents\/[^/]+\/switch-prs$/u.test(url.pathname)) return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [], branches: [], pullRequestsSupported: true } });
    // record active-agent prompt submissions
    if (/^\/api\/agents\/[^/]+\/prompt$/u.test(url.pathname) && request.method() === 'POST') {
      await options.onPrompt?.(request.postDataJSON());
      return route.fulfill({ status: 202, json: { ok: true } });
    }
    // serve empty inactive-worktree notes
    if (/^\/api\/worktrees\/[^/]+\/notes$/u.test(url.pathname)) return route.fulfill({ json: { notes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
}

const longTitle = 'Keep the complete current pull request title readable while every action and repository view remains stable '.repeat(12).trim();
const activePullRequest = {
  number: 812,
  title: longTitle,
  status: 'open',
  url: 'https://github.example.com/octo/remoteagents/pull/812',
  checks: 'failed',
  issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true }
};
const activeWorktree = {
  id: 'active', projectId: 'repo', label: 'Active', path: '/worktrees/active', main: true, detached: false, locked: false, available: true, pinned: true, order: 0,
  branch: 'feature/current-pr-controls', gitStatus: { files: 3, staged: 1, unstaged: 2, untracked: 0, conflicted: 0 }, gitPrStatus: { base: 'origin/main', files: 4 }, pullRequest: activePullRequest
};
const activeAgent = {
  id: 'agent-active', sessionId: 'socket:$1', workspace: '/worktrees/active', projectId: 'repo', worktreeId: 'active', title: 'Ready', queuedPromptCount: 0,
  branch: activeWorktree.branch, gitStatus: activeWorktree.gitStatus, gitPrStatus: activeWorktree.gitPrStatus, pullRequest: activePullRequest, push: { label: 'Finish and PR', prompt: '$finish' }
};

// verify the active desktop control and transaction boundary
test('keeps the current pull request in the Working footer and queues one active-agent fixup', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1180, height: 900 });
  let finishPrompt!: () => void;
  let promptRequests = 0;
  let historyRequests = 0;
  // hold the fixup response through duplicate-submit assertions
  const promptFinished = new Promise<void>(resolve => { /* expose the response gate */ finishPrompt = resolve; });
  await mountDashboard(page, {
    dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree] }] },
    // delay one fixup response
    onPrompt: async body => {
      promptRequests += 1;
      expect(body).toEqual({ prompt: '$fixup', attachments: [] });
      await promptFinished;
    },
    // count every history refresh
    onHistoryRequest: () => { /* record one refresh */ historyRequests += 1; }
  });

  const branch = page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u });
  await expect(branch).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.agent-view > .pull-request-card')).toHaveCount(0);
  await expect(branch).toHaveClass(/\bhas-pull-request\b/u);
  await expect(branch).toHaveClass(/\bstatus-open\b/u);
  await expect(branch).toHaveCSS('color', 'rgb(166, 227, 161)');
  const shortcutIndicators = branch.locator(':scope > .pull-request-issues');
  await expect(shortcutIndicators).toHaveCount(1);
  await expect(shortcutIndicators.getByRole('img', { name: 'CI checks failed' })).toBeVisible();
  await expect(shortcutIndicators.getByRole('img', { name: 'Merge conflicts' })).toBeVisible();
  await expect(shortcutIndicators.getByRole('img', { name: 'Unresolved review comments' })).toBeVisible();
  await expect(branch.locator(':scope > .git-status-dot')).toBeVisible();
  const [branchBox, glyphBox, indicatorsBox, dirtyBox, attachmentBox] = await Promise.all([
    renderedBox(branch), renderedBox(branch.locator(':scope > .git-branch-icon')), renderedBox(shortcutIndicators), renderedBox(branch.locator(':scope > .git-status-dot')), renderedBox(page.getByRole('button', { name: 'Attach files' }))
  ]);
  expect(Math.abs(branchBox.width - attachmentBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(branchBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  // preserve the centered full-size glyph beneath the corner overlay
  expect(glyphBox.width).toBeCloseTo(16, 0);
  expect(glyphBox.height).toBeCloseTo(16, 0);
  expect(glyphBox.x + glyphBox.width / 2).toBeCloseTo(branchBox.x + branchBox.width / 2, 0);
  expect(glyphBox.y + glyphBox.height / 2).toBeCloseTo(branchBox.y + branchBox.height / 2, 0);
  expect(branchBox.x + branchBox.width - indicatorsBox.x - indicatorsBox.width).toBeCloseTo(3.4, 0);
  expect(branchBox.y + branchBox.height - indicatorsBox.y - indicatorsBox.height).toBeCloseTo(3.4, 0);
  expect(indicatorsBox.y).toBeLessThan(glyphBox.y + glyphBox.height);
  await expect(shortcutIndicators).toHaveCSS('position', 'absolute');
  expect(dirtyBox.x).toBeGreaterThanOrEqual(branchBox.x);
  expect(dirtyBox.x + dirtyBox.width).toBeLessThanOrEqual(branchBox.x + branchBox.width + 1);

  await branch.click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const footer = panel.locator('.git-status-panel-footer');
  const card = footer.locator(':scope > .pull-request-card');
  const actions = footer.locator(':scope > .git-status-actions');
  const mode = footer.getByRole('group', { name: 'Git change view' });
  await expect(footer.locator(':scope > .git-status-actions + .pull-request-card + .git-status-mode')).toHaveCount(1);
  await expect(card.getByRole('link', { name: `Open pull request #812: ${longTitle}` })).toHaveAttribute('href', activePullRequest.url);
  const [footerBox, actionsBox, cardBox, modeBox, reviewBox, pushBox, allPrBox] = await Promise.all([
    renderedBox(footer), renderedBox(actions), renderedBox(card), renderedBox(mode), renderedBox(actions.getByRole('button', { name: 'Review', exact: true })), renderedBox(actions.getByRole('button', { name: 'Finish and PR', exact: true })), renderedBox(mode.getByRole('button', { name: 'All PR' }))
  ]);
  expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(cardBox.x + 1);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(modeBox.x + 1);
  expect([actionsBox, cardBox, modeBox].every(box => { /* center one footer control */ return Math.abs(box.y + box.height / 2 - cardBox.y - cardBox.height / 2) <= 1; })).toBe(true);
  // match standard controls without shrinking the pr card
  expect(Math.abs(reviewBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(pushBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(allPrBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect(cardBox.x).toBeGreaterThanOrEqual(footerBox.x);
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(footerBox.x + footerBox.width);
  const titleOverflow = await card.locator('.pull-request-card-main > span').evaluate(element => { /* measure the long title */ return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }; });
  expect(titleOverflow.scrollWidth).toBeGreaterThan(titleOverflow.clientWidth);

  const working = mode.getByRole('button', { name: 'Working' });
  const allPr = mode.getByRole('button', { name: 'All PR' });
  await working.click();
  await expect(card).toBeVisible();
  await allPr.click();
  await expect(card).toBeVisible();
  await panel.getByRole('tab', { name: 'PRs', exact: true }).click();
  await expect(panel.locator('.pull-request-card')).toHaveCount(0);
  await panel.getByRole('tab', { name: 'Working', exact: true }).click();
  await expect(card).toBeVisible();

  // keep the standalone fixup immediately after push
  const fixup = actions.getByRole('button', { name: 'Queue $fixup' });
  await expect(actions.locator('.git-status-push + .pull-request-fixup')).toHaveCount(1);
  await expect(card.getByRole('button')).toHaveCount(0);
  await fixup.click();
  await expect.poll(() => promptRequests).toBe(1);
  await expect(fixup).toBeDisabled();
  await fixup.evaluate(button => { /* exercise a disabled native button */ button.click(); });
  expect(promptRequests).toBe(1);
  finishPrompt();
  await expect(fixup).toContainText('Queued');
  await expect.poll(() => historyRequests).toBeGreaterThanOrEqual(2);
});

// retain the prompt lock when the fixup control is remounted
test('keeps fixup pending across popup and tab roundtrips', async ({ page }) => {
  test.setTimeout(120_000);
  let finishPrompt = () => { /* replace with the response gate */ };
  let promptRequests = 0;
  const promptFinished = new Promise<void>(resolve => { /* expose the response gate */ finishPrompt = resolve; });
  await mountDashboard(page, {
    dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree] }] },
    // hold acceptance while the action moves through mount boundaries
    onPrompt: async () => {
      promptRequests += 1;
      await promptFinished;
    }
  });
  const branch = page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u });
  await branch.click();
  const panel = page.getByRole('region', { name: 'Changed files' });
  const fixup = panel.getByRole('button', { name: 'Queue $fixup' });
  await fixup.click();
  await expect.poll(() => promptRequests).toBe(1);
  await expect(fixup).toBeDisabled();
  await page.mouse.click(4, 4);
  await expect(panel).toHaveCount(0);
  await branch.click();
  await expect(fixup).toBeDisabled();
  await fixup.evaluate(button => { /* attempt a native duplicate submission */ button.click(); });
  await panel.getByRole('tab', { name: 'PRs', exact: true }).click();
  await panel.getByRole('tab', { name: 'Working', exact: true }).click();
  await expect(fixup).toBeDisabled();
  await fixup.evaluate(button => { /* attempt another native duplicate submission */ button.click(); });
  expect(promptRequests).toBe(1);
  finishPrompt();
  await expect(fixup).toBeEnabled();
});

// surface rejected and disconnected submissions without preventing retries
test('reports fixup failures and allows a successful retry', async ({ page }) => {
  test.setTimeout(120_000);
  await mountDashboard(page, { dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree] }] } });
  let promptRequests = 0;
  await page.route('**/api/agents/agent-active/prompt', async route => {
    promptRequests += 1;
    // expose the server rejection
    if (promptRequests === 1) return route.fulfill({ status: 409, json: { error: 'Agent is not accepting prompts' } });
    // simulate a lost connection on retry
    if (promptRequests === 2) return route.abort('failed');
    return route.fulfill({ status: 202, json: { ok: true } });
  });
  await page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u }).click();
  const fixup = page.getByRole('region', { name: 'Changed files' }).getByRole('button', { name: 'Queue $fixup' });
  await fixup.click();
  const feedback = page.locator('.operation-feedback[role="alert"]');
  await expect(feedback).toContainText('Agent is not accepting prompts');
  await expect(fixup).toBeEnabled();
  await fixup.click();
  await expect(feedback).toContainText('Console unavailable');
  await expect(fixup).toBeEnabled();
  await fixup.click();
  await expect(fixup).toContainText('Queued');
  expect(promptRequests).toBe(3);
});

// verify the narrow stacked footer and fixed shortcut rail
test('stacks standard-height Working footer controls at 375px without growing the branch shortcut', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await mountDashboard(page, { dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree] }] } });

  const branch = page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u });
  const [branchBox, attachmentBox] = await Promise.all([renderedBox(branch), renderedBox(page.getByRole('button', { name: 'Attach files' }))]);
  expect(Math.abs(branchBox.width - attachmentBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(branchBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  await branch.click();

  const panel = page.getByRole('region', { name: 'Changed files' });
  const footer = panel.locator('.git-status-panel-footer');
  const actions = footer.locator(':scope > .git-status-actions');
  const card = footer.locator(':scope > .pull-request-card');
  const mode = footer.getByRole('group', { name: 'Git change view' });
  const [panelBox, footerBox, actionsBox, cardBox, modeBox, reviewBox, workingBox] = await Promise.all([
    renderedBox(panel), renderedBox(footer), renderedBox(actions), renderedBox(card), renderedBox(mode), renderedBox(actions.getByRole('button', { name: 'Review', exact: true })), renderedBox(mode.getByRole('button', { name: 'Working' }))
  ]);
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(cardBox.y + 1);
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(modeBox.y + 1);
  expect(Math.abs(actionsBox.width - cardBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(modeBox.width - cardBox.width)).toBeLessThanOrEqual(1);
  // retain standard action heights on narrow screens
  expect(Math.abs(reviewBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(workingBox.height - attachmentBox.height)).toBeLessThanOrEqual(1);
  expect([actionsBox, cardBox, modeBox].every(box => { /* contain one stacked control */ return box.x >= footerBox.x && box.x + box.width <= footerBox.x + footerBox.width + 1; })).toBe(true);
  expect([footerBox, actionsBox, cardBox, modeBox].every(box => { /* contain one panel child */ return box.x >= panelBox.x && box.x + box.width <= panelBox.x + panelBox.width + 1; })).toBe(true);
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => { /* measure page overflow */ return document.documentElement.scrollWidth; })).toBeLessThanOrEqual(375);

  const cardMain = await renderedBox(card.locator('.pull-request-card-main'));
  const cardIndicators = await renderedBox(card.locator(':scope > .pull-request-issues'));
  const fixup = await renderedBox(actions.getByRole('button', { name: 'Queue $fixup' }));
  const push = await renderedBox(actions.getByRole('button', { name: 'Finish and PR', exact: true }));
  // keep pr content on one row while fixes stay beside push
  expect(cardBox.height).toBeCloseTo(48, 0);
  expect(cardMain.y + cardMain.height / 2).toBeCloseTo(cardIndicators.y + cardIndicators.height / 2, 0);
  expect(fixup.y).toBeCloseTo(push.y, 0);
  expect(fixup.x).toBeGreaterThanOrEqual(push.x + push.width);
  expect(fixup.height).toBeCloseTo(attachmentBox.height, 0);
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(card.locator('.pull-request-card-main > span')).toHaveCount(1);
  await expect(card.locator('.pull-request-card-main > span')).toHaveCSS('text-overflow', 'ellipsis');
  // verify truncation instead of a wrapped title
  const title = await card.locator('.pull-request-card-main > span').evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(title.clientWidth).toBeGreaterThan(0);
  expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);

  await page.setViewportSize({ width: 667, height: 320 });
  await expect(panel).toHaveCSS('overflow-y', 'auto');
  const shortPanelBox = await renderedBox(panel);
  expect(shortPanelBox.y).toBeGreaterThanOrEqual(0);
  expect(shortPanelBox.y + shortPanelBox.height).toBeLessThanOrEqual(320);
  await expectReachableWithin(actions, panel);
  await expectReachableWithin(card, panel);
  await expectReachableWithin(mode, panel);
});

// verify status presentation across live and idle worktrees
test('applies pull request status colors and indicators to active and inactive branch controls', async ({ page }) => {
  test.setTimeout(120_000);
  const draftWorktree = {
    id: 'draft', projectId: 'repo', label: 'Draft', path: '/worktrees/draft', main: false, detached: false, locked: false, available: true, pinned: true, order: 1,
    branch: 'feature/draft', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, pullRequest: { number: 813, title: 'Draft work', status: 'draft', url: 'https://github.example.com/pull/813', checks: 'pending' }
  };
  const mergedWorktree = {
    id: 'merged', projectId: 'repo', label: 'Merged', path: '/worktrees/merged', main: false, detached: false, locked: false, available: true, pinned: true, order: 2,
    branch: 'feature/merged', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 }, pullRequest: { number: 814, title: 'Merged work', status: 'merged', url: 'https://github.example.com/pull/814', checks: 'passed', issues: { unresolvedComments: true } }
  };
  const noPullRequestWorktree = {
    id: 'plain', projectId: 'repo', label: 'Plain', path: '/worktrees/plain', main: false, detached: false, locked: false, available: true, pinned: true, order: 3,
    branch: 'feature/plain', gitStatus: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0 }
  };
  await mountDashboard(page, {
    dashboard: { generation: 1, agents: [activeAgent], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [activeWorktree, draftWorktree, mergedWorktree, noPullRequestWorktree] }] }
  });

  const activeBranch = page.getByRole('button', { name: /^Git status: feature\/current-pr-controls/u });
  await expect(activeBranch).toBeVisible({ timeout: 15_000 });
  await expect(activeBranch).toHaveCSS('color', 'rgb(166, 227, 161)');

  await page.getByRole('tab', { name: /^Draft —/u }).click();
  const draftBranch = page.getByRole('button', { name: /^Git status: feature\/draft/u });
  await expect(draftBranch).toHaveClass(/\bhas-pull-request\b/u);
  await expect(draftBranch).toHaveClass(/\bstatus-draft\b/u);
  await expect(draftBranch.locator('.git-branch')).toHaveCSS('color', 'rgb(147, 153, 178)');
  await expect(draftBranch.locator(':scope > .pull-request-issues').getByRole('img', { name: 'CI checks running' })).toBeVisible();
  await draftBranch.click();
  const inactivePanel = page.getByRole('region', { name: 'Changed files' });
  await expect(inactivePanel.locator('.git-status-panel-footer').getByRole('link', { name: 'Draft pull request #813: Draft work' })).toHaveAttribute('href', 'https://github.example.com/pull/813');
  await expect(inactivePanel.getByRole('button', { name: 'Queue $fixup' })).toHaveCount(0);
  await page.mouse.click(4, 4);

  await page.getByRole('tab', { name: /^Merged —/u }).click();
  const mergedBranch = page.getByRole('button', { name: /^Git status: feature\/merged/u });
  await expect(mergedBranch).toHaveClass(/\bstatus-merged\b/u);
  await expect(mergedBranch.locator('.git-branch')).toHaveCSS('color', 'rgb(203, 166, 247)');
  await expect(mergedBranch.locator(':scope > .pull-request-issues').getByRole('img', { name: 'CI checks passed' })).toBeVisible();
  await expect(mergedBranch.locator(':scope > .pull-request-issues').getByRole('img', { name: 'Unresolved review comments' })).toBeVisible();

  await page.getByRole('tab', { name: /^Plain —/u }).click();
  const plainBranch = page.getByRole('button', { name: /^Git status: feature\/plain/u });
  await expect(plainBranch).not.toHaveClass(/\bhas-pull-request\b/u);
  await expect(plainBranch).not.toHaveClass(/\bstatus-(?:draft|open|merged)\b/u);
  await expect(plainBranch.locator(':scope > .pull-request-issues')).toHaveCount(0);
  await expect(plainBranch.locator('.git-branch')).toHaveCSS('color', 'rgb(180, 190, 254)');
});
