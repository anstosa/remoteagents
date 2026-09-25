import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';

// The phone Workspace: its panels sit in a horizontal swipe carousel, one panel per screen. The
// toolbar's dots track the panel in view and jump to one when tapped; a panel opened from the
// toolbar scrolls into view; Browser and Code move into the ⋮; and a panel's expand hides the tab
// row and toolbar until it is restored.

test.use({ viewport: { width: 428, height: 880 }, hasTouch: true, isMobile: true });

const panes = [
  { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
  { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false }
];

const routeApi = (page: Page) => page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
  if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/phone', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/app.ts', additions: 1, deletions: 1 }] }, title: 'Ready', projectUrl: 'https://project.example.com', stack: { running: true, tunnel: true }, queuedPromptCount: 0 }], projects: [] } });
  if (path === '/api/push/public-key') return route.fulfill({ json: {} });
  if (path === '/api/agents/agent-1/tickets' || path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
  if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
  if (path === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
  if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [{ id: 'note-cora-000001', text: 'Phone checklist' }] } });
  if (path === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes } });
  if (path === '/api/worktrees/cora/comparison') return route.fulfill({ json: { kind: 'working', base: 'HEAD', gitBase: 'HEAD', files: [], fingerprint: '', truncated: false } });
  return route.fulfill({ status: 404, json: { error: 'not mocked' } });
});

const toolbar = (page: Page) => page.getByRole('region', { name: 'Workspace toolbar' });
const dots = (page: Page) => toolbar(page).getByRole('group', { name: 'Panels' });
const carousel = (page: Page) => page.locator('.log-split');
const agentPanel = (page: Page) => page.locator('.log-output');
const terminalPanel = (page: Page) => page.locator('.terminal-pane[data-panel-key="%5"]');

// the carousel sits on a panel boundary: one panel fills the screen
const expectSnapped = (page: Page) => expect.poll(() => carousel(page).evaluate(element => element.scrollLeft % element.clientWidth)).toBe(0);
// the panel whose dot is current
const expectCurrentDot = (page: Page, name: string) => expect(dots(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'true');

// a one-finger swipe across the middle of `over`, `distance` pixels (positive moves the finger
// right). A quick swipe flings; a `slow` one drags and stops before lifting, so it carries no
// velocity and the carousel snaps to the nearest panel.
const swipe = async (page: Page, over: Locator, distance: number, slow = false) => {
  const box = (await over.boundingBox())!;
  const x = Math.round(box.x + box.width / 2 - distance / 2);
  const y = Math.round(box.y + box.height / 2);
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 12; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + Math.round(distance * step / 12), y }] });
    if (slow) await page.waitForTimeout(30);
  }
  if (slow) await page.waitForTimeout(300);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
};

const openTerminal = async (page: Page) => {
  await toolbar(page).getByRole('button', { name: 'Open a terminal' }).click();
  await page.getByRole('menuitem', { name: /build/u }).click();
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');
};

test.beforeEach(async ({ page }) => {
  await installPaneMock(page);
  await page.route('https://project.example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Phone preview</main>' }));
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
});

test('swiping moves between panels one screen at a time, and the dots follow', async ({ page }) => {
  // one panel: no dots
  await expect(agentPanel(page)).toBeInViewport();
  await expect(dots(page)).toHaveCount(0);

  // a newly opened Terminal scrolls into view, and each open panel gets a dot
  await openTerminal(page);
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expect(agentPanel(page)).not.toBeInViewport();
  await expect(dots(page).getByRole('button')).toHaveCount(2);
  await expectCurrentDot(page, 'Show terminal build');

  // a swipe over the Terminal back to the agent panel snaps to it, and its dot becomes current
  await swipe(page, terminalPanel(page).locator('.terminal-canvas'), 300);
  await expectSnapped(page);
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expect(terminalPanel(page)).not.toBeInViewport();
  await expectCurrentDot(page, 'Show agent output');

  // a drag short of half a screen snaps back to the panel it started on
  await swipe(page, agentPanel(page).locator('.log-canvas'), -120, true);
  await expectSnapped(page);
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show agent output');

  // a swipe over the agent's output moves on to the Terminal
  await swipe(page, agentPanel(page).locator('.log-canvas'), -300);
  await expectSnapped(page);
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show terminal build');

  // tapping a dot jumps to its panel
  await dots(page).getByRole('button', { name: 'Show agent output' }).click();
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expectSnapped(page);
  await expectCurrentDot(page, 'Show agent output');

  // with the dots in it the phone toolbar keeps to one row: git shrinks to its icon and state dot
  const tops = await toolbar(page).locator('.workspace-toolbar-actions > *').evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expect(toolbar(page).locator('.git-branch')).toBeHidden();
  await expect(toolbar(page).locator('.git-status-dot')).toBeVisible();
  // its changed-files popup still spans the screen, though the button sits at the row's right
  await toolbar(page).getByRole('button', { name: /^Git status/u }).click();
  const changes = page.getByRole('region', { name: 'Changed files' });
  await expect.poll(() => changes.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(400);
  await page.mouse.click(4, 4);
  await expect(changes).toHaveCount(0);
});

test('with only the agent panel, and so no dots, the phone toolbar still keeps to one row', async ({ page }) => {
  await expect(agentPanel(page)).toBeInViewport();
  await expect(dots(page)).toHaveCount(0);
  const actions = toolbar(page).locator('.workspace-toolbar-actions');
  const middles = await actions.locator('> *').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return Math.round(box.top + box.height / 2); }));
  expect(new Set(middles).size).toBe(1);
  expect(await actions.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(toolbar(page).locator('.git-branch')).toBeHidden();
  await expect(toolbar(page).locator('.git-status-dot')).toBeVisible();
});

