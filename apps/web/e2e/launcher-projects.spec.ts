import { expect, test } from '@playwright/test';

// the projects[] wire: the "+" launcher groups idle Worktrees under one section per Project
// — a header, one row per Worktree (name, Pin, Rename, Remove, Launch), then New worktree…
// — and each row's Pin toggle POSTs to /api/worktrees/:id/pin
test('launcher lists per-project sections and pins a worktree', async ({ page }) => {
  const pins: Array<{ id: string; pinned: boolean }> = [];
  const labels: Array<{ id: string; label: string | null }> = [];
  let worktreeLabel = '🥔 Dave';
  let delayRenamedDashboard = false;
  let releaseLabelRequest = () => {};
  const labelRequestGate = new Promise<void>(resolve => { releaseLabelRequest = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') {
      // hold reconciliation so the saved label must update optimistically
      if (delayRenamedDashboard) {
        delayRenamedDashboard = false;
        await new Promise(resolve => setTimeout(resolve, 1_500));
      }
      return route.fulfill({ json: { generation: 1, agents: [], projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [
        { id: 'repo:/repo', projectId: 'repo', label: 'Repo', path: '/repo', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' },
        { id: 'repo:/repo/feature', projectId: 'repo', label: worktreeLabel, path: '/repo/feature', main: false, detached: false, locked: false, available: true, pinned: false, order: 1, branch: 'feature' }
      ] }] } });
    }
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    const pinMatch = /^\/api\/worktrees\/([^/]+)\/pin$/u.exec(url.pathname);
    if (pinMatch && request.method() === 'POST') {
      pins.push({ id: decodeURIComponent(pinMatch[1]), pinned: (request.postDataJSON() as { pinned: boolean }).pinned });
      return route.fulfill({ status: 204 });
    }
    const labelMatch = /^\/api\/worktrees\/([^/]+)\/label$/u.exec(url.pathname);
    // capture custom-label mutations
    if (labelMatch && request.method() === 'PATCH') {
      const label = (request.postDataJSON() as { label: string | null }).label;
      labels.push({ id: decodeURIComponent(labelMatch[1]), label });
      worktreeLabel = label ?? 'Repo · feature';
      delayRenamedDashboard = true;
      // expose the pending save treatment until the test inspects it
      await labelRequestGate;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // the main Worktree is pinned, so it already has a tab
  await expect(page.getByRole('tab', { name: /^Repo —/u })).toBeVisible();
  // open the launcher and confirm the per-project section lists both idle Worktrees
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const projectLabel = launcher.locator('.launcher-project-header > span');
  await expect(projectLabel).toHaveText('Repo');
  // match Project typography to Worktree names while retaining the purple hierarchy
  const projectStyle = await projectLabel.evaluate(element => {
    const project = element.closest('.launcher-project');
    const header = element.closest('.launcher-project-header');
    const worktree = project?.querySelector('.launcher-row-label');
    const worktreeRow = project?.querySelector('.launcher-row');
    const palette = document.createElement('span');
    palette.style.color = 'var(--mauve)';
    document.body.append(palette);
    const style = { fontSize: getComputedStyle(element).fontSize, worktreeFontSize: worktree === null || worktree === undefined ? undefined : getComputedStyle(worktree).fontSize, height: header?.getBoundingClientRect().height, worktreeHeight: worktreeRow?.getBoundingClientRect().height, color: getComputedStyle(element).color, purple: getComputedStyle(palette).color };
    palette.remove();
    return style;
  });
  expect(projectStyle.fontSize).toBe(projectStyle.worktreeFontSize);
  expect(projectStyle.height).toBe(projectStyle.worktreeHeight);
  expect(projectStyle.color).toBe(projectStyle.purple);
  // rows sit under that header, so Main uses its branch while a custom linked name stays exact
  await expect(launcher.locator('.launcher-row-label')).toHaveText(['Scratch', 'main', '🥔 Dave']);
  // New worktree… closes the section, below the last row
  await expect(launcher.locator('.launcher-project > :last-child')).toHaveClass(/launcher-new-worktree/u);
  // the pinned Main worktree offers an Unpin toggle; the idle feature offers a Pin toggle.
  // Both are icon-only, so the accessible name and the tooltip carry the wording
  const pin = launcher.getByRole('button', { name: 'Pin 🥔 Dave' });
  const unpin = launcher.getByRole('button', { name: 'Unpin Repo', exact: true });
  const rename = launcher.getByRole('button', { name: 'Rename 🥔 Dave' });
  await expect(unpin).toBeVisible();
  await expect(pin).toHaveText('');
  await expect(pin).toHaveAttribute('title', 'Pin worktree');
  await expect(pin.locator('path')).toHaveAttribute('d', 'M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6ZM12 15v5');
  await expect(rename.locator('path')).toHaveAttribute('d', 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.42l-2.34-2.34a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.84Z');
  // inspect the rendered icon paint
  const pinPaint = await pin.evaluate(element => { const button = getComputedStyle(element); const icon = getComputedStyle(element.querySelector('svg')!); return { background: button.backgroundColor, border: button.borderColor, color: icon.color, fill: icon.fill, stroke: icon.stroke }; });
  expect(pinPaint.background).toBe('rgba(0, 0, 0, 0)');
  expect(pinPaint.border).toBe('rgba(0, 0, 0, 0)');
  expect(pinPaint.fill).toBe('none');
  expect(pinPaint.stroke).toBe(pinPaint.color);
  // the toggle reads pressed or not without being hovered: `pinned` is the filled state
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect(unpin).toHaveAttribute('aria-pressed', 'true');
  await expect(unpin).toHaveClass(/\bpinned\b/u);
  await expect(pin).not.toHaveClass(/\bpinned\b/u);
  await pin.click();
  await expect.poll(() => pins).toContainEqual({ id: 'repo:/repo/feature', pinned: true });
  // custom names can be changed without editing the Project config
  await rename.click();
  const dialog = page.getByRole('dialog', { name: 'Rename worktree' });
  await expect(dialog.getByRole('textbox', { name: 'Worktree name' })).toHaveValue('🥔 Dave');
  await dialog.getByRole('textbox', { name: 'Worktree name' }).fill('🥔 David');
  const save = dialog.locator('button[type="submit"]');
  await expect(save).toHaveText('Save');
  await save.click();
  const spinner = save.locator('.spinner');
  await expect(spinner).toBeVisible();
  // keep the pending glyph circular instead of allowing flexbox to squash it
  const spinnerSize = await spinner.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
  expect(spinnerSize.width).toBe(spinnerSize.height);
  releaseLabelRequest();
  await expect.poll(() => labels).toContainEqual({ id: 'repo:/repo/feature', label: '🥔 David' });
  // the dialog and visible row update without waiting for dashboard polling
  await expect(dialog).toHaveCount(0, { timeout: 500 });
  await expect(launcher.locator('.launcher-row-label').nth(2)).toHaveText('🥔 David', { timeout: 500 });
});

test('launcher keeps a worktree visible while its agent is already open', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/home/ubuntu/remoteagents', projectId: 'remoteagents', worktreeId: 'remoteagents:/workspace', title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0 }],
      projects: [{ id: 'remoteagents', label: '📱 Remote Agents', available: true, worktrees: [{ id: 'remoteagents:/workspace', projectId: 'remoteagents', label: '📱 Remote Agents', customLabel: true, path: '/workspace', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main' }] }]
    } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.locator('.new-agent-tab').click();
  const launcher = page.getByRole('group', { name: 'Agent launcher' });
  const project = launcher.getByRole('group', { name: '📱 Remote Agents' });
  // the active Main worktree stays listed and opens its existing agent
  await expect(project.locator('.launcher-row-label')).toHaveText('📱 Remote Agents');
  const open = project.getByRole('button', { name: 'Open 📱 Remote Agents' });
  await expect(open).toBeVisible();
  await open.click();
  await expect(launcher).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^📱 Remote Agents —/u })).toHaveAttribute('aria-selected', 'true');
});
