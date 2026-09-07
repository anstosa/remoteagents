import { expect, test } from '@playwright/test';

test('keeps the active tab, output, and prompt controls inside a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 952 });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({
      json: {
        generation: 1,
        agents: [
          { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', displayLabel: '🥔 Cora', title: 'Ready' },
          { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/owen', displayLabel: '🥔 Owen', title: 'Ready' },
          { id: 'agent-3', sessionId: 'socket:$3', workspace: '/worktrees/dave', displayLabel: '🥔 Dave', title: 'Ready' },
          { id: 'agent-4', sessionId: 'socket:$4', workspace: '/worktrees/eric', displayLabel: '🥔 Eric', title: 'Ready' },
          { id: 'agent-5', sessionId: 'socket:$5', workspace: '/worktrees/remote-agents', worktreeId: 'remote-agents', branch: 'feature/output-git-summary', gitStatus: { files: 3, staged: 1, unstaged: 2, untracked: 1, conflicted: 0 }, displayLabel: '📱 Remote Agents', title: 'Ready', attention: 'finished', projectUrl: 'https://project.example.com', stack: { actions: ['start', 'build'], tunnel: true }, pullRequest: { number: 42, title: 'Move the worktree tabs', status: 'open', url: 'https://github.com/octo/repo/pull/42' } }
        ],
        projects: []
      }
    });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[1-5]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[1-5]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [{ id: 'saved-1', text: 'Saved prompt' }] } });
    if (url.pathname === '/api/agents/agent-5/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [], otherPullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const activeTab = page.getByRole('tab', { name: /^📱 Remote Agents/u });
  await activeTab.click();
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Live log')).toBeVisible();
  const callDavo = page.locator('.output-server-switcher').getByRole('button', { name: 'Call Davo' });
  await expect(callDavo.locator('span')).toHaveText('Call Davo');
  const gitStatus = page.getByLabel('Git status: feature/output-git-summary; 3 changes (1 staged file, 2 unstaged files, 1 untracked file)');
  await expect(gitStatus).toBeVisible();
  await gitStatus.click();
  await expect(page.getByRole('region', { name: 'Changed files' })).toContainText('Changed-file details unavailable');
  await expect(page.getByRole('button', { name: 'Collapse git status' })).toHaveCount(0);
  // dismiss through the click-blocking backdrop
  await page.mouse.click(4, 4);
  await expect(page.locator('.log-status i')).toHaveCount(0);

  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      activeTab: bounds('[role="tab"][aria-selected="true"]'),
      output: bounds('.log'),
      outputBorder: (() => {
        const style = getComputedStyle(document.querySelector<HTMLElement>('.log')!);
        return { top: style.borderTopWidth, bottom: style.borderBottomWidth };
      })(),
      gitSummary: bounds('.git-status-summary'),
      gitBranchDisplay: getComputedStyle(document.querySelector<HTMLElement>('.git-branch')!).display,
      gitDotDisplay: getComputedStyle(document.querySelector<HTMLElement>('.git-status-dot')!).display,
      gitIconDisplay: getComputedStyle(document.querySelector<HTMLElement>('.git-branch-icon')!).display,
      gitDot: bounds('.git-status-dot'),
      promptRail: bounds('.prompt-action-rail'),
      attachment: bounds('.prompt-action-rail .attachment-button'),
      power: bounds('.prompt-action-rail .deactivate-agent'),
      stackTrigger: bounds('.project-stack-trigger'),
      stackDot: bounds('.project-stack-status-dot'),
      logStatus: bounds('.log-status'),
      serverSwitcher: bounds('.output-server-switcher'),
      serverSettings: bounds('.output-server-switcher .server-switcher-settings'),
      promptMore: bounds('.prompt-actions .more'),
      logStatusStyle: (() => {
        const style = getComputedStyle(document.querySelector<HTMLElement>('.log-status')!);
        return { position: style.position, boxShadow: style.boxShadow, backgroundColor: style.backgroundColor, color: style.color, backdropFilter: style.backdropFilter };
      })(),
      pullRequest: bounds('.pull-request-card'),
      tabs: bounds('.tabs'),
      prompt: bounds('.prompt'),
      promptActions: bounds('.prompt-actions'),
      controls: [...document.querySelectorAll<HTMLElement>('.prompt-actions button, .prompt-actions .project-open')].map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      })
    };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.activeTab.left).toBeGreaterThanOrEqual(0);
  expect(layout.activeTab.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(Math.abs(layout.output.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.output.width - layout.viewportWidth)).toBeLessThanOrEqual(1);
  expect(layout.outputBorder).toEqual({ top: '0px', bottom: '1px' });
  // the shortcut rail renders branch state as a corner badge
  expect(layout.gitBranchDisplay).toBe('none');
  expect(layout.gitDotDisplay).toBe('block');
  expect(layout.gitIconDisplay).toBe('block');
  expect(layout.gitSummary.right).toBeLessThanOrEqual(layout.viewportWidth);
  // match the branch and stack corner badge offsets
  expect(Math.abs((layout.gitDot.top - layout.gitSummary.top) - (layout.stackDot.top - layout.stackTrigger.top))).toBeLessThanOrEqual(1);
  expect(Math.abs((layout.gitSummary.right - layout.gitDot.right) - (layout.stackTrigger.right - layout.stackDot.right))).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.gitDot.width - layout.stackDot.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.gitDot.height - layout.stackDot.height)).toBeLessThanOrEqual(1);
  // keep one standard gap between the fixed shortcut rows
  expect(Math.abs(layout.attachment.top - layout.gitSummary.bottom - 6)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.power.top - layout.attachment.bottom - 6)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.attachment.left - layout.power.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.power.bottom - layout.promptRail.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.power.bottom - layout.promptActions.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.power.bottom - layout.prompt.bottom)).toBeLessThanOrEqual(1);
  expect(layout.logStatusStyle.position).toBe('absolute');
  expect(layout.logStatusStyle.boxShadow).not.toBe('none');
  expect(layout.logStatusStyle.backgroundColor).toBe('rgb(249, 226, 175)');
  expect(layout.logStatusStyle.color).toBe('rgb(17, 17, 27)');
  expect(layout.logStatusStyle.backdropFilter).toBe('none');
  expect(layout.logStatus.top).toBeGreaterThan(layout.serverSwitcher.bottom);
  expect(Math.abs(layout.logStatus.left - layout.serverSwitcher.left)).toBeLessThanOrEqual(1);
  expect(layout.logStatus.height).toBeLessThan(layout.serverSwitcher.height);
  expect(Math.abs(layout.logStatus.height - 32)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.serverSwitcher.height - layout.promptMore.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.serverSettings.width - layout.promptMore.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.serverSettings.height - layout.promptMore.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.serverSwitcher.left - layout.prompt.left)).toBeLessThanOrEqual(1);
  expect(layout.serverSwitcher.right).toBeLessThanOrEqual(layout.prompt.right);
  expect(layout.serverSwitcher.width).toBeLessThan(layout.prompt.width);
  // the upper toolbar is gone: tabs sit directly under the output, and no .log-topbar exists
  expect(Math.abs(layout.tabs.top - layout.output.bottom)).toBeLessThanOrEqual(1);
  await expect(page.locator('.log-topbar')).toHaveCount(0);
  expect(layout.pullRequest.top).toBeGreaterThanOrEqual(layout.tabs.bottom);
  expect(layout.pullRequest.bottom).toBeLessThanOrEqual(layout.prompt.top);
  expect(layout.controls.every(control => control.left >= 0 && control.right <= layout.viewportWidth)).toBe(true);
  const finalRowTop = Math.max(...layout.controls.map(control => control.top));
  const finalRow = layout.controls.filter(control => Math.abs(control.top - finalRowTop) < 1);
  expect(finalRow.every(control => Math.abs(control.bottom - layout.power.bottom) <= 1)).toBe(true);
  const finalRowRight = Math.max(...finalRow.map(control => control.right));
  expect(Math.abs(layout.promptActions.right - finalRowRight)).toBeLessThanOrEqual(1);

  const promptBox = page.getByRole('textbox', { name: 'Prompt' });
  await promptBox.fill(Array.from({ length: 10 }, (_, index) => `Growing line ${index + 1}`).join('\n'));
  await expect.poll(async () => (await promptBox.boundingBox())?.height ?? 0).toBeGreaterThan(100);
  const grown = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    };
    return {
      prompt: bounds('.prompt'),
      branch: bounds('.git-status-summary'),
      power: bounds('.prompt-action-rail .deactivate-agent'),
      actions: bounds('.prompt-actions')
    };
  });
  // grow the prompt upward without moving either bottom control row
  expect(grown.prompt.top).toBeLessThan(layout.prompt.top);
  expect(Math.abs(grown.prompt.bottom - layout.prompt.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(grown.branch.top - layout.gitSummary.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(grown.power.bottom - layout.power.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(grown.actions.bottom - layout.promptActions.bottom)).toBeLessThanOrEqual(1);
});
