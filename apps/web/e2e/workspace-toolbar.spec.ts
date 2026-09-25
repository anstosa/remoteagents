import { expect, test, type Page } from '@playwright/test';

// The Workspace toolbar beneath the tab row: one component for tabs with and without an Agent,
// holding Launch, the panel buttons, git (or a path), stack and the ⋮ of Place actions.
const claude = { launchable: true, program: '/bin/claude', stateSource: 'both', turnCapture: true, inlineQuestions: false, commands: true, sandbox: false };
const cora = 'repo:/repo/wts/cora';
const idle = 'repo:/repo/wts/idle';
const dashboard = {
  generation: 1,
  adapters: { claude },
  cleanupPending: 2,
  agents: [
    { id: 'agent-1', sessionId: 'socket:$1', home: '/repo/wts/cora', kind: 'claude', worktreeId: cora, placeId: cora, projectId: 'repo', branch: 'feature/workspace-toolbar', gitStatus: { files: 3, staged: 1, unstaged: 2, untracked: 0, conflicted: 0 }, title: 'Ready', projectUrl: 'https://project.example.com', stack: { actions: ['start', 'build'], running: true, tunnel: true }, newTaskConfigured: true, queuedPromptCount: 0 },
    { id: 'agent-2', sessionId: 'socket:$2', home: '/home/me/scratch', kind: 'claude', placeId: 'scratch:/home/me/scratch', displayLabel: '~ Scratch', title: 'Ready', queuedPromptCount: 0 }
  ],
  projects: [
    { id: 'repo', label: 'Repo', available: true, manageWorktrees: true, launch: { kind: 'claude', origin: 'project' }, worktrees: [
      { id: cora, projectId: 'repo', label: 'Cora', path: '/repo/wts/cora', main: false, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'feature/workspace-toolbar', launch: { kind: 'claude', origin: 'project' } },
      { id: idle, projectId: 'repo', label: 'Idle', path: '/repo/wts/idle', main: false, detached: false, locked: false, available: true, pinned: true, order: 1, branch: 'idle', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, launch: { kind: 'claude', origin: 'project' } }
    ] },
    { id: 'notes', label: 'Notes', mode: 'directory', available: true, manageWorktrees: false, worktrees: [], launch: { kind: 'claude', origin: 'project' } }
  ],
  places: [
    { id: 'notes:/home/me/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/home/me/notes', pinned: true },
    { id: 'scratch:/home/me/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/home/me/scratch', pinned: false }
  ],
  scratchLaunch: { kind: 'claude', origin: 'default' }
};

