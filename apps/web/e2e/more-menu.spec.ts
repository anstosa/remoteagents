import { expect, test } from '@playwright/test';

test('keeps file attachments in the icon-labelled more menu', async ({ page }) => {
  test.setTimeout(60_000);
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
          newTaskConfigured: true
        }],
        worktrees: []
      }
    });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/new-task' && request.method() === 'GET') return route.fulfill({ json: { enabled: true } });
    if (url.pathname === '/api/agents/agent-1/switch-prs') {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      return route.fulfill({
        json: {
          enabled: true,
          pullRequests: [{
            number: 2567,
            title: 'Make prompt actions fit',
            branch: 'fix/prompt-actions',
            draft: false,
            url: 'https://github.example.com/pull/2567',
            checkedOut: false
          }, {
            number: 2568,
            title: 'Prompt actions experiment',
            branch: 'draft/prompt-actions',
            draft: true,
            url: 'https://github.example.com/pull/2568',
            checkedOut: false
          }]
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
  const loadingPlaceholder = menu.getByRole('status', { name: 'Loading pull requests' });
  const loadingSpinner = loadingPlaceholder.locator('.spinner');
  const menuIcon = menu.getByRole('button', { name: 'Attach files', exact: true }).locator('.more-menu-icon');
  await expect(loadingPlaceholder).toBeVisible();
  const [spinnerSize, iconSize] = await Promise.all([loadingSpinner, menuIcon].map(async item => await item.evaluate(element => {
    const style = getComputedStyle(element);
    return { width: style.width, height: style.height };
  })));
  expect(spinnerSize).toEqual(iconSize);
  for (const label of ['Swap to terminal', 'Attach files', 'Change directory', 'New Task']) {
    const item = menu.getByRole('button', { name: label, exact: true });
    await expect(item).toBeVisible();
    await expect(item.locator('.more-menu-icon')).toHaveCount(1);
  }
  const attachItem = menu.getByRole('button', { name: 'Attach files', exact: true });
  await attachItem.hover();
  await expect(attachItem).toHaveCSS('background-color', 'rgb(49, 50, 68)');

  await expect(menu.getByRole('button', { name: 'Switch to PR', exact: true })).toHaveCount(0);
  const pullRequest = menu.getByRole('button', { name: '#2567: Make prompt actions fit', exact: true });
  await expect(pullRequest).toBeVisible();
  await expect(pullRequest).not.toContainText('Open');
  const statusIcon = pullRequest.locator('.switch-pr-status-icon');
  await expect(statusIcon).toHaveCSS('mask-image', /github-favicon\.svg/);
  await expect(statusIcon).toHaveCSS('background-color', 'rgb(166, 227, 161)');
  await expect(pullRequest.locator('.switch-pr-copy strong')).toHaveCSS('color', 'rgb(166, 227, 161)');
  const draft = menu.getByRole('button', { name: '#2568: Prompt actions experiment', exact: true });
  await expect(draft).not.toContainText('Draft');
  const draftIcon = draft.locator('.switch-pr-status-icon');
  await expect(draftIcon).toHaveCSS('background-color', 'rgb(147, 153, 178)');
  await expect(draft.locator('.switch-pr-copy strong')).toHaveCSS('color', 'rgb(147, 153, 178)');
  const external = menu.getByRole('link', { name: 'Open PR #2567 in GitHub' });
  await expect(external).toHaveAttribute('href', 'https://github.example.com/pull/2567');
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external.locator('svg')).toBeVisible();
  const positions = await page.locator('.switch-pr-option').first().evaluate(element => {
    const option = element.getBoundingClientRect();
    const button = element.querySelector('button')!.getBoundingClientRect();
    const link = element.querySelector('a')!.getBoundingClientRect();
    return { optionRight: option.right, buttonRight: button.right, linkLeft: link.left, linkRight: link.right };
  });
  expect(positions.linkLeft).toBeGreaterThanOrEqual(positions.buttonRight);
  expect(Math.abs(positions.optionRight - positions.linkRight)).toBeLessThanOrEqual(1);
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
  await expect(dirtyTarget).toBeVisible();
  await expect(dirtyTarget).toBeDisabled();
  await expect(openTarget).toBeVisible();
  await expect(openTarget).toBeDisabled();
  await expect(menu.getByRole('link', { name: 'Open PR #300 in GitHub' })).toHaveAttribute('href', 'https://github.example.com/pull/300');

  await menu.getByRole('button', { name: 'Switch to Delta' }).click();

  await expect(page.getByRole('tab', { name: /^Delta/u })).toHaveAttribute('aria-selected', 'true');
  await expect(menu).toBeHidden();
});