test('tapping a Terminal that has not rendered yet keeps it in view', async ({ page }) => {
  // a Terminal still connecting: its pane has sent no size or bytes, so nothing has rendered
  await toolbar(page).getByRole('button', { name: 'Open a terminal' }).click();
  await page.getByRole('menuitem', { name: /build/u }).click();
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show terminal build');

  // a tap focuses the terminal's input, and Firefox scrolls a focused element into view
  const box = (await terminalPanel(page).locator('.terminal-canvas').boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(terminalPanel(page).locator('.xterm-helper-textarea')).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  await expectSnapped(page);
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show terminal build');
});

test('Browser and Code move into the ⋮, and a panel opened from the toolbar scrolls into view', async ({ page }) => {
  // the phone toolbar keeps Launch, Terminal and Notes; Browser and Code are in the ⋮
  await expect(toolbar(page).getByRole('button', { name: 'Open a terminal' })).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: 'Browser', exact: true })).toBeHidden();
  await expect(toolbar(page).getByRole('button', { name: 'Code', exact: true })).toBeHidden();

  // a note picked from the toolbar scrolls into view
  await toolbar(page).getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  const note = page.getByRole('dialog', { name: 'Note' });
  await expect(note).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show note');

  // so does the browser, from the ⋮
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browser' });
  await expect(browser).toBeInViewport({ ratio: 0.99 });
  await expect(note).not.toBeInViewport();
  await expectCurrentDot(page, 'Show project browser');

  // and the Code panel
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  const code = page.getByRole('region', { name: 'Code changes' });
  await expect(code).toBeInViewport({ ratio: 0.99 });
  await expectCurrentDot(page, 'Show code changes');

  // choosing an open panel from the ⋮ shows it rather than closing it
  await dots(page).getByRole('button', { name: 'Show agent output' }).click();
  await expect(agentPanel(page)).toBeInViewport({ ratio: 0.99 });
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(browser).toBeInViewport({ ratio: 0.99 });
  await expect(dots(page).getByRole('button')).toHaveCount(4);
});

test('expand hides the tab row and toolbar for every panel kind, and restore brings them back', async ({ page }) => {
  await openTerminal(page);
  // with the Terminal in view the toolbar is its helper keys (and the dots); back to the agent
  await dots(page).getByRole('button', { name: 'Show agent output' }).click();
  await toolbar(page).getByRole('button', { name: 'Notes (1)' }).click();
  await page.getByRole('button', { name: 'Phone checklist…', exact: true }).click();
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await toolbar(page).getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();

  const tabs = page.getByRole('tablist', { name: 'Agents and worktrees' });
  const panels: [dot: string, panel: Locator, label: string][] = [
    ['Show agent output', agentPanel(page), 'agent'],
    ['Show terminal build', terminalPanel(page), 'terminal build'],
    ['Show note', page.getByRole('dialog', { name: 'Note' }), 'note'],
    ['Show project browser', page.getByRole('dialog', { name: 'Browser' }), 'browser'],
    ['Show code changes', page.getByRole('region', { name: 'Code changes' }), 'code']
  ];
  for (const [dot, panel, label] of panels) {
    await dots(page).getByRole('button', { name: dot }).click();
    await expect(panel).toBeInViewport({ ratio: 0.99 });
    const bottom = await panel.evaluate(element => element.getBoundingClientRect().bottom);
    await panel.getByRole('button', { name: `Expand ${label}` }).click();
    await expect(tabs).toBeHidden();
    if (label.startsWith('terminal')) {
      // a full-screen Terminal keeps its helper keys, and only them
      await expect(page.getByRole('button', { name: 'Esc' })).toBeVisible();
      await expect(toolbar(page).getByRole('button', { name: 'Open a terminal' })).toBeHidden();
      await expect(dots(page)).toBeHidden();
    } else await expect(toolbar(page)).toBeHidden();
    // the panel grows into the freed space
    await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().bottom)).toBeGreaterThan(bottom + 40);
    await panel.getByRole('button', { name: `Restore ${label}` }).click();
    await expect(tabs).toBeVisible();
    await expect(toolbar(page)).toBeVisible();
  }

  // moving to another panel while expanded stays full screen, and the panel in view offers the restore
  await dots(page).getByRole('button', { name: 'Show note' }).click();
  await page.getByRole('dialog', { name: 'Note' }).getByRole('button', { name: 'Expand note' }).click();
  await carousel(page).evaluate(element => element.scrollTo({ left: element.clientWidth }));
  await expect(terminalPanel(page)).toBeInViewport({ ratio: 0.99 });
  await expect(tabs).toBeHidden();
  await terminalPanel(page).getByRole('button', { name: 'Restore terminal build' }).click();
  await expect(tabs).toBeVisible();

  // closing the full-screen panel ends full screen
  await terminalPanel(page).getByRole('button', { name: 'Expand terminal build' }).click();
  await expect(tabs).toBeHidden();
  await terminalPanel(page).getByRole('button', { name: 'Minimize terminal build' }).click();
  await expect(terminalPanel(page)).toHaveCount(0);
  await expect(tabs).toBeVisible();
  await expect(toolbar(page)).toBeVisible();
});
