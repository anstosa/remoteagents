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
          { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', displayLabel: '🥔 Cora', title: 'Ready' },
          { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', displayLabel: '🥔 Owen', title: 'Ready' },
          { id: 'agent-3', sessionId: 'socket:$3', home: '/worktrees/dave', displayLabel: '🥔 Dave', title: 'Ready' },
          { id: 'agent-4', sessionId: 'socket:$4', home: '/worktrees/eric', displayLabel: '🥔 Eric', title: 'Ready' },
          { id: 'agent-5', sessionId: 'socket:$5', home: '/worktrees/remote-agents', worktreeId: 'remote-agents', branch: 'feature/output-git-summary', gitStatus: { files: 3, staged: 1, unstaged: 2, untracked: 1, conflicted: 0 }, displayLabel: '📱 Remote Agents', title: 'Ready', attention: 'finished', projectUrl: 'https://project.example.com', stack: { actions: ['start', 'build'], tunnel: true }, pullRequest: { number: 42, title: 'Move the worktree tabs', status: 'open', url: 'https://github.com/octo/repo/pull/42' } }
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
  // a phone picks its Workspace from the current-Workspace dropdown's sheet
  const dropdown = page.locator('.tabs .workspace-dropdown');
  await dropdown.click();
  await page.getByRole('dialog', { name: 'Workspaces' }).getByRole('button', { name: /^📱 Remote Agents/u }).click();
  await expect(dropdown).toContainText('📱 Remote Agents');
  await expect(page.getByLabel('Live log')).toBeVisible();
  // the phone tab row opens on the server selector, an icon-only Call and settings
  const lead = page.locator('.tabs > .tab-row-lead');
  await expect(lead.getByRole('button', { name: 'Call Davo' }).locator('svg')).toBeVisible();
  await expect(lead.getByRole('button', { name: 'Call Davo' }).locator('span')).toBeHidden();
  await expect(lead.locator('.server-selector-name')).toBeHidden();
  // the phone toolbar keeps Launch, Terminal and Notes; Browser and Code move into its ⋮, and a
  // Workspace with one panel shows no position dots
  const workspaceToolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(workspaceToolbar.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
  await expect(workspaceToolbar.getByRole('button', { name: 'Browser', exact: true })).toHaveCount(0);
  await expect(workspaceToolbar.getByRole('button', { name: 'Code', exact: true })).toHaveCount(0);
  await expect(workspaceToolbar.getByRole('group', { name: 'Panels' })).toHaveCount(0);
  await workspaceToolbar.getByRole('button', { name: 'More options' }).click();
  await expect(page.locator('.place-menu').getByRole('button', { name: 'Browser', exact: true })).toBeVisible();
  await expect(page.locator('.place-menu').getByRole('button', { name: 'Code', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.click(4, 4);
  await expect(page.locator('.place-menu')).toHaveCount(0);
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
      activeTab: bounds('.tabs .workspace-dropdown'),
      output: bounds('.log'),
      outputBorder: (() => {
        const style = getComputedStyle(document.querySelector<HTMLElement>('.log')!);
        return { top: style.borderTopWidth, bottom: style.borderBottomWidth };
      })(),
      headerTitle: bounds('.agent-panel .panel-header-title'),
      headerActions: bounds('.agent-panel .panel-header-actions'),
      power: bounds('.agent-panel .agent-power'),
      composer: bounds('.agent-composer'),
      history: bounds('.agent-composer .prompt-history-toggle'),
      attachment: bounds('.agent-composer .attachment-button'),
      queued: bounds('.agent-composer .queued-prompts-toggle'),
      send: bounds('.agent-composer .queue'),
      prompt: bounds('.agent-composer textarea'),
      gitSummary: bounds('.workspace-toolbar .git-status-summary'),
      gitBranchDisplay: getComputedStyle(document.querySelector<HTMLElement>('.workspace-toolbar .git-branch')!).display,
      tabRowLead: bounds('.tab-row-lead'),
      serverSettings: bounds('.tab-row-lead .server-switcher-settings'),
      tabs: bounds('.tabs'),
      bar: bounds('.workspace-toolbar'),
      barActions: bounds('.workspace-toolbar .workspace-toolbar-actions'),
      controls: [...document.querySelectorAll<HTMLElement>('.workspace-toolbar .workspace-toolbar-actions button, .workspace-toolbar .workspace-toolbar-actions .project-open')].map(element => {
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
  // the agent panel's header pills float over its top corners, power last
  expect(Math.abs(layout.headerTitle.top - layout.output.top - 6.4)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.headerTitle.left - layout.output.left - 6.4)).toBeLessThanOrEqual(1);
  expect(layout.headerActions.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.power.right).toBeLessThanOrEqual(layout.headerActions.right);
  // the composer sits inside the panel: history above attach on the left, queued above send on the right
  expect(layout.composer.bottom).toBeLessThanOrEqual(layout.output.bottom + 1);
  expect(Math.abs(layout.history.left - layout.attachment.left)).toBeLessThanOrEqual(1);
  expect(layout.history.bottom).toBeLessThanOrEqual(layout.attachment.top);
  expect(layout.attachment.right).toBeLessThanOrEqual(layout.prompt.left);
  expect(Math.abs(layout.queued.left - layout.send.left)).toBeLessThanOrEqual(1);
  expect(layout.queued.bottom).toBeLessThanOrEqual(layout.send.top);
  expect(layout.send.left).toBeGreaterThanOrEqual(layout.prompt.right);
  expect(layout.send.right).toBeLessThanOrEqual(layout.viewportWidth);
  // the server selector, Call and settings lead the tab row at tab height
  expect(Math.abs(layout.tabRowLead.left - layout.tabs.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.tabRowLead.top - layout.tabs.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.serverSettings.height - layout.activeTab.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.serverSettings.width - layout.serverSettings.height)).toBeLessThanOrEqual(1);
  // the upper toolbar is gone: tabs sit directly under the output, and no .log-topbar exists
  expect(Math.abs(layout.tabs.top - layout.output.bottom)).toBeLessThanOrEqual(1);
  await expect(page.locator('.log-topbar')).toHaveCount(0);
  await expect(page.locator('.agent-view > .pull-request-card')).toHaveCount(0);
  // the Workspace's controls sit on one row beneath the tabs, git shrunk to its icon and state dot
  expect(layout.bar.top).toBeGreaterThanOrEqual(layout.tabs.bottom - 1);
  expect(layout.gitBranchDisplay).toBe('none');
  expect(layout.gitSummary.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.controls.every(control => control.left >= 0 && control.right <= layout.viewportWidth)).toBe(true);
  expect(new Set(layout.controls.map(control => Math.round(control.top))).size).toBe(1);
  expect(Math.abs(layout.barActions.right - Math.max(...layout.controls.map(control => control.right)))).toBeLessThanOrEqual(1);

  const promptBox = page.getByRole('textbox', { name: 'Prompt' });
  await promptBox.fill(Array.from({ length: 10 }, (_, index) => `Growing line ${index + 1}`).join('\n'));
  await expect.poll(async () => (await promptBox.boundingBox())?.height ?? 0).toBeGreaterThan(100);
  const grown = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    };
    return { prompt: bounds('.agent-composer textarea'), send: bounds('.agent-composer .queue'), bar: bounds('.workspace-toolbar') };
  });
  // grow the prompt upward without moving send or the row beneath the tabs
  expect(grown.prompt.top).toBeLessThan(layout.prompt.top);
  expect(Math.abs(grown.prompt.bottom - layout.prompt.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(grown.send.bottom - layout.send.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(grown.bar.top - layout.bar.top)).toBeLessThanOrEqual(1);
});

// the dashboard the phone Workspace dropdown tests: the current Workspace, two Agents elsewhere that
// wait on the operator (a question, unread output), and an agentless directory Place with shells
const workspacesDashboard = {
  generation: 1,
  agents: [
    { id: 'agent-5', sessionId: 'socket:$5', home: '/worktrees/remote-agents', worktreeId: 'remote-agents', displayLabel: '📱 Remote Agents', title: 'Ready', attention: 'finished', queuedPromptCount: 0 },
    { id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', displayLabel: '🥔 Cora', title: 'Ready', attention: 'question', queuedPromptCount: 0 },
    { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', displayLabel: '🥔 Owen', title: 'Ready', attention: 'finished', unread: true, queuedPromptCount: 0 }
  ],
  places: [{ id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', pinned: true, consoleShells: 2 }],
  projects: []
};

test('a phone shows only the current Workspace, as a dropdown over a sheet of every Workspace', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let dashboard = workspacesDashboard;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');

  const tabs = page.locator('nav.tabs');
  // the row's one tab is the current Workspace, and it opens a sheet rather than switching
  const dropdown = tabs.getByRole('tab');
  await expect(dropdown).toHaveCount(1);
  await expect(dropdown).toHaveAccessibleName('📱 Remote Agents — Prompt done');
  await expect(dropdown).toHaveAttribute('aria-selected', 'true');
  await expect(dropdown).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(dropdown).toHaveAccessibleDescription('Other Workspaces: 1 need an answer, 1 unread');
  // the badge counts the Agents in other Workspaces waiting on the operator, red while any has a question
  const badge = dropdown.locator('.workspace-dropdown-badge');
  await expect(badge).toHaveText('2');
  await expect(badge).toHaveClass(/\bquestion\b/u);

  // one row that never scrolls sideways: server selector, Call, settings, the dropdown filling the rest, +
  const row = await tabs.evaluate(nav => {
    const box = (element: Element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, middle: Math.round(rect.top + rect.height / 2) }; };
    return { overflow: nav.scrollWidth - nav.clientWidth, width: nav.getBoundingClientRect().width, lead: box(nav.querySelector('.tab-row-lead')!), dropdown: box(nav.querySelector('.workspace-dropdown')!), plus: box(nav.querySelector('.launcher')!) };
  });
  expect(row.overflow).toBeLessThanOrEqual(0);
  expect(new Set([row.lead.middle, row.dropdown.middle, row.plus.middle]).size).toBe(1);
  expect(Math.abs(row.dropdown.left - row.lead.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(row.plus.left - row.dropdown.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(row.plus.right - row.width)).toBeLessThanOrEqual(1);

  // the sheet lists every Workspace with its Agent and shell counts and its state, then New Workspace…
  await dropdown.click();
  const sheet = page.getByRole('dialog', { name: 'Workspaces' });
  const entries = sheet.getByRole('button');
  await expect(entries).toHaveText([
    /📱 Remote Agents\s*1 Agent · 0 shells$/u,
    /🥔 Cora\s*1 Agent · 0 shells · Needs answer$/u,
    /🥔 Owen\s*1 Agent · 0 shells · Unread$/u,
    /Notes\s*0 Agents · 2 shells$/u,
    /New Workspace…\s*Launch, Terminal or Empty workspace$/u
  ]);
  await expect(entries.first()).toHaveAttribute('aria-current', 'true');
  // a sheet across the screen's bottom edge, once it has risen into place
  await expect.poll(async () => { const box = (await sheet.boundingBox())!; return [box.x, box.width, box.y + box.height].map(Math.round); }).toEqual([0, 390, 844]);

  // picking Cora switches to it, leaving only Owen's unread output elsewhere: a green badge
  await entries.filter({ hasText: 'Cora' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(dropdown).toContainText('🥔 Cora');
  await expect(badge).toHaveText('1');
  await expect(badge).not.toHaveClass(/\bquestion\b/u);
  // picking Owen reads its output, so only Cora's question waits elsewhere
  await dropdown.click();
  await entries.filter({ hasText: 'Owen' }).click();
  await expect(dropdown).toContainText('🥔 Owen');
  await expect(badge).toHaveText('1');
  await expect(badge).toHaveClass(/\bquestion\b/u);
  // once Cora's question is answered elsewhere, the next dashboard clears the badge
  dashboard = { ...workspacesDashboard, generation: 2, agents: workspacesDashboard.agents.map(agent => agent.id === 'agent-1' ? { ...agent, attention: 'finished' } : agent.id === 'agent-2' ? { ...agent, unread: false } : agent) };
  await expect(badge).toHaveCount(0, { timeout: 10_000 });

  // New Workspace… opens the + menu
  await dropdown.click();
  await entries.filter({ hasText: 'New Workspace…' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Agent launcher' })).toBeVisible();
  await page.keyboard.press('Escape');

  // a desktop keeps the full tab row
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  await expect(tabs.locator('.workspace-dropdown')).toHaveCount(0);
});
