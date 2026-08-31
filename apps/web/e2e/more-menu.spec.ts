import { expect, test } from '@playwright/test';

test('keeps file attachments in the icon-labelled more menu', async ({ page }) => {
  test.setTimeout(60_000);
  let finishPullRequests!: () => void;
  let finishPullRequestRefresh!: () => void;
  let finishGithubActions!: () => void;
  let finishNewTask!: () => void;
  let pullRequestRequests = 0;
  // hold pull requests through layout inspection
  const pullRequestsFinished = new Promise<void>(resolve => { finishPullRequests = resolve; });
  const pullRequestRefreshFinished = new Promise<void>(resolve => { finishPullRequestRefresh = resolve; });
  // hold secondary actions through loading assertions
  const githubActionsFinished = new Promise<void>(resolve => { finishGithubActions = resolve; });
  const newTaskFinished = new Promise<void>(resolve => { finishNewTask = resolve; });
  await page.context().route('https://github.example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>GitHub PR</title>' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({
      json: {
        generation: 1,
        agents: [{
          id: 'agent-1',
          sessionId: 'socket:$1',
          workspace: '/worktrees/cora',
          title: 'Ready',
          push: { label: 'Finish and PR', prompt: '$finish' },
          newTaskConfigured: true
        }],
        worktrees: []
      }
    });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/new-task' && request.method() === 'GET') {
      await newTaskFinished;
      return route.fulfill({ json: { enabled: true } });
    }
    if (url.pathname === '/api/agents/agent-1/github-actions') {
      await githubActionsFinished;
      return route.fulfill({ json: { url: 'https://github.com/octo/repo/actions' } });
    }
    if (url.pathname === '/api/agents/agent-1/switch-prs') {
      pullRequestRequests += 1;
      await (pullRequestRequests === 1 ? pullRequestsFinished : pullRequestRefreshFinished);
      return route.fulfill({
        json: {
          enabled: true,
          pullRequests: [{
            number: 2567,
            title: 'Make prompt actions fit',
            branch: 'fix/prompt-actions',
            draft: false,
            url: 'https://github.example.com/pull/2567',
            checks: 'failed',
            issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true },
            checkedOut: false
          }, {
            number: 2568,
            title: 'Prompt actions experiment',
            branch: 'draft/prompt-actions',
            draft: true,
            url: 'https://github.example.com/pull/2568',
            checkedOut: false
          }],
          otherPullRequests: []
        }
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.locator('.prompt-actions .attachment-button')).toHaveCount(0);
  await page.getByRole('button', { name: 'More options' }).click();

  const menu = page.locator('.more-menu');
  await expect(page.locator('.prompt-actions > .swap-agent')).toHaveCount(0);
  const pullRequestHeading = menu.getByRole('button', { name: 'Pull requests', exact: true });
  const loadingPlaceholder = menu.getByRole('status', { name: 'Loading pull requests…', exact: true });
  const loadingSpinner = pullRequestHeading.locator('.spinner');
  const attachMenuItem = menu.getByRole('button', { name: 'Attach files', exact: true });
  const menuIcon = attachMenuItem.locator('.more-menu-icon');
  await expect(loadingPlaceholder).toBeVisible();
  await expect(pullRequestHeading).toBeDisabled();
  const swapItem = menu.getByRole('button', { name: 'Swap to terminal', exact: true });
  const [pullRequestHeadingBox, swapBox, stableItemBefore] = await Promise.all([pullRequestHeading.boundingBox(), swapItem.boundingBox(), attachMenuItem.boundingBox()]);
  expect(pullRequestHeadingBox).not.toBeNull();
  expect(swapBox).not.toBeNull();
  expect(stableItemBefore).not.toBeNull();
  expect(pullRequestHeadingBox!.y).toBeLessThan(swapBox!.y);
  const [spinnerSize, iconSize] = await Promise.all([loadingSpinner, menuIcon].map(async item => await item.evaluate(element => {
    const style = getComputedStyle(element);
    return { width: style.width, height: style.height };
  })));
  expect(spinnerSize).toEqual(iconSize);
  const [loadingLayout, menuItemLayout] = await Promise.all([pullRequestHeading, attachMenuItem].map(async item => await item.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      tagName: element.tagName,
      display: style.display,
      alignItems: style.alignItems,
      justifyContent: style.justifyContent,
      gap: style.gap,
      padding: style.padding,
      font: style.font,
      letterSpacing: style.letterSpacing
    };
  })));
  expect(loadingLayout).toEqual(menuItemLayout);
  finishPullRequests();
  for (const label of ['Swap to terminal', 'Finish and PR', 'Attach files']) {
    const item = menu.getByRole('button', { name: label, exact: true });
    await expect(item).toBeVisible();
    await expect(item.locator('.more-menu-icon')).toHaveCount(1);
  }
  await expect(menu.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'Change directory', exact: true })).toHaveCount(0);
  const loadingGithubActions = menu.getByRole('button', { name: 'GitHub Actions', exact: true });
  const loadingNewTask = menu.getByRole('button', { name: 'New Task', exact: true });
  await expect(loadingGithubActions).toBeVisible();
  await expect(loadingGithubActions).toBeDisabled();
  await expect(loadingGithubActions.locator('.spinner')).toBeVisible();
  await expect(loadingNewTask).toBeVisible();
  await expect(loadingNewTask).toBeDisabled();
  await expect(loadingNewTask.locator('.spinner')).toBeVisible();
  finishGithubActions();
  finishNewTask();
  const actions = menu.getByRole('link', { name: 'GitHub Actions', exact: true });
  await expect(actions).toBeVisible();
  await expect(actions).toHaveAttribute('href', 'https://github.com/octo/repo/actions');
  await expect(actions).toHaveAttribute('target', '_blank');
  await expect(actions.locator('.more-menu-icon')).toHaveCount(1);
  await expect(loadingPlaceholder).toHaveCount(0);
  await expect(menu.locator('.new-task-option .more-menu-reason')).toHaveText('Start a fresh task for this worktree.');
  const attachItem = menu.getByRole('button', { name: 'Attach files', exact: true });
  await attachItem.hover();
  await expect(attachItem).toHaveCSS('background-color', 'rgb(49, 50, 68)');

  await expect(menu.getByRole('button', { name: 'Switch to PR', exact: true })).toHaveCount(0);
  const pullRequest = menu.getByRole('button', { name: '#2567: Make prompt actions fit', exact: true });
  await expect(pullRequest).toBeVisible();
  await expect.poll(async () => Math.abs((await attachMenuItem.boundingBox())!.y - stableItemBefore!.y)).toBeLessThanOrEqual(1);
  await expect(pullRequest).not.toContainText('Open');
  const pullRequestActions = pullRequest.locator('xpath=..').locator('.switch-pr-actions');
  const statusIcon = pullRequestActions.locator('.switch-pr-status-icon');
  await expect(statusIcon).toHaveCSS('mask-image', /github-favicon\.svg/);
  await expect(statusIcon).toHaveCSS('background-color', 'rgb(166, 227, 161)');
  await expect(pullRequestActions.getByRole('img', { name: 'CI checks failed' })).toBeVisible();
  await expect(pullRequestActions.getByRole('img', { name: 'Merge conflicts' })).toBeVisible();
  await expect(pullRequestActions.getByRole('img', { name: 'Unresolved review comments' })).toBeVisible();
  await expect(pullRequest.locator('.switch-pr-copy strong')).toHaveCSS('color', 'rgb(166, 227, 161)');
  const draft = menu.getByRole('button', { name: '#2568: Prompt actions experiment', exact: true });
  await expect(draft).not.toContainText('Draft');
  const draftIcon = draft.locator('xpath=..').locator('.switch-pr-status-icon');
  await expect(draftIcon).toHaveCSS('background-color', 'rgb(147, 153, 178)');
  await expect(draft.locator('.switch-pr-copy strong')).toHaveCSS('color', 'rgb(147, 153, 178)');
  const external = menu.getByRole('link', { name: 'Open PR #2567 in GitHub' });
  await expect(external).toHaveAttribute('href', 'https://github.example.com/pull/2567');
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external.locator('svg')).toBeVisible();
  await expect(external).toContainText('Open in GitHub');
  await expect(external).toHaveCSS('border-top-style', 'solid');
  await expect(external).toHaveCSS('border-top-width', '1px');
  const moreOptions = page.getByRole('button', { name: 'More options' });
  await moreOptions.click();
  await expect(menu).toBeHidden();
  await moreOptions.click();
  await expect(menu.getByRole('status', { name: 'Loading pull requests…', exact: true })).toBeVisible();
  await expect(pullRequest).toBeVisible();
  await expect(pullRequest).toBeDisabled();
  finishPullRequestRefresh();
  await expect(pullRequest).toBeEnabled();
  const positions = await page.locator('.switch-pr-option').first().evaluate(element => {
    const title = element.querySelector(':scope > .switch-pr')!.getBoundingClientRect();
    const actions = element.querySelector('.switch-pr-actions')!.getBoundingClientRect();
    const statusIcon = element.querySelector('.switch-pr-status-icon')!.getBoundingClientRect();
    const firstButton = element.querySelector('.switch-pr-action')!.getBoundingClientRect();
    return { titleBottom: title.bottom, actionsTop: actions.top, statusRight: statusIcon.right, firstButtonLeft: firstButton.left };
  });
  expect(positions.actionsTop).toBeGreaterThanOrEqual(positions.titleBottom - 1);
  expect(positions.firstButtonLeft).toBeGreaterThanOrEqual(positions.statusRight);
  const [github] = await Promise.all([page.waitForEvent('popup'), external.click()]);
  await expect(github).toHaveURL('https://github.example.com/pull/2567');
  await github.close();

  const fileChooserPromise = page.waitForEvent('filechooser');
  await menu.getByRole('button', { name: 'Attach files', exact: true }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('test attachment') });

  await expect(menu).toBeHidden();
  await expect(page.getByLabel('Selected attachments')).toContainText('notes.txt');
});