async function mount(page: Page) {
  const launches: string[] = [];
  const pins: unknown[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (path === '/api/dashboard') return route.fulfill({ json: dashboard });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === `/api/worktrees/${cora}/panes`) return route.fulfill({ json: { panes: [{ paneId: '%9', session: '$9', window: '@9', role: 'shell', command: 'zsh', path: '/repo/wts/cora', title: 'zsh', agent: false }] } });
    if (path.endsWith('/panes')) return route.fulfill({ json: { panes: [] } });
    if (path === `/api/worktrees/${cora}/notes`) return route.fulfill({ json: { notes: [{ id: 'note-1', title: 'Plan', text: 'The plan' }] } });
    if (path.endsWith('/notes')) return route.fulfill({ json: { notes: [] } });
    if (path === `/api/worktrees/${idle}/github-actions`) return route.fulfill({ json: { url: 'https://github.com/octo/repo/actions' } });
    if (path === '/api/agents/agent-1/new-task') return route.fulfill({ json: { enabled: true } });
    if (path.endsWith('/pin') && request.method() === 'POST') { pins.push({ path, body: request.postDataJSON() }); return route.fulfill({ status: 204, body: '' }); }
    if ((path.endsWith('/launch') || path === '/api/agents') && request.method() === 'POST') { launches.push(path); return route.fulfill({ status: 409, json: { error: 'not in this test' } }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  return { launches: () => launches, pins: () => pins };
}

const toolbar = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' });
// the toolbar's controls left to right, by accessible name
const controlNames = (page: Page) => toolbar(page).locator('.workspace-toolbar-actions > *').evaluateAll(elements => elements.flatMap(element => {
  const controls = element.matches('button, a') ? [element] : [...element.querySelectorAll('button, a')];
  return controls.filter(control => !control.closest('[aria-hidden="true"]')).map(control => control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '');
}));

test('renders the same toolbar for a Worktree with and without an Agent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const harness = await mount(page);

  // with an Agent, Launch is the plain split: the kind mark and the verb
  await page.getByRole('tab', { name: /^Cora/u }).click();
  await expect(toolbar(page).locator('.launch-split.quiet .launch-primary')).toHaveText(/^\W*Launch$/u);
  expect(await controlNames(page)).toEqual(['Launch Claude', 'Choose agent', 'Open a terminal', 'Notes (1)', 'Browser', 'Code', 'Review 2 cleanup targets', 'Git status: feature/workspace-toolbar; 3 changes (1 staged file, 2 unstaged files)', 'Stack controls: healthy', 'More options']);

  // with none, Launch is the labelled primary, and the Conversations button stands in for the
  // agent panel that would carry it; the rest is unchanged
  await page.getByRole('tab', { name: /^Idle/u }).click();
  await expect(toolbar(page).locator('.launch-split:not(.quiet) .launch-primary')).toHaveText(/^\W*Launch Claude$/u);
  const idleNames = await controlNames(page);
  expect(idleNames.filter(name => !name.startsWith('Conversations'))).toEqual(['Launch Claude', 'Choose agent', 'Open a terminal', 'Notes (0)', 'Browser', 'Code', 'Review 2 cleanup targets', 'Git status: idle; clean', 'More options']);
  // the agentless view's own power and pin controls are gone
  await expect(page.getByRole('button', { name: 'Worktree power options' })).toHaveCount(0);
  await expect(page.locator('.place-pin')).toHaveCount(0);

  // a second Agent in a busy Worktree waits for the Agent switcher: its Launch says why
  await page.getByRole('tab', { name: /^Cora/u }).click();
  const busyLaunch = toolbar(page).getByRole('button', { name: 'Launch Claude' });
  await expect(busyLaunch).toBeDisabled();
  await expect(busyLaunch).toHaveAttribute('title', 'An agent already runs in this worktree');
  // an idle Worktree's Launch starts its Agent
  await page.getByRole('tab', { name: /^Idle/u }).click();
  await toolbar(page).getByRole('button', { name: 'Launch Claude' }).click();
  await expect.poll(harness.launches).toEqual([`/api/worktrees/${idle}/launch`]);
});

test('the ⋮ holds the Place actions, and Remove waits until no Agent runs', async ({ page }) => {
  const harness = await mount(page);
  const menu = page.locator('.place-menu');

  await page.getByRole('tab', { name: /^Idle/u }).click();
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await expect(menu.locator(':scope > button, :scope > a, :scope > div > button')).toHaveText(['Unpin worktree', 'Rename worktree…', 'GitHub Actions', 'New Task', 'Remove worktree…']);
  // GitHub Actions is looked up by Worktree, so it works with no Agent running
  await expect(menu.getByRole('link', { name: 'GitHub Actions' })).toHaveAttribute('href', 'https://github.com/octo/repo/actions');
  await expect(menu.getByRole('button', { name: 'New Task' })).toBeDisabled();
  await expect(menu.locator('.more-menu-reason')).toHaveText('Launch an agent to start a new task.');
  await expect(menu.getByRole('button', { name: 'Remove worktree…' })).toBeEnabled();
  await menu.getByRole('button', { name: 'Unpin worktree' }).click();
  await expect.poll(harness.pins).toEqual([{ path: `/api/worktrees/${idle}/pin`, body: { pinned: false } }]);

  await page.getByRole('tab', { name: /^Cora/u }).click();
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  const remove = menu.getByRole('button', { name: 'Remove worktree…' });
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAttribute('title', 'Turn off the open agent before removing this worktree');
});

test('a Place without git shows its path instead of Code, git and stack', async ({ page }) => {
  const harness = await mount(page);
  // Scratch has an Agent running, Notes has none: both show their own path and the same controls
  for (const [tab, path] of [[/^Notes/u, '/home/me/notes'], [/Scratch/u, '/home/me/scratch']] as const) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(toolbar(page).locator('.toolbar-path')).toHaveText(path);
    await expect(toolbar(page).getByRole('button', { name: 'Code' })).toHaveCount(0);
    await expect(toolbar(page).locator('.git-status-summary')).toHaveCount(0);
    await expect(toolbar(page).locator('.project-stack-trigger')).toHaveCount(0);
    // the panel buttons stay; with no project URL the Browser has nothing to open
    await expect(toolbar(page).getByRole('button', { name: 'Open a terminal' })).toBeVisible();
    await expect(toolbar(page).getByRole('button', { name: 'Browser' })).toBeDisabled();
    await expect(toolbar(page).getByRole('button', { name: /^Launch/u }).first()).toBeEnabled();
    // the ⋮ holds only the pin: GitHub Actions and New Task need a git checkout
    await toolbar(page).getByRole('button', { name: 'More options' }).click();
    await expect(page.locator('.place-menu').getByRole('button')).toHaveText([/^(Pin|Unpin) folder$/u]);
    await page.keyboard.press('Escape');
  }
  // Launch on the Scratch Agent tab starts another Agent there
  await toolbar(page).getByRole('button', { name: /^Launch/u }).first().click();
  await expect.poll(harness.launches).toHaveLength(1);
});

