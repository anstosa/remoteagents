import { expect, test } from '@playwright/test';

test.use({ hasTouch: true });

test('expands prompt and git toolbar sections independently without a last-prompt label', async ({ page }) => {
  const longPrompt = 'Review every changed service and explain the deployment risk before making any edits. '.repeat(8);
  const overflowChanges = Array.from({ length: 47 }, (_, index) => ({ code: ' M', path: `apps/server/src/generated-${index}.ts`, additions: 1, deletions: 0 }));
  await page.setViewportSize({ width: 428, height: 952 });
  await page.addInitScript(prompt => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        this.url = String(url);
        window.setTimeout(() => {
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          if (this.url.includes('/ws/logs/')) {
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: 'Ready\\n', lastPrompt: prompt }) }));
          }
        });
      }
      send() {}
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  }, longPrompt);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', branch: 'feature/full-toolbar-git-status', gitStatus: { files: 54, staged: 2, unstaged: 51, untracked: 1, conflicted: 0, changes: [{ code: 'M ', path: 'apps/server/src/app.ts', additions: 12, deletions: 3 }, { code: ' M', path: 'apps/web/src/main.tsx', additions: 8, deletions: 2 }, { code: 'MM', path: 'apps/web/src/styles.css', additions: 5, deletions: 4 }, { code: ' M', path: 'apps/web/e2e/last-prompt.spec.ts', additions: 16, deletions: 5 }, { code: ' M', path: 'README.md', additions: 4, deletions: 1 }, { code: 'R ', path: 'docs/setup.md', originalPath: 'docs/install.md', additions: 3, deletions: 2 }, { code: '??', path: 'notes/release plan.md', additions: 9, deletions: 0 }, ...overflowChanges] }, title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [{ id: 'prompt-history-001', text: longPrompt, createdAt: '2026-08-04T01:00:00.000Z' }] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByText('Last prompt:', { exact: false })).toHaveCount(0);
  const toolbar = page.locator('.log-topbar');
  const prompt = page.getByRole('button', { name: 'Last prompt', exact: true });
  const git = page.getByRole('button', { name: /^Git status:/u });
  await expect(prompt).toHaveAttribute('title', longPrompt);
  await expect(git).toBeVisible();
  const promptText = prompt.locator('.toolbar-prompt-text');
  await expect(promptText).toHaveCSS('font-weight', '400');
  await expect(promptText).toHaveCSS('text-overflow', 'ellipsis');
  await expect(promptText).toHaveCSS('white-space', 'nowrap');
  expect(await promptText.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  const collapsedHeight = await toolbar.evaluate(element => element.getBoundingClientRect().height);

  await prompt.click();
  await expect(prompt).toHaveAttribute('aria-expanded', 'true');
  await expect(git).toHaveCount(0);
  expect(await toolbar.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(collapsedHeight * 2);

  await prompt.click();
  const collapsedGit = page.getByRole('button', { name: /^Git status:/u });
  await collapsedGit.tap();
  const expandedGit = page.getByRole('button', { name: /^Git status:/u });
  const changedFiles = page.getByRole('region', { name: 'Changed files' });
  await expect(expandedGit).toHaveAttribute('aria-expanded', 'true');
  await expect(prompt).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prompt history (1)' })).toHaveCount(0);
  await expect(changedFiles).toContainText('2 staged files · 51 unstaged files · 1 untracked file');
  await expect(changedFiles).toContainText('apps/server/src/app.ts');
  await expect(changedFiles).toContainText('apps/web/src/main.tsx');
  await expect(changedFiles).toContainText('docs/install.md → docs/setup.md');
  await expect(changedFiles).toContainText('notes/release plan.md');
  const implementation = changedFiles.getByRole('group', { name: 'Implementation files' });
  const supporting = changedFiles.getByRole('group', { name: 'Tests & documentation files' });
  await expect(implementation.locator('.git-status-group-header')).toContainText('50 files+72−9');
  await expect(implementation.locator('.git-status-file').first()).toContainText('apps/server/src/app.ts+12−3');
  await expect(supporting.locator('.git-status-group-header')).toContainText('4 files+32−8');
  await expect(supporting.locator('.git-status-file').first()).toContainText('apps/web/e2e/last-prompt.spec.ts+16−5');
  const groups = await changedFiles.locator('.git-status-group').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  expect(groups).toEqual(['Implementation files', 'Tests & documentation files']);
  const overflow = await changedFiles.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
  const placement = await Promise.all([changedFiles, expandedGit].map(locator => locator.evaluate(element => { const bounds = element.getBoundingClientRect(); return { top: bounds.top, bottom: bounds.bottom }; })));
  expect(placement[0]!.top).toBeGreaterThanOrEqual(0);
  expect(placement[0]!.bottom).toBeLessThanOrEqual(placement[1]!.top);
  const panelBounds = await changedFiles.boundingBox();
  const touch = await page.context().newCDPSession(page);
  const x = panelBounds!.x + panelBounds!.width / 2;
  const startY = panelBounds!.y + panelBounds!.height - 50;
  const endY = panelBounds!.y + 100;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: endY }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(await changedFiles.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Collapse git status' }).tap();
  await expect(changedFiles).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Last prompt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prompt history (1)' }).click();
  await expect(page.getByLabel('Prompt history', { exact: true })).toContainText(longPrompt);
});
