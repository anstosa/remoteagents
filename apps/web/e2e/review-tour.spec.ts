import { expect, test } from '@playwright/test';

// verify generation, notification, and feedback flow
test('guides a human through active-scope implementation changes and sends consolidated feedback', async ({ page }) => {
  const jobRequests: Array<{ scope: string; includeTests: boolean; includeDocs: boolean }> = [];
  const prompts: string[] = [];
  // create a vertically overflowing diff fixture
  const longPatch = ['@@ -1,2 +1,122 @@', '-old route', `+new route ${'wide-content-'.repeat(40)}`, ...Array.from({ length: 120 }, (_, index) => ` context line ${index + 1}`)].join('\n');
  let snapshotFingerprint = 'snapshot-1234567890';
  let releaseGeneration = false;
  let fingerprintRequests = 0;
  let latestReadyJob = 0;
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // connect the mocked agent stream
      constructor(url: string | URL) {
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          if (this.url.includes('/ws/logs/')) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: 'Ready\n' }) }));
        });
      }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    Object.defineProperty(window, '__testNotifications', { configurable: true, value: notifications });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted' } });
    // capture browser alerts
    const registration = { getNotifications: async () => [], showNotification: async (title: string, options?: NotificationOptions) => { notifications.push({ title, options }); } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration), register: async () => registration } });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the active console fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, reviewTour: { available: true }, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/review-tour', title: 'Ready', gitStatus: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0, changes: [{ code: ' M', path: 'src/route.ts', additions: 8, deletions: 2, category: 'implementation' }, { code: ' M', path: 'test/route.test.ts', additions: 4, deletions: 1, category: 'test' }] }, gitPrStatus: { base: 'origin/main', files: 2, changes: [{ code: 'M ', path: 'src/route.ts', additions: 12, deletions: 3, category: 'implementation' }, { code: 'M ', path: 'docs/review.md', additions: 6, deletions: 0, category: 'doc' }] } }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/skills') return route.fulfill({ json: { skills: [] } });
    // start one bounded tour job
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs' && request.method() === 'POST') {
      jobRequests.push(request.postDataJSON() as typeof jobRequests[number]);
      return route.fulfill({ status: 202, json: { status: 'pending', job: { id: `job-${jobRequests.length}`, expiresAt: '2026-08-07T20:00:00.000Z', retryAfterMs: 10 } } });
    }
    const jobMatch = url.pathname.match(/^\/api\/review-tour\/jobs\/job-(\d+)$/u);
    if (jobMatch !== null && request.method() === 'GET') {
      if (!releaseGeneration) return route.fulfill({ status: 202, json: { status: 'pending' } });
      latestReadyJob = Math.max(latestReadyJob, Number(jobMatch[1]));
      return route.fulfill({ json: { status: 'ready', tour: { title: 'Request routing tour', overview: 'Follow the request from the route into the service.', scope: 'pr', base: 'origin/main', includeTests: jobRequests.at(-1)?.includeTests ?? false, includeDocs: jobRequests.at(-1)?.includeDocs ?? false, fingerprint: snapshotFingerprint, changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: longPatch }, { id: 'chg_service01', file: 'src/service.ts', category: 'implementation', kind: 'hunk', patch: '@@ -4 +4 @@\n-old service\n+new service' }], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route validates input before delegating.', changeIds: ['chg_route0001'] }, { id: 'service', title: 'Apply the operation', explanation: 'The service performs the requested state transition.', changeIds: ['chg_service01'] }] } } });
    }
    if (/^\/api\/review-tour\/jobs\/job-\d+$/u.test(url.pathname) && request.method() === 'DELETE') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') {
      fingerprintRequests += 1;
      return route.fulfill({ json: { status: 'snapshot', snapshot: { scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: snapshotFingerprint } } });
    }
    // capture the final batch request
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      prompts.push((request.postDataJSON() as { prompt: string }).prompt);
      if (prompts.length === 1) return route.fulfill({ status: 400, json: { error: 'invalid prompt' } });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  const statusPanel = page.getByRole('region', { name: 'Changed files' });
  await expect(statusPanel.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  await expect(statusPanel.getByRole('button', { name: 'All PR' })).toHaveAttribute('aria-pressed', 'true');
  await statusPanel.getByRole('button', { name: 'Review', exact: true }).click();

  const loadingDialog = page.getByRole('dialog', { name: 'Generating change tour' });
  await expect(loadingDialog).toBeHidden();
  const reviewButton = page.locator('.review-tour-toggle');
  await expect(reviewButton).toBeVisible();
  await expect(reviewButton).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  await expect(statusPanel.getByRole('button', { name: 'Open Review' })).toBeVisible();
  await statusPanel.getByRole('button', { name: 'Open Review' }).click();
  await expect(loadingDialog).toBeVisible();
  await expect(loadingDialog).toHaveCSS('animation-name', 'review-tour-slide-up');
  await loadingDialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const loadingBounds = await loadingDialog.boundingBox();
  expect(loadingBounds).toMatchObject({ x: 0, y: 0, width: 1280, height: 720 });
  await loadingDialog.getByRole('button', { name: 'Minimize guided review' }).evaluate(button => button.click());
  await expect(loadingDialog).toHaveCSS('animation-name', 'review-tour-slide-down');
  await expect(loadingDialog).toBeHidden();
  await expect(reviewButton).toBeVisible();
  await expect(reviewButton).toHaveAttribute('aria-busy', 'true');
  await expect(reviewButton.locator('.spinner')).toBeVisible();
  const precedesMore = await reviewButton.evaluate((button, more) => Boolean(button.compareDocumentPosition(more as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await page.getByRole('button', { name: 'More options' }).elementHandle());
  expect(precedesMore).toBe(true);

  releaseGeneration = true;
  await expect(reviewButton).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => await page.evaluate(() => (
    window as unknown as { __testNotifications: Array<{ title: string; options?: NotificationOptions }> }
  ).__testNotifications.map(notification => ({ title: notification.title, body: notification.options?.body, tag: notification.options?.tag, data: notification.options?.data })))).toEqual([{ title: 'Guided review ready', body: "Cora's pull request guided review is ready.", tag: 'review-ready-cora', data: { url: '/#agent=agent-1', kind: 'system', worktreeId: 'cora' } }]);
  await expect(reviewButton.locator('svg')).toHaveCSS('stroke', /rgb\((?!0, 0, 0)/u);
  await reviewButton.click();
  const dialog = page.getByRole('dialog', { name: 'Request routing tour' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('animation-name', 'review-tour-slide-up');
  await expect(dialog.getByText('All PR guided review')).toBeVisible();
  await expect(dialog.getByLabel('Tests')).not.toBeChecked();
  await expect(dialog.getByLabel('Docs')).not.toBeChecked();
  const toolbarBelowContent = await dialog.getByRole('group', { name: 'Tour content' }).evaluate((toolbar, content) => Boolean(content.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING), await dialog.locator('.review-tour-content').elementHandle());
  expect(toolbarBelowContent).toBe(true);
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  const reviewStep = dialog.locator('.review-tour-step');
  // measure the permanent review columns
  const desktopColumns = await reviewStep.evaluate(element => {
    const step = element.getBoundingClientRect();
    const narration = element.querySelector('.review-tour-narration')!.getBoundingClientRect();
    const files = element.querySelector('.review-tour-diffs')!.getBoundingClientRect();
    return { viewport: window.innerWidth, step: { left: step.left, right: step.right }, narration: { left: narration.left, right: narration.right, width: narration.width }, files: { left: files.left, right: files.right, width: files.width } };
  });
  expect(Math.abs(desktopColumns.step.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopColumns.narration.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopColumns.files.left - desktopColumns.narration.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopColumns.files.right - desktopColumns.viewport)).toBeLessThanOrEqual(1);
  expect(desktopColumns.files.width).toBeGreaterThan(desktopColumns.narration.width);
  const diffPane = dialog.getByLabel('Relevant changes');
  await expect.poll(async () => await diffPane.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(async () => await diffPane.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const widePatch = diffPane.locator('pre').first();
  await expect.poll(async () => await widePatch.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await widePatch.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(async () => await widePatch.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await diffPane.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(async () => await diffPane.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(diffPane.locator('.review-patch-line.hunk').first()).toBeVisible();
  await expect(diffPane.locator('.review-patch-line.addition').first()).toBeVisible();
  await expect(diffPane.locator('.review-patch-line.deletion').first()).toBeVisible();
  expect(await diffPane.locator('.review-patch-line.addition').first().evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  expect(jobRequests).toEqual([{ scope: 'pr', includeTests: false, includeDocs: false }]);
  const nextButton = dialog.getByRole('button', { name: 'Next' });
  const nextColors = await nextButton.evaluate(button => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--crust)';
    document.body.append(probe);
    const colors = [getComputedStyle(button).color, getComputedStyle(probe).color];
    probe.remove();
    return colors;
  });
  expect(nextColors[0]).toBe(nextColors[1]);
  const stepFeedback = dialog.getByLabel('Feedback for this change');
  await expect(dialog.getByText(/character limit reached/u)).toHaveCount(0);
  await stepFeedback.fill('x'.repeat(4_000));
  await expect(dialog.getByText('4,000 character limit reached')).toBeVisible();
  await stepFeedback.fill('');
  await expect(dialog.getByText(/character limit reached/u)).toHaveCount(0);
  await dialog.getByLabel('Tests').check();
  await expect.poll(() => jobRequests.length).toBe(2);
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  expect(jobRequests[1]).toEqual({ scope: 'pr', includeTests: true, includeDocs: false });
  await dialog.getByLabel('Tests').uncheck();
  await expect.poll(() => jobRequests.length).toBe(3);
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  expect(jobRequests[2]).toEqual({ scope: 'pr', includeTests: false, includeDocs: false });
  await dialog.getByLabel('Docs').check();
  await expect.poll(() => jobRequests.length).toBe(4);
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  expect(jobRequests[3]).toEqual({ scope: 'pr', includeTests: false, includeDocs: true });
  await dialog.getByLabel('Docs').uncheck();
  await expect.poll(() => jobRequests.length).toBe(5);
  await expect.poll(() => latestReadyJob).toBe(5);
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  expect(jobRequests[4]).toEqual({ scope: 'pr', includeTests: false, includeDocs: false });
  await expect(reviewButton).toHaveAttribute('aria-busy', 'false');

  await dialog.getByLabel('Feedback for this change').fill('Keep the route error copy aligned with the existing API.');
  snapshotFingerprint = 'snapshot-updated-567890';
  const previousFingerprintRequests = fingerprintRequests;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => fingerprintRequests).toBeGreaterThan(previousFingerprintRequests);
  await expect(dialog.getByText('Changes updated')).toBeVisible();
  await dialog.getByRole('button', { name: 'Minimize guided review' }).click();
  await expect(reviewButton).toHaveAttribute('aria-label', 'Open out-of-date guided review');
  await reviewButton.click();
  await expect(dialog.getByText('Changes updated')).toBeVisible();
  await dialog.getByRole('button', { name: 'Regenerate' }).click();
  await expect.poll(() => jobRequests.length).toBe(6);
  await expect(dialog.getByText('Step 1 of 2')).toBeVisible();
  await expect(dialog.getByLabel('Feedback for this change')).toHaveValue('Keep the route error copy aligned with the existing API.');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  // retain left narration and remaining-width files on mobile
  const mobileColumns = await reviewStep.evaluate(element => {
    const narration = element.querySelector('.review-tour-narration')!.getBoundingClientRect();
    const files = element.querySelector('.review-tour-diffs')!.getBoundingClientRect();
    return { viewport: window.innerWidth, narration: { left: narration.left, right: narration.right, width: narration.width }, files: { left: files.left, right: files.right, width: files.width } };
  });
  expect(Math.abs(mobileColumns.narration.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileColumns.files.left - mobileColumns.narration.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileColumns.files.right - mobileColumns.viewport)).toBeLessThanOrEqual(1);
  expect(mobileColumns.files.width).toBeGreaterThan(mobileColumns.narration.width);
  await expect(dialog.getByLabel('Feedback for this change')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Next' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('heading', { name: 'Apply the operation' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Review summary' }).click();
  await expect(dialog.getByRole('heading', { name: 'Review complete' })).toBeVisible();
  const draft = dialog.getByLabel('Consolidated change request');
  const originalDraft = await draft.inputValue();
  await expect(dialog.getByText(/character limit reached/u)).toHaveCount(0);
  await draft.fill('x'.repeat(30_000));
  await expect(dialog.getByText('30,000 character limit reached')).toBeVisible();
  await draft.fill(originalDraft);
  await expect(dialog.getByText(/character limit reached/u)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Send change request' }).click();
  const dispatchError = dialog.getByRole('alert');
  await expect(dispatchError).toHaveText('Shorten the change request before sending.');
  await expect(dispatchError).toBeFocused();
  await expect(draft).toHaveValue(/Keep the route error copy aligned with the existing API\./u);
  await dialog.getByRole('button', { name: 'Send change request' }).click();
  await expect(dialog.getByText('Change request sent to the implementation agent.')).toBeVisible();
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain('guided review of All PR changes against origin/main');
  expect(prompts[0]).toContain('Keep the route error copy aligned with the existing API.');

  await dialog.getByRole('button', { name: 'Finish' }).click();
  await expect(dialog).toBeHidden();
  await expect(reviewButton).toBeFocused();
  const cachedRequests = jobRequests.length;
  await reviewButton.click();
  await expect(dialog.getByRole('heading', { name: 'Review complete' })).toBeVisible();
  expect(jobRequests).toHaveLength(cachedRequests);
  await dialog.getByRole('button', { name: 'Minimize guided review' }).click();
});

test('restores the worktree review after reload and dismisses it when stale', async ({ page }) => {
  let reviewStored = true;
  let generationRequests = 0;
  const tour = { title: 'Persisted routing tour', overview: 'Resume the saved implementation walkthrough.', scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'stored-fingerprint-123456', changes: [{ id: 'chg_route0001', file: 'src/route.ts', category: 'implementation', kind: 'hunk', patch: '@@ -1 +1 @@\n-old\n+new' }], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route delegates to the service.', changeIds: ['chg_route0001'] }] };
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // connect the mocked agent stream
      constructor(url: string | URL) {
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          // seed the visible log
          if (this.url.includes('/ws/logs/')) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: 'Ready\n' }) }));
        });
      }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve the authenticated console fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, reviewTour: { available: true }, reviews: reviewStored ? [{ worktreeId: 'cora', branch: 'feature/review-tour', savedAt: '2026-08-08T18:00:00.000Z', title: tour.title, scope: tour.scope, includeTests: false, includeDocs: false, fingerprint: tour.fingerprint }] : [], agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', branch: 'feature/review-tour', title: 'Ready', gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 }, gitPrStatus: { base: 'origin/main', files: 1 } }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/skills') return route.fulfill({ json: { skills: [] } });
    // restore the durable artifact
    if (url.pathname === '/api/worktrees/cora/review-tour' && request.method() === 'GET') return route.fulfill({ json: { status: 'ready', review: { worktreeId: 'cora', branch: 'feature/review-tour', savedAt: '2026-08-08T18:00:00.000Z', tour } } });
    if (url.pathname === '/api/worktrees/cora/review-tour' && request.method() === 'DELETE') { reviewStored = false; return route.fulfill({ status: 204 }); }
    if (url.pathname === '/api/agents/agent-1/review-tour/fingerprint') return route.fulfill({ json: { status: 'snapshot', snapshot: { scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'newer-fingerprint-123456' } } });
    if (url.pathname === '/api/agents/agent-1/review-tour/jobs') { generationRequests += 1; return route.fulfill({ status: 500 }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const reviewButton = page.locator('.review-tour-toggle');
  await expect(reviewButton).toBeVisible();
  await page.getByRole('button', { name: /Git status: feature\/review-tour/ }).click();
  const statusPanel = page.getByRole('region', { name: 'Changed files' });
  await expect(statusPanel.getByRole('button', { name: 'Open Review' })).toBeVisible();
  await statusPanel.getByRole('button', { name: 'Open Review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Persisted routing tour' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Changes updated')).toBeVisible();
  expect(generationRequests).toBe(0);
  await dialog.getByRole('button', { name: 'Dismiss' }).click();
  await expect(dialog).toBeHidden();
  await expect(reviewButton).toBeHidden();

  await page.reload();
  await expect(page.locator('.review-tour-toggle')).toBeHidden();
  expect(generationRequests).toBe(0);
});