test('queues the configured push prompt and falls back to the default action', async ({ page }) => {
  let push: { label: string; prompt: string } | undefined = { label: 'Finish and PR', prompt: '$finish' };
  const queued: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: queued.length + 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready', ...(push === undefined ? {} : { push }) }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      const body = request.postDataJSON() as { prompt: string; attachments: unknown[] };
      expect(body.attachments).toEqual([]);
      queued.push(body.prompt);
      return route.fulfill({ status: 202, json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'More options' }).click();
  const custom = page.locator('.more-menu').getByRole('button', { name: 'Finish and PR', exact: true });
  await expect(custom.locator('.more-menu-icon')).toBeVisible();
  await custom.click();
  await expect.poll(() => queued).toEqual(['$finish']);
  await expect(page.locator('.more-menu')).toBeHidden();

  push = undefined;
  await page.reload();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.locator('.more-menu').getByRole('button', { name: 'Commit/Push', exact: true }).click();
  await expect.poll(() => queued).toEqual(['$finish', 'review, commit, and push']);
});

test('shows every pull request target while keeping external and worktree actions available', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({
      json: {
        generation: 1,
        agents: [
          { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
          { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/delta', worktreeId: 'delta', worktreeLabel: 'Delta', worktreeOrder: 1, title: 'Ready' }
        ],
        worktrees: []
      }
    });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/switch-prs') return route.fulfill({
      json: {
        enabled: false,
        pullRequests: [
          { number: 300, title: 'Visible while dirty', branch: 'feature/dirty-target', draft: false, url: 'https://github.example.com/pull/300', checkedOut: false },
          { number: 301, title: 'Already in Delta', branch: 'feature/delta-target', draft: false, url: 'https://github.example.com/pull/301', checkedOut: true, openIn: { agentId: 'agent-2', worktreeId: 'delta', worktreeName: 'Delta' } }
        ],
        otherPullRequests: [
          { number: 302, title: 'Authored by someone else', branch: 'feature/other-author', draft: false, url: 'https://github.example.com/pull/302', checkedOut: false }
        ]
      }
    });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'More options' }).click();
  const menu = page.locator('.more-menu');
  const dirtyTarget = menu.getByRole('button', { name: '#300: Visible while dirty' });
  const openTarget = menu.getByRole('button', { name: '#301: Already in Delta' });
  const otherTarget = menu.getByRole('button', { name: '#302: Authored by someone else' });
  await expect(dirtyTarget).toBeVisible();
  await expect(dirtyTarget).toBeDisabled();
  await expect(openTarget).toBeVisible();
  await expect(openTarget).toBeDisabled();
  await expect(otherTarget).not.toBeVisible();
  await menu.getByText(/^Pull requests by others/u).click();
  await expect(otherTarget).toBeVisible();
  await expect(otherTarget).toBeDisabled();
  await expect(menu.getByRole('link', { name: 'Open PR #300 in GitHub' })).toHaveAttribute('href', 'https://github.example.com/pull/300');

  const switchToDelta = menu.getByRole('button', { name: 'Switch to Delta' });
  const openDeltaInGitHub = menu.getByRole('link', { name: 'Open PR #301 in GitHub' });
  const actionOrder = await openTarget.locator('xpath=..').locator('.switch-pr-actions').locator('.switch-pr-action').evaluateAll(elements => elements.map(element => element.textContent?.trim()));
  expect(actionOrder).toEqual(['Open in GitHub', 'Switch to Delta']);
  const [externalBox, switchBox] = await Promise.all([openDeltaInGitHub.boundingBox(), switchToDelta.boundingBox()]);
  expect(externalBox).not.toBeNull();
  expect(switchBox).not.toBeNull();
  expect(switchBox!.x).toBeGreaterThanOrEqual(externalBox!.x + externalBox!.width);
  await expect(switchToDelta).toHaveCSS('border-top-style', 'solid');
  await expect(switchToDelta).toHaveCSS('border-top-width', '1px');
  await switchToDelta.click();

  await expect(page.getByRole('tab', { name: /^Delta/u })).toHaveAttribute('aria-selected', 'true');
  await expect(menu).toBeHidden();
});