test('panel buttons tint while their panel is open', async ({ page }) => {
  await mount(page);
  await page.getByRole('tab', { name: /^Cora/u }).click();
  // Terminal: open the listed shell from its menu
  const terminal = toolbar(page).getByRole('button', { name: 'Open a terminal' });
  await expect(terminal).not.toHaveClass(/\bpanel-open\b/u);
  await terminal.click();
  await page.getByRole('menu', { name: 'Open a terminal' }).locator('.terminal-picker-pane').first().click();
  await expect(terminal).toHaveClass(/\bpanel-open\b/u);
  // Notes: open the Place's note from its menu
  const notes = toolbar(page).getByRole('button', { name: 'Notes (1)' });
  await expect(notes).not.toHaveClass(/\bpanel-open\b/u);
  await notes.click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(notes).toHaveClass(/\bpanel-open\b/u);
  for (const name of ['Browser', 'Code']) {
    const button = toolbar(page).getByRole('button', { name, exact: true });
    await expect(button).not.toHaveClass(/\bpanel-open\b/u);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toHaveClass(/\bpanel-open\b/u);
  }
  await expect(page.locator('.browser-pane')).toBeVisible();
  await expect(page.locator('.code-pane')).toBeVisible();
  await toolbar(page).getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page.locator('.code-pane')).toHaveCount(0);
});

test('the toolbar fits a 1440px desktop on one row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(page);
  for (const tab of [/^Cora/u, /^Idle/u]) {
    await page.getByRole('tab', { name: tab }).click();
    const boxes = await toolbar(page).locator('.workspace-toolbar-actions > :not(.toolbar-spacer)').evaluateAll(elements => elements.map(element => element.getBoundingClientRect()).filter(box => box.width > 0).map(box => ({ top: box.top, left: box.left, right: box.right })));
    expect(new Set(boxes.map(box => Math.round(box.top))).size).toBe(1);
    expect(Math.min(...boxes.map(box => box.left))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...boxes.map(box => box.right))).toBeLessThanOrEqual(1440);
    // nothing is squeezed out of view: the row does not overflow and every label shows
    const row = toolbar(page).locator('.workspace-toolbar-actions');
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const label of await toolbar(page).locator('.toolbar-label').all()) await expect(label).toBeVisible();
    expect((await toolbar(page).locator('.git-status-summary').boundingBox())!.width).toBeGreaterThan(120);
  }
});
