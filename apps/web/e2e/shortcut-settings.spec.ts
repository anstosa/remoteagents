import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, paneInputText, pushBytes, seedPaneSize } from './pane-stream-mock.js';

type Pane = { paneId: string; session: string; window?: string; role?: string; name?: string; command: string; path: string; title: string; agent: boolean; busy?: boolean };
type FixtureState = {
  shells: unknown[];
  prompts: unknown[];
  pageErrors: string[];
  consoleErrors: string[];
};

const appUrl = process.env.SHORTCUT_TEST_URL ?? 'http://127.0.0.1:4173/';

// keep the shortcut surface attached to one Agent and one focused Terminal
const panes = (): Pane[] => [
  { paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/worktrees/cora', title: '', agent: true },
  { paneId: '%5', session: '$1', window: '@1', role: 'shell', name: 'build', command: 'zsh', path: '/worktrees/cora', title: '', agent: false, busy: false }
];

// provide a synthetic authenticated dashboard and capture shortcut side effects
const routeApi = async (page: Page, state: FixtureState, keys?: unknown) => {
  // keep the synthetic Terminal tab icon from becoming static-server console noise
  await page.route('**/instance-icons/terminal.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="m3 4 3 4-3 4m5 0h5"/></svg>' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    // establish one controlling browser with Settings authority
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'shortcut-settings-csrf', active: true, deviceName: 'Test browser', server: { name: 'Test server', url: appUrl, remotes: [] } } });
    // expose one Agent and any operator-defined shortcut tables
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Working', attention: 'working', queuedPromptCount: 0 }], projects: [], ...(keys === undefined ? {} : { keys }) } });
    // authorize the inert dashboard socket
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // avoid unrelated update indicators
    if (path === '/api/push/public-key' || path === '/api/agents/updates') return route.fulfill({ json: {} });
    // authorize both Agent and Terminal pane streams
    if (path === '/api/agents/agent-1/tickets' || path === '/api/worktrees/cora/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    // keep composer discovery and polling empty
    if (path === '/api/agents/agent-1/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/agents/agent-1/saved-prompts' || path === '/api/agents/agent-1/prompt-history' || path === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    // capture a submission if an old newline chord accidentally submits
    if (path === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      state.prompts.push(request.postDataJSON());
      return route.fulfill({ status: 202, json: {} });
    }
    // keep the Place's notes empty
    if (path === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // expose the shared Agent and Terminal panes
    if (path === '/api/worktrees/cora/panes' && request.method() === 'GET') return route.fulfill({ json: { panes: panes() } });
    // retain the original terminal binding identity sent by the browser
    if (path === '/api/worktrees/cora/shells' && request.method() === 'POST') {
      state.shells.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { paneId: '%5' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// open one fully rendered dashboard at the requested platform and viewport
const openDashboard = async (page: Page, options: { keys?: unknown; platform?: string; width?: number; height?: number } = {}) => {
  const state: FixtureState = { shells: [], prompts: [], pageErrors: [], consoleErrors: [] };
  // collect uncaught failures from the rendered application
  page.on('pageerror', error => state.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') state.consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: options.width ?? 1400, height: options.height ?? 900 });
  await installPaneMock(page);
  // report the requested desktop platform before application modules read navigator.platform
  if (options.platform !== undefined) await page.addInitScript(platform => { Object.defineProperty(navigator, 'platform', { configurable: true, value: platform }); }, options.platform);
  // retain one named Terminal panel across application startup
  await page.addInitScript(() => localStorage.setItem('rac.terminals:cora', JSON.stringify([{ paneId: '%5', name: 'build' }])));
  await routeApi(page, state, options.keys);
  await page.goto(appUrl);
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, '%5', 80, 24);
  await pushBytes(page, '%5', '$ \r\n');
  const terminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await terminal.locator('.xterm-screen').click();
  await expect(terminal).toHaveClass(/focused/u);
  return { state, terminal };
};

// open the global Settings panel through its persistent navigation control
const openSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Global settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  return settings;
};

// address one command and one physical assignment in the popup
const shortcutCommand = (page: Page, identity: string) => page.locator(`[data-shortcut-command="${identity}"]`);
const shortcutAssignment = (page: Page, identity: string, chord?: string) => page.locator(`[data-shortcut-id="${identity}"]${chord === undefined ? '' : `[data-shortcut-chord="${chord}"]`}`);
const shortcutAssignmentInTable = (page: Page, identity: string, table: string, chord: string) => page.locator(`[data-shortcut-id="${identity}"][data-shortcut-table="${table}"][data-shortcut-chord="${chord}"]`);

// open the quick reference from the compact Settings entry
const openShortcutReference = async (page: Page, settings: Locator) => {
  await settings.getByRole('group', { name: 'Keyboard shortcuts' }).getByRole('button', { name: 'View/Edit Shortcuts' }).click();
  const reference = page.getByRole('dialog', { name: 'Key bindings' });
  await expect(reference).toBeVisible();
  return reference;
};

// enter editing without replacing the mounted reference dialog
const editShortcuts = async (reference: Locator) => {
  const toggle = reference.getByRole('button', { name: 'Edit shortcuts' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  const done = reference.getByRole('button', { name: 'Done editing' });
  await expect(done).toHaveAttribute('aria-pressed', 'true');
  await expect(reference.getByRole('region', { name: 'Edit keyboard shortcuts' })).toBeVisible();
  return done;
};

// record and save one replacement chord without depending on the visible key label
const changeShortcut = async (page: Page, identity: string, description: string, chord: string, currentChord?: string) => {
  const assignment = shortcutAssignment(page, identity, currentChord);
  await assignment.locator('.shortcut-change').click();
  const row = assignment.locator('xpath=ancestor::*[@data-shortcut-command][1]');
  const recorder = row.getByRole('textbox', { name: `New shortcut for ${description}` });
  // every existing binding exposes its dispatch context while it is edited
  await expect(row.getByRole('switch', { name: `Use prefix for ${description}` })).toBeVisible();
  await recorder.press(chord);
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(recorder).toHaveCount(0);
  return row;
};

// read the current outlined key sequence for one editor row
const expectShortcutLabel = async (page: Page, identity: string, label: string) => {
  await expect(shortcutAssignment(page, identity).locator('.shortcut-keys')).toHaveAttribute('aria-label', label);
};

// compare one rendered color with the active theme token
const expectThemeColor = async (element: Locator, token: '--green' | '--mauve') => {
  const colors = await element.evaluate((node, variable) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${variable})`;
    node.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(node).color, expected };
  }, token);
  expect(colors.actual).toBe(colors.expected);
};

// ignore only resource noise produced by intentionally unimplemented fixture APIs
const unexpectedConsoleErrors = (state: FixtureState) => state.consoleErrors.filter(message => message !== 'Failed to load resource: the server responded with a status of 404 (Not Found)');

test.describe.configure({ timeout: 180_000 });

test('keeps Settings compact while the reference owns a trapped read and edit mode', async ({ page }) => {
  const { state } = await openDashboard(page, { platform: 'Linux x86_64' });
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  await expect(toolbar.getByRole('button', { name: 'Key bindings', exact: true })).toHaveCount(0);
  const settings = await openSettings(page);
  const keyboardSetting = settings.getByRole('group', { name: 'Keyboard shortcuts' });
  const entry = keyboardSetting.getByRole('button', { name: 'View/Edit Shortcuts' });
  await expect(keyboardSetting.getByText('KEYBOARD SHORTCUTS', { exact: true })).toBeVisible();
  await expect(keyboardSetting.getByRole('heading')).toHaveCount(0);
  await expect(entry).toBeVisible();
  await expect(keyboardSetting.getByText('Customize keyboard shortcuts for this browser.', { exact: true })).toBeVisible();
  await expect(keyboardSetting.locator(':scope > *')).toHaveCount(2);
  await expect(keyboardSetting.getByRole('searchbox')).toHaveCount(0);
  await expect(keyboardSetting.locator('[data-shortcut-id]')).toHaveCount(0);

  // match neighboring row typography and keep the action on the eyebrow line
  const compactMetrics = await settings.evaluate(element => {
    const keyboard = element.querySelector<HTMLElement>('.client-settings-keyboard')!;
    const neighbor = element.querySelector<HTMLElement>('.client-settings-reduced-motion')!;
    const header = keyboard.querySelector<HTMLElement>('header')!;
    const eyebrow = keyboard.querySelector<HTMLElement>('small')!;
    const button = keyboard.querySelector<HTMLElement>('button')!;
    const description = keyboard.querySelector<HTMLElement>(':scope > span')!;
    const neighborDescription = neighbor.querySelector<HTMLElement>(':scope > span')!;
    return {
      descriptionFont: getComputedStyle(description).fontSize,
      neighborFont: getComputedStyle(neighborDescription).fontSize,
      headerRight: header.getBoundingClientRect().right,
      eyebrowRight: eyebrow.getBoundingClientRect().right,
      buttonLeft: button.getBoundingClientRect().left,
      buttonRight: button.getBoundingClientRect().right
    };
  });
  expect(compactMetrics.descriptionFont).toBe(compactMetrics.neighborFont);
  expect(Number.parseFloat(compactMetrics.descriptionFont)).toBeCloseTo(10.24, 1);
  expect(compactMetrics.buttonLeft).toBeGreaterThan(compactMetrics.eyebrowRight);
  expect(compactMetrics.headerRight - compactMetrics.buttonRight).toBeLessThan(1);
  for (const [groupName, eyebrow] of [['Reduced motion setting', 'REDUCED MOTION'], ['Flyout markers setting', 'FLYOUT MARKERS'], ['Dynamic worktrees setting', 'DYNAMIC WORKTREES']] as const) {
    const row = settings.getByRole('group', { name: groupName });
    await expect(row.getByText(eyebrow, { exact: true })).toBeVisible();
    await expect(row.locator(':scope > strong')).toHaveCount(0);
  }
  await page.screenshot({ path: '/tmp/remoteagents-shortcut-v2-settings-desktop.png', fullPage: true });

  let reference = await openShortcutReference(page, settings);
  const close = reference.getByRole('button', { name: 'Close key bindings' });
  const closeColors = await close.evaluate(element => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--subtext-0)';
    element.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return {
      actual: getComputedStyle(element).color,
      background: getComputedStyle(element.closest('header')!).backgroundColor,
      expected
    };
  });
  expect(closeColors.actual).toBe(closeColors.expected);
  expect(closeColors.actual).not.toBe(closeColors.background);
  let mode = reference.getByRole('button', { name: 'Edit shortcuts' });
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect(reference.getByRole('region', { name: 'Edit keyboard shortcuts' })).toHaveCount(0);
  await expect(reference.getByRole('searchbox', { name: 'Find keyboard shortcuts' })).toHaveCount(0);
  await expect(reference.getByRole('button', { name: 'Reset all shortcuts' })).toHaveCount(0);
  await expect(settings).toBeVisible();
  const ctrlShift = reference.getByLabel('Ctrl + Shift + C');
  await expect(ctrlShift.locator('kbd')).toHaveText(['Ctrl', 'Shift', 'C']);
  await expect(ctrlShift.locator('.shortcut-key-separator')).toHaveText([' + ', ' + ']);
  await expect(ctrlShift).toHaveText('Ctrl + Shift + C');
  await expect(reference.getByLabel('Super + C').locator('kbd')).toHaveText(['Super', 'C']);
  // direct bindings do not expose the internal root table name
  await expect(reference.getByText('root', { exact: true })).toHaveCount(0);
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(mode).toBeFocused();
  await page.screenshot({ path: '/tmp/remoteagents-shortcut-v2-close-unfocused.png', fullPage: true });
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  // a modal must not launch a background workspace action
  await page.keyboard.press('Control+b');
  await page.keyboard.press('c');
  expect(state.shells).toEqual([]);
  const modalIndicator = page.locator('.key-indicator');
  await expect(modalIndicator).toHaveCount(0);
  await page.screenshot({ path: '/tmp/remoteagents-shortcut-v2-reference-desktop.png', fullPage: true });

  const done = await editShortcuts(reference);
  await expect(reference.getByRole('searchbox', { name: 'Find keyboard shortcuts' })).toBeVisible();
  await expect(reference.getByRole('button', { name: 'Reset all shortcuts' })).toBeVisible();
  const initialEditorRow = shortcutCommand(page, 'table:prefix');
  const initialReset = initialEditorRow.getByRole('button', { name: 'Reset', exact: true });
  await expect(initialEditorRow.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  await expect(initialReset).toBeDisabled();
  const editorMetrics = await initialEditorRow.evaluate(element => {
    const keys = element.querySelector<HTMLElement>('.shortcut-setting-keys')!;
    const description = element.querySelector<HTMLElement>('.shortcut-setting-description')!;
    const controls = element.querySelector<HTMLElement>('.shortcut-binding-controls')!;
    const change = element.querySelector<HTMLElement>('.shortcut-change')!;
    const reset = controls.querySelector<HTMLElement>('button:last-child')!;
    const icon = change.querySelector<SVGElement>('svg')!;
    return {
      keysLeft: keys.getBoundingClientRect().left,
      descriptionLeft: description.getBoundingClientRect().left,
      controlsLeft: controls.getBoundingClientRect().left,
      changeBackground: getComputedStyle(change).backgroundColor,
      changeBorder: getComputedStyle(change).borderStyle,
      resetBackground: getComputedStyle(reset).backgroundColor,
      iconWidth: icon.getBoundingClientRect().width
    };
  });
  expect(editorMetrics.keysLeft).toBeLessThan(editorMetrics.descriptionLeft);
  expect(editorMetrics.descriptionLeft).toBeLessThan(editorMetrics.controlsLeft);
  expect(editorMetrics.changeBackground).toBe('rgba(0, 0, 0, 0)');
  expect(editorMetrics.changeBorder).toBe('solid');
  expect(editorMetrics.resetBackground).toBe('rgba(0, 0, 0, 0)');
  expect(editorMetrics.iconWidth).toBeGreaterThan(0);
  await expect(reference.getByText('root', { exact: true })).toHaveCount(0);
  const prefixAssignment = shortcutAssignment(page, 'prefix:n', 'n');
  const assignmentOrder = await prefixAssignment.evaluate(element => {
    const change = element.querySelector<HTMLElement>('.shortcut-change')!;
    const remove = element.querySelector<HTMLElement>('.shortcut-remove')!;
    const controls = change.parentElement!;
    return {
      removeImmediatelyAfterChange: change.nextElementSibling === remove,
      controlsBeforeBinding: controls.nextElementSibling?.matches('.shortcut-table-label, .shortcut-keys') ?? false,
      removeText: remove.textContent?.trim() ?? '',
      removeIcons: remove.querySelectorAll('svg').length
    };
  });
  expect(assignmentOrder).toEqual({ removeImmediatelyAfterChange: true, controlsBeforeBinding: true, removeText: '', removeIcons: 1 });
  const enabledControls = reference.locator('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
  const first = enabledControls.first();
  const last = enabledControls.last();
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.screenshot({ path: '/tmp/remoteagents-shortcut-v2-editor-desktop.png', fullPage: true });
  await done.click();
  mode = reference.getByRole('button', { name: 'Edit shortcuts' });
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect(reference.getByRole('region', { name: 'Edit keyboard shortcuts' })).toHaveCount(0);
  await close.click();
  await expect(reference).toHaveCount(0);
  await expect(settings).toBeVisible();
  reference = await openShortcutReference(page, settings);
  await expect(reference.getByRole('button', { name: 'Edit shortcuts' })).toHaveAttribute('aria-pressed', 'false');
  await reference.getByRole('button', { name: 'Close key bindings' }).click();

  await page.setViewportSize({ width: 320, height: 640 });
  await keyboardSetting.scrollIntoViewIfNeeded();
  await expect(keyboardSetting).toBeInViewport();
  const horizontal = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(horizontal.document).toBeLessThanOrEqual(horizontal.viewport);
  expect(horizontal.body).toBeLessThanOrEqual(horizontal.viewport);
  await page.screenshot({ path: '/tmp/remoteagents-shortcut-v2-settings-mobile.png', fullPage: true });
  reference = await openShortcutReference(page, settings);
  await editShortcuts(reference);
  await expect(reference.getByRole('searchbox', { name: 'Find keyboard shortcuts' })).toBeInViewport();
  await reference.getByRole('searchbox', { name: 'Find keyboard shortcuts' }).press('Shift');
  const mobileIndicator = page.locator('.key-indicator');
  await expect(mobileIndicator).toHaveCount(0);
  const mobileHorizontal = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(mobileHorizontal.document).toBeLessThanOrEqual(mobileHorizontal.viewport);
  expect(mobileHorizontal.body).toBeLessThanOrEqual(mobileHorizontal.viewport);
  await page.screenshot({ path: '/tmp/remoteagents-shortcut-v2-editor-mobile.png', fullPage: true });
  expect(state.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(state)).toEqual([]);
});

test('uses familiar platform names while keeping every modifier in a separate key outline', async ({ browser }) => {
  const platforms = [['Win32', 'Win'], ['MacIntel', 'Cmd'], ['Linux x86_64', 'Super']] as const;
  // exercise a fresh module load for each platform label
  for (const [platform, label] of platforms) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { state } = await openDashboard(page, { platform });
    await page.keyboard.press('Control+?');
    const reference = page.getByRole('dialog', { name: 'Key bindings' });
    const platformChord = reference.getByLabel(`${label} + C`);
    await expect(platformChord.locator('kbd')).toHaveText([label, 'C']);
    await expect(platformChord.locator('.shortcut-key-separator')).toHaveText(' + ');
    const shiftedChord = reference.getByLabel('Ctrl + Shift + C');
    await expect(shiftedChord.locator('kbd')).toHaveText(['Ctrl', 'Shift', 'C']);
    await expect(shiftedChord.locator('.shortcut-key-separator')).toHaveText([' + ', ' + ']);
    expect(state.pageErrors).toEqual([]);
    expect(unexpectedConsoleErrors(state)).toEqual([]);
    await context.close();
  }
});

test('adds, persists, removes, disables, and resets multiple shortcuts for one command', async ({ page }) => {
  const { state, terminal } = await openDashboard(page);
  let settings = await openSettings(page);
  let reference = await openShortcutReference(page, settings);
  await editShortcuts(reference);
  let leader = shortcutCommand(page, 'table:prefix');
  const description = 'Switch to the prefix table';

  // prove Escape cancels capture without closing the modal or running the binding
  await shortcutAssignment(page, 'root:C-b', 'C-b').locator('.shortcut-change').click();
  let recorder = leader.getByRole('textbox', { name: `New shortcut for ${description}` });
  await expect(recorder).toBeFocused();
  await recorder.press('Control+a');
  await expect(recorder).toHaveValue('Ctrl + A');
  await expect(page.locator('.key-indicator')).toHaveCount(0);
  await recorder.press('Escape');
  await expect(reference).toBeVisible();
  await expect(reference.getByRole('button', { name: 'Done editing' })).toHaveAttribute('aria-pressed', 'true');
  await expect(shortcutAssignment(page, 'root:C-b', 'C-b').locator('.shortcut-change')).toBeFocused();

  // add an alias without replacing the command's existing assignment
  await leader.getByRole('button', { name: `Add shortcut for ${description}` }).click();
  recorder = leader.getByRole('textbox', { name: `New shortcut for ${description}` });
  await recorder.press('Control+a');
  await leader.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(shortcutAssignment(page, 'root:C-b', 'C-b')).toHaveCount(1);
  await expect(shortcutAssignment(page, 'root:C-b', 'C-a')).toHaveCount(1);
  await expect(leader.locator('.shortcut-keys')).toHaveCount(2);
  await reference.getByRole('button', { name: 'Close key bindings' }).click();
  await settings.getByRole('button', { name: 'Close settings' }).click();

  // either physical key now runs the same command
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('1');
  await expect(prompt).toBeFocused();
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('1');
  await expect(prompt).toBeFocused();

  // reload to prove the whole assignment list is browser-persistent
  await page.reload();
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, '%5', 80, 24);
  const reloadedTerminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await reloadedTerminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('1');
  await expect(prompt).toBeFocused();
  settings = await openSettings(page);
  reference = await openShortcutReference(page, settings);
  await editShortcuts(reference);
  leader = shortcutCommand(page, 'table:prefix');
  await expect(shortcutAssignment(page, 'root:C-b', 'C-b')).toHaveCount(1);
  await expect(shortcutAssignment(page, 'root:C-b', 'C-a')).toHaveCount(1);

  // remove one alias while retaining and dispatching the other
  await shortcutAssignment(page, 'root:C-b', 'C-a').getByRole('button', { name: `Remove shortcut Ctrl + A for ${description}` }).click();
  await expect(shortcutAssignment(page, 'root:C-b', 'C-a')).toHaveCount(0);
  await expect(shortcutAssignment(page, 'root:C-b', 'C-b')).toHaveCount(1);
  await reference.getByRole('button', { name: 'Close key bindings' }).click();
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await reloadedTerminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('1');
  await expect(reloadedTerminal).toHaveClass(/focused/u);
  await page.keyboard.press('Control+b');
  await page.keyboard.press('1');
  await expect(prompt).toBeFocused();

  // disabling applies to the whole command and removes every editing affordance
  settings = await openSettings(page);
  reference = await openShortcutReference(page, settings);
  await editShortcuts(reference);
  leader = shortcutCommand(page, 'table:prefix');
  await leader.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(leader).toHaveAccessibleName(`${description} (disabled)`);
  await expect(leader.locator('.shortcut-keys')).toHaveCount(0);
  await expect(leader.locator('.shortcut-change')).toHaveCount(0);
  await expect(leader.getByRole('button', { name: `Add shortcut for ${description}` })).toHaveCount(0);
  await expect(leader.locator('.shortcut-setting-description s')).toHaveText(description);
  await expect(leader.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
  await expect(leader.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();
  await reference.getByRole('button', { name: 'Done editing' }).click();
  const disabledReference = shortcutCommand(page, 'table:prefix');
  await expect(disabledReference.locator('.shortcut-keys')).toHaveCount(0);
  await expect(disabledReference.locator('s')).toHaveText(description);

  // command-level Reset restores defaults and discards added aliases together
  await editShortcuts(reference);
  leader = shortcutCommand(page, 'table:prefix');
  await leader.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(shortcutAssignment(page, 'root:C-b', 'C-b')).toHaveCount(1);
  await expect(shortcutAssignment(page, 'root:C-b', 'C-a')).toHaveCount(0);
  await expect(leader.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();

  // browser-reserved keys remain rejected without losing the current assignments
  await shortcutAssignment(page, 'root:C-b', 'C-b').locator('.shortcut-change').click();
  recorder = leader.getByRole('textbox', { name: `New shortcut for ${description}` });
  await recorder.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', ctrlKey: true, bubbles: true, composed: true, cancelable: true })));
  await expect(recorder).toHaveValue('Ctrl + T');
  await leader.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(leader.getByRole('alert')).toContainText('Firefox and Chromium both reserve it');
  await leader.getByRole('button', { name: 'Cancel', exact: true }).click();

  // unreadable browser storage remains recoverable through the global reset
  await page.evaluate(() => {
    localStorage.setItem('rac.keyboard-shortcuts', '{broken');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.keyboard-shortcuts', newValue: '{broken', storageArea: localStorage }));
  });
  await expect(reference.getByRole('alert')).toContainText('Saved shortcuts could not be loaded. Defaults are active');
  const editor = reference.getByRole('region', { name: 'Edit keyboard shortcuts' });
  await editor.getByRole('button', { name: 'Reset all shortcuts' }).click();
  await expect(editor.getByRole('searchbox', { name: 'Find keyboard shortcuts' })).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('rac.keyboard-shortcuts'))).toBeNull();
  expect(state.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(state)).toEqual([]);
});

test('consolidates duplicate command rows and same-command chords across tables', async ({ page }) => {
  const { state } = await openDashboard(page);
  const settings = await openSettings(page);
  const reference = await openShortcutReference(page, settings);

  // each action is one global row even when defaults contain several assignments
  for (const [command, origins] of [
    ['action:font-larger', ['root:C-=', 'root:C-+', 'root:Super-=', 'root:Super-+']],
    ['action:copy-selection', ['root:C-S-c', 'root:y', 'root:C-c', 'root:Super-c']],
    ['action:prompt-newline', ['root:C-Enter', 'root:S-Enter', 'root:C-S-Enter', 'root:Super-Enter']],
    ['action:next-panel', ['prefix:n', 'prefix:o']],
    ['action:show-bindings', ['root:C-?', 'prefix:?']]
  ] as const) {
    const commandRow = shortcutCommand(page, command);
    await expect(commandRow).toHaveCount(1);
    for (const origin of origins) await expect(commandRow).toHaveAttribute('data-shortcut-origins', new RegExp(`(?:^|\\s)${origin.replace(/[+?]/gu, '\\$&')}(?:\\s|$)`, 'u'));
  }
  const showBindings = shortcutCommand(page, 'action:show-bindings');
  await expect(showBindings).toContainText('prefix');
  await expect(showBindings.getByText('root', { exact: true })).toHaveCount(0);

  await editShortcuts(reference);
  // a new assignment uses the same prefix switch as an existing assignment
  await showBindings.getByRole('button', { name: 'Add shortcut for Show key bindings' }).click();
  const prefixSwitch = showBindings.getByRole('switch', { name: 'Use prefix for Show key bindings' });
  await expect(prefixSwitch).not.toBeChecked();
  await expect(showBindings.getByRole('combobox', { name: 'Prefix table for Show key bindings' })).toHaveCount(0);
  await prefixSwitch.click();
  await expect(prefixSwitch).toBeChecked();
  await showBindings.getByRole('button', { name: 'Cancel', exact: true }).click();

  // assigning two origins of one command to the same chord renders one physical shortcut
  const font = shortcutCommand(page, 'action:font-larger');
  await changeShortcut(page, 'root:C-=', 'Larger terminal font', 'Control+F6', 'C-=');
  await expect(font.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();
  await changeShortcut(page, 'root:C-+', 'Larger terminal font', 'Control+F6', 'C-+');
  const chords = await font.locator('[data-shortcut-chord]').evaluateAll(elements => elements.map(element => element.getAttribute('data-shortcut-chord')));
  expect(chords.filter(chord => chord === 'C-F6')).toHaveLength(1);
  expect(new Set(chords).size).toBe(chords.length);
  await expect(font).not.toHaveClass(/shortcut-conflict/u);

  // command controls update every default origin together
  await font.getByRole('button', { name: 'Reset', exact: true }).click();
  await font.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(font.locator('.shortcut-keys')).toHaveCount(0);
  await expect(font.locator('.shortcut-change')).toHaveCount(0);
  await expect(font.getByRole('button', { name: 'Add shortcut for Larger terminal font' })).toHaveCount(0);
  await expect(font.locator('.shortcut-setting-description s')).toHaveText('Larger terminal font');
  const enable = font.getByRole('button', { name: 'Enable', exact: true });
  await expect(enable).toBeEnabled();
  await enable.click();
  const restored = await font.locator('[data-shortcut-chord]').evaluateAll(elements => elements.map(element => element.getAttribute('data-shortcut-chord')));
  expect(restored).toEqual(['C-=', 'C-+', 'Super-=', 'Super-+']);
  expect(state.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(state)).toEqual([]);
});

test('moves bindings between direct and prefixed contexts with one persistent switch', async ({ page }) => {
  const keys = { root: { 'C-g': { table: 'git' } }, git: { '?': 'show-bindings' } };
  const { state, terminal } = await openDashboard(page, { keys });
  let settings = await openSettings(page);
  let reference = await openShortcutReference(page, settings);
  await editShortcuts(reference);
  let bindings = shortcutCommand(page, 'action:show-bindings');
  const description = 'Show key bindings';

  // adding always exposes the direct-or-prefix choice and only lists prefix tables
  await bindings.getByRole('button', { name: `Add shortcut for ${description}` }).click();
  let prefixSwitch = bindings.getByRole('switch', { name: `Use prefix for ${description}` });
  await expect(prefixSwitch).not.toBeChecked();
  await prefixSwitch.click();
  await expect(prefixSwitch).toBeChecked();
  const prefixTable = bindings.getByRole('combobox', { name: `Prefix table for ${description}` });
  await expect(prefixTable.locator('option')).toHaveText(['prefix', 'git']);
  await expect(prefixTable.locator('option[value="root"]')).toHaveCount(0);
  await bindings.getByRole('button', { name: 'Cancel', exact: true }).click();

  // an existing direct binding starts unchecked and can move without rerecording its key
  const direct = shortcutAssignment(page, 'root:C-?', 'C-?');
  await direct.locator('.shortcut-change').click();
  let recorder = bindings.getByRole('textbox', { name: `New shortcut for ${description}` });
  await expect(recorder).toHaveValue('Ctrl + ?');
  prefixSwitch = bindings.getByRole('switch', { name: `Use prefix for ${description}` });
  await expect(prefixSwitch).not.toBeChecked();
  await prefixSwitch.click();
  await expect(prefixSwitch).toBeChecked();
  await bindings.getByRole('combobox', { name: `Prefix table for ${description}` }).selectOption('prefix');
  await bindings.getByRole('button', { name: 'Save', exact: true }).click();
  const movedToPrefix = shortcutAssignmentInTable(page, 'root:C-?', 'prefix', 'C-?');
  await expect(movedToPrefix).toHaveCount(1);
  await expect(movedToPrefix).toHaveAttribute('data-shortcut-id', 'root:C-?');

  // a prefixed bare key cannot become direct until a safe modified key replaces it
  const prefixed = shortcutAssignmentInTable(page, 'prefix:?', 'prefix', '?');
  await prefixed.locator('.shortcut-change').click();
  recorder = bindings.getByRole('textbox', { name: `New shortcut for ${description}` });
  await expect(recorder).toHaveValue('?');
  prefixSwitch = bindings.getByRole('switch', { name: `Use prefix for ${description}` });
  await expect(prefixSwitch).toBeChecked();
  await prefixSwitch.click();
  await expect(prefixSwitch).not.toBeChecked();
  await bindings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(bindings.getByRole('alert')).toContainText('cannot steal typing');
  await expect(recorder).toBeVisible();
  await recorder.press('Control+F7');
  await bindings.getByRole('button', { name: 'Save', exact: true }).click();
  const movedToDirect = shortcutAssignmentInTable(page, 'prefix:?', 'root', 'C-F7');
  await expect(movedToDirect).toHaveCount(1);
  await expect(movedToDirect).toHaveAttribute('data-shortcut-id', 'prefix:?');
  await expect(reference.getByText('root', { exact: true })).toHaveCount(0);
  await reference.getByRole('button', { name: 'Close key bindings' }).click();
  await settings.getByRole('button', { name: 'Close settings' }).click();

  // both context moves survive reload and dispatch only from their new contexts
  await page.reload();
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, '%5', 80, 24);
  const reloadedTerminal = page.locator('.terminal-pane[data-panel-key="%5"]');
  await reloadedTerminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+?');
  await expect(page.getByRole('dialog', { name: 'Key bindings' })).toHaveCount(0);
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Control+?');
  await expect(page.getByRole('dialog', { name: 'Key bindings' })).toBeVisible();
  await page.getByRole('button', { name: 'Close key bindings' }).click();
  await reloadedTerminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+F7');
  await expect(page.getByRole('dialog', { name: 'Key bindings' })).toBeVisible();

  settings = page.getByRole('dialog', { name: 'Settings' });
  reference = page.getByRole('dialog', { name: 'Key bindings' });
  await reference.getByRole('button', { name: 'Edit shortcuts' }).click();
  bindings = shortcutCommand(page, 'action:show-bindings');
  await expect(shortcutAssignmentInTable(page, 'root:C-?', 'prefix', 'C-?')).toHaveCount(1);
  await expect(shortcutAssignmentInTable(page, 'prefix:?', 'root', 'C-F7')).toHaveCount(1);
  await expect(bindings.getByText('root', { exact: true })).toHaveCount(0);
  expect(state.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(state)).toEqual([]);
});

test('persists conflicts, highlights every command, suppresses dispatch, and resolves one alias', async ({ page }) => {
  const { state, terminal } = await openDashboard(page);
  let settings = await openSettings(page);
  let reference = await openShortcutReference(page, settings);
  await editShortcuts(reference);
  const leader = shortcutCommand(page, 'table:prefix');
  const bindings = shortcutCommand(page, 'action:show-bindings');

  // the same chord in a prefix context remains independent from its direct counterpart
  await leader.getByRole('button', { name: 'Add shortcut for Switch to the prefix table' }).click();
  let recorder = leader.getByRole('textbox', { name: 'New shortcut for Switch to the prefix table' });
  const prefixSwitch = leader.getByRole('switch', { name: 'Use prefix for Switch to the prefix table' });
  await prefixSwitch.click();
  await expect(prefixSwitch).toBeChecked();
  await recorder.press('Control+?');
  await leader.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(recorder).toHaveCount(0);
  await expect(shortcutAssignmentInTable(page, 'root:C-b', 'prefix', 'C-?')).toHaveCount(1);
  await expect(leader).not.toHaveClass(/shortcut-conflict/u);
  await expect(bindings).not.toHaveClass(/shortcut-conflict/u);

  // saving the duplicate in the same direct context exposes both conflict participants
  await leader.getByRole('button', { name: 'Add shortcut for Switch to the prefix table' }).click();
  recorder = leader.getByRole('textbox', { name: 'New shortcut for Switch to the prefix table' });
  await expect(leader.getByRole('switch', { name: 'Use prefix for Switch to the prefix table' })).not.toBeChecked();
  await recorder.press('Control+?');
  await leader.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(shortcutAssignmentInTable(page, 'root:C-b', 'root', 'C-?')).toHaveCount(1);
  // same-chord deletion controls announce which context they remove
  await expect(leader.getByRole('button', { name: 'Remove shortcut Ctrl + ? for Switch to the prefix table', exact: true })).toHaveCount(1);
  await expect(leader.getByRole('button', { name: 'Remove shortcut prefix: Ctrl + ? for Switch to the prefix table', exact: true })).toHaveCount(1);
  for (const row of [leader, bindings]) {
    await expect(row).toHaveClass(/shortcut-conflict/u);
    await expect(row.getByText(/Conflict/u)).toBeVisible();
    await expect(row.getByText(/Conflict/u)).not.toContainText(/root/iu);
  }
  await expect(reference.getByRole('alert')).not.toContainText(/root/iu);

  // conflict state remains visible outside edit mode
  await reference.getByRole('button', { name: 'Done editing' }).click();
  for (const row of [shortcutCommand(page, 'table:prefix'), shortcutCommand(page, 'action:show-bindings')]) {
    await expect(row).toHaveClass(/shortcut-conflict/u);
    await expect(row.getByText(/Conflict/u)).toBeVisible();
  }
  await reference.getByRole('button', { name: 'Close key bindings' }).click();
  await settings.getByRole('button', { name: 'Close settings' }).click();

  // reload while ambiguous so saved conflicts cannot silently fall back to defaults
  await page.reload();
  await seedPaneSize(page, 'agent-1', 80, 24);
  await seedPaneSize(page, '%5', 80, 24);
  settings = await openSettings(page);
  reference = await openShortcutReference(page, settings);
  for (const row of [shortcutCommand(page, 'table:prefix'), shortcutCommand(page, 'action:show-bindings')]) {
    await expect(row).toHaveClass(/shortcut-conflict/u);
    await expect(row.getByText(/Conflict/u)).toBeVisible();
  }
  await reference.getByRole('button', { name: 'Close key bindings' }).click();
  await settings.getByRole('button', { name: 'Close settings' }).click();

  // the conflicting chord runs neither command while their unconflicted aliases still work
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+?');
  await page.keyboard.press('1');
  await expect(page.getByRole('dialog', { name: 'Key bindings' })).toHaveCount(0);
  await expect(terminal).toHaveClass(/focused/u);
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Control+?');
  await page.keyboard.press('1');
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeFocused();
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Key bindings' })).toBeVisible();

  // removing the conflicting alias makes the remaining command dispatchable again
  await page.getByRole('button', { name: 'Edit shortcuts' }).click();
  await shortcutAssignmentInTable(page, 'root:C-b', 'root', 'C-?').getByRole('button', { name: 'Remove shortcut Ctrl + ? for Switch to the prefix table' }).click();
  await expect(shortcutAssignmentInTable(page, 'root:C-b', 'prefix', 'C-?')).toHaveCount(1);
  await expect(shortcutCommand(page, 'table:prefix')).not.toHaveClass(/shortcut-conflict/u);
  await expect(shortcutCommand(page, 'action:show-bindings')).not.toHaveClass(/shortcut-conflict/u);
  await page.getByRole('button', { name: 'Done editing' }).click();
  await expect(page.getByText(/Conflict/u)).toHaveCount(0);
  await page.getByRole('button', { name: 'Close key bindings' }).click();
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+?');
  await expect(page.getByRole('dialog', { name: 'Key bindings' })).toBeVisible();
  expect(state.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(state)).toEqual([]);
});

test('adopts legacy cross-tab aliases during recording and preserves colliding updates', async ({ page }) => {
  const { state } = await openDashboard(page);
  const settings = await openSettings(page);
  const reference = await openShortcutReference(page, settings);
  await editShortcuts(reference);
  const leader = shortcutCommand(page, 'table:prefix');

  // a storage update cancels stale capture and migrates the legacy scalar in memory
  await shortcutAssignment(page, 'root:C-b', 'C-b').locator('.shortcut-change').click();
  const recorder = leader.getByRole('textbox', { name: 'New shortcut for Switch to the prefix table' });
  await expect(recorder).toBeFocused();
  await page.evaluate(() => {
    const value = JSON.stringify({ root: { 'C-b': 'C-a' } });
    localStorage.setItem('rac.keyboard-shortcuts', value);
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.keyboard-shortcuts', newValue: value, storageArea: localStorage }));
  });
  await expect(recorder).toHaveCount(0);
  await expect(shortcutAssignment(page, 'root:C-b', 'C-a')).toHaveCount(1);
  await expect(leader.locator('.shortcut-change')).toBeFocused();

  // a later colliding update stays assigned and highlighted instead of restoring C-b
  await page.evaluate(() => {
    const value = JSON.stringify({ root: { 'C-b': 'C-?' } });
    localStorage.setItem('rac.keyboard-shortcuts', value);
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.keyboard-shortcuts', newValue: value, storageArea: localStorage }));
  });
  await expect(shortcutAssignment(page, 'root:C-b', 'C-?')).toHaveCount(1);
  await expect(shortcutAssignment(page, 'root:C-b', 'C-b')).toHaveCount(0);
  await expect(shortcutCommand(page, 'table:prefix')).toHaveClass(/shortcut-conflict/u);
  await expect(shortcutCommand(page, 'action:show-bindings')).toHaveClass(/shortcut-conflict/u);
  await reference.getByRole('button', { name: 'Done editing' }).click();
  await expect(shortcutCommand(page, 'table:prefix')).toHaveClass(/shortcut-conflict/u);
  await expect(shortcutCommand(page, 'action:show-bindings')).toHaveClass(/shortcut-conflict/u);
  expect(state.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(state)).toEqual([]);
});

test('preserves terminal binding identity after remapping from keys and the palette', async ({ page }) => {
  const keys = { root: { 'C-g': { table: 'git' } }, git: { l: { terminal: 'lazygit' } } };
  const { state, terminal } = await openDashboard(page, { keys });
  const settings = await openSettings(page);
  const reference = await openShortcutReference(page, settings);
  await editShortcuts(reference);
  await changeShortcut(page, 'prefix:g', 'Terminal running lazygit (reused)', 'j');
  const gitTerminal = shortcutCommand(page, 'terminal:git:l');
  await shortcutAssignment(page, 'git:l', 'l').locator('.shortcut-change').click();
  const recorder = gitTerminal.getByRole('textbox', { name: 'New shortcut for Terminal running lazygit' });
  await expect(recorder).toHaveValue('L');
  const prefixSwitch = gitTerminal.getByRole('switch', { name: 'Use prefix for Terminal running lazygit' });
  await expect(prefixSwitch).toBeChecked();
  await prefixSwitch.click();
  await expect(prefixSwitch).not.toBeChecked();
  await recorder.press('Control+F8');
  await gitTerminal.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(shortcutAssignmentInTable(page, 'git:l', 'root', 'C-F8')).toHaveCount(1);
  await reference.getByRole('button', { name: 'Close key bindings' }).click();
  await settings.getByRole('button', { name: 'Close settings' }).click();

  await terminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('j');
  await expect.poll(() => state.shells).toEqual([
    { binding: { table: 'prefix', key: 'g' } }
  ]);
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+F8');
  await expect.poll(() => state.shells).toEqual([
    { binding: { table: 'prefix', key: 'g' } },
    { binding: { table: 'git', key: 'l' } }
  ]);

  await page.keyboard.press('Control+b');
  await page.keyboard.press(':');
  let palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('option').filter({ hasText: 'prefix J' }).click();
  await expect.poll(() => state.shells).toEqual([
    { binding: { table: 'prefix', key: 'g' } },
    { binding: { table: 'git', key: 'l' } },
    { binding: { table: 'prefix', key: 'g' } }
  ]);
  await terminal.locator('.xterm-screen').click();
  await page.keyboard.press('Control+b');
  await page.keyboard.press(':');
  palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('option').filter({ hasText: 'Ctrl + F8' }).click();
  await expect.poll(() => state.shells).toEqual([
    { binding: { table: 'prefix', key: 'g' } },
    { binding: { table: 'git', key: 'l' } },
    { binding: { table: 'prefix', key: 'g' } },
    { binding: { table: 'git', key: 'l' } }
  ]);
  expect(state.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(state)).toEqual([]);
});

test('remaps prompt newline immediately without submitting on the old chord', async ({ page }) => {
  const { state } = await openDashboard(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('first line');
  await prompt.press('Control+Enter');
  await expect(prompt).toHaveValue('first line\n');
  expect(state.prompts).toEqual([]);
  await prompt.fill('command line');
  await prompt.press('Meta+Enter');
  await expect(prompt).toHaveValue('command line\n');
  expect(state.prompts).toEqual([]);

  const settings = await openSettings(page);
  const reference = await openShortcutReference(page, settings);
  await editShortcuts(reference);
  await changeShortcut(page, 'root:C-Enter', 'Insert a newline in the prompt', 'Control+j');
  await reference.getByRole('button', { name: 'Close key bindings' }).click();
  await settings.getByRole('button', { name: 'Close settings' }).click();

  await prompt.fill('second line');
  await prompt.press('Control+Enter');
  await expect(prompt).toHaveValue('second line');
  expect(state.prompts).toEqual([]);
  await prompt.press('Control+j');
  await expect(prompt).toHaveValue('second line\n');
  expect(state.prompts).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  expect(unexpectedConsoleErrors(state)).toEqual([]);
});