test('shows the workspace pull request cache while refreshing after a tab remount', async ({ page }) => {
  let pullRequestRequests = 0;
  let finishRefresh!: () => void;
  const refreshFinished = new Promise<void>(resolve => { finishRefresh = resolve; });
  // serve cached and refreshed lists
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [
        { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
        { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/delta', worktreeId: 'delta', worktreeLabel: 'Delta', worktreeOrder: 1, title: 'Ready' }
      ],
      worktrees: []
    } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-2/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    if (url.pathname === '/api/agents/agent-1/switch-prs') {
      pullRequestRequests += 1;
      // hold the remount refresh
      if (pullRequestRequests > 1) await refreshFinished;
      const refreshed = pullRequestRequests > 1;
      return route.fulfill({ json: { enabled: true, pullRequests: [{ number: refreshed ? 402 : 401, title: refreshed ? 'Refreshed PR' : 'Cached PR', branch: refreshed ? 'feature/refreshed' : 'feature/cached', draft: false, url: `https://github.example.com/pull/${refreshed ? 402 : 401}`, checkedOut: false }], otherPullRequests: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.getByRole('button', { name: '#401: Cached PR' })).toBeVisible();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('tab', { name: /^Delta/u }).click();
  await page.getByRole('tab', { name: /^Cora/u }).click();
  await page.getByRole('button', { name: 'More options' }).click();

  const menu = page.locator('.more-menu');
  await expect.poll(() => pullRequestRequests).toBe(2);
  await expect(menu.getByRole('button', { name: 'Pull requests' }).locator('.spinner')).toBeVisible();
  await expect(menu.getByRole('button', { name: '#401: Cached PR' })).toBeVisible();
  finishRefresh();
  await expect(menu.getByRole('button', { name: '#402: Refreshed PR' })).toBeVisible();
  await expect(menu.getByRole('button', { name: '#401: Cached PR' })).toHaveCount(0);
});

// protect cached actions after refresh failures
test('disables stale pull request switching when a refresh fails', async ({ page }) => {
  let pullRequestRequests = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve one authenticated console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // provide two tabs for remounting the menu
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [
        { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' },
        { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/delta', worktreeId: 'delta', worktreeLabel: 'Delta', worktreeOrder: 1, title: 'Ready' }
      ],
      worktrees: []
    } });
    // disable unrelated browser setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-2/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    if (url.pathname === '/api/agents/agent-1/switch-prs') {
      pullRequestRequests += 1;
      // fail the remounted refresh
      if (pullRequestRequests > 1) return route.fulfill({ status: 502, json: { error: 'GitHub could not load pull requests (503).' } });
      return route.fulfill({ json: { enabled: true, pullRequests: [{ number: 401, title: 'Cached PR', branch: 'feature/cached', draft: false, url: 'https://github.example.com/pull/401', checkedOut: false }], otherPullRequests: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.getByRole('button', { name: '#401: Cached PR' })).toBeEnabled();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('tab', { name: /^Delta/u }).click();
  await page.getByRole('tab', { name: /^Cora/u }).click();
  await page.getByRole('button', { name: 'More options' }).click();

  const menu = page.locator('.more-menu');
  const stalePullRequest = menu.getByRole('button', { name: '#401: Cached PR' });
  await expect(menu.getByRole('alert')).toHaveText('GitHub could not load pull requests (503).');
  await expect(stalePullRequest).toBeVisible();
  await expect(stalePullRequest).toBeDisabled();
  await expect(stalePullRequest).toHaveAttribute('title', 'Pull request list could not be refreshed');
  await expect(menu.getByRole('link', { name: 'Open PR #401 in GitHub' })).toBeEnabled();
});

test('formats the empty pull request state like the New Task description', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'More options' }).click();
  const menu = page.locator('.more-menu');
  const empty = menu.getByRole('status', { name: 'No open pull requests.', exact: true });
  const newTaskDescription = menu.locator('.new-task-option .more-menu-reason');
  await expect(menu.getByRole('link', { name: 'GitHub Actions' })).toHaveCount(0);
  const unavailableActions = menu.getByRole('button', { name: 'GitHub Actions' });
  const unavailableNewTask = menu.getByRole('button', { name: 'New Task', exact: true });
  await expect(unavailableActions).toBeVisible();
  await expect(unavailableActions).toBeDisabled();
  await expect(unavailableNewTask).toBeVisible();
  await expect(unavailableNewTask).toBeDisabled();
  await expect(empty).toBeVisible();
  const [emptyLayout, descriptionLayout] = await Promise.all([empty, newTaskDescription].map(async item => await item.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      display: style.display,
      color: style.color,
      padding: style.padding,
      font: style.font,
      letterSpacing: style.letterSpacing,
      whiteSpace: style.whiteSpace
    };
  })));
  expect(emptyLayout).toEqual(descriptionLayout);
});

// expose failed pull request lookups
test('shows the GitHub error instead of an empty pull request state', async ({ page }) => {
  // serve one failed pull request request
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // authenticate the browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide agent bootstrap data
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // provide saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // fail the pull request lookup
    if (url.pathname === '/api/agents/agent-1/switch-prs') return route.fulfill({ status: 502, json: { error: 'GitHub could not load pull requests (503): temporary outage.' } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'More options' }).click();
  const menu = page.locator('.more-menu');
  await expect(menu.getByRole('alert', { name: 'GitHub could not load pull requests (503): temporary outage.' })).toBeVisible();
  await expect(menu.getByRole('status', { name: 'No open pull requests.' })).toHaveCount(0);
});
