import { expect, test } from '@playwright/test';

test('keeps complete multi-select answers stable across viewport refreshes', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const output = [
    'Deployment',
    'Question 1/1',
    'Which strict-mode end state should govern this cleanup?',
    '› [x] 1. Global strict only (Recommended)   Set the UI project to strict.',
    '  [ ] 2. Keep targeted checker              Enable global strict with a targeted checker.',
    '  [ ] 3. Markers only',
    '  [ ] 4. None of the above                  Optionally type a different answer.',
    '↑↓ move · Enter select',
    ''
  ].join('\n');
  const visibleOutput = [
    'Which strict-mode end state should govern this cleanup?',
    '  [ ] 3. Markers only',
    '  [ ] 4. None of the above                  Optionally type a different answer.',
    '↑↓ move · Enter select',
    ''
  ].join('\n');
  const changedVisibleOutput = [
    'Which strict-mode end state should govern this cleanup?',
    '› [x] 3. Markers only',
    '  [ ] 4. None of the above                  Optionally type a different answer.',
    '↑↓ move · Enter select',
    ''
  ].join('\n');
  const wrappedVisibleOutput = [
    'Which strict-mode end state should govern',
    'this cleanup?',
    '› [x] 1. Global strict only (Recommended)',
    '        Set the UI project to strict.',
    '  [ ] 2. Keep targeted checker',
    '        Enable global strict with a targeted checker.',
    ''
  ].join('\n');
  const nextQuestionOutput = [
    'Which deployment environment should receive this release?',
    '› 1. Staging',
    '  2. Production',
    '  3. Cancel',
    ''
  ].join('\n');
  const combinedQuestionOutput = `${output}\n${nextQuestionOutput}`;
  const nextVisibleOutput = [
    'Which deployment environment should receive this release?',
    '› 1. Staging',
    '  2. Production',
    ''
  ].join('\n');
  let selectedIndex: number | undefined;
  let answerCount = 0;
  let completedAnswers = 0;
  let releasePendingAnswer: (() => void) | undefined;
  await page.addInitScript(({ questionOutput, viewportOutput, changedViewportOutput, wrappedViewportOutput }) => {
    const logSockets: MockWebSocket[] = [];
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
      readonly sent: string[] = [];
      constructor(url: string | URL) {
        this.url = String(url);
        window.setTimeout(() => {
          if (this.readyState !== MockWebSocket.CONNECTING) return;
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          // publish complete question metadata
          if (this.url.includes('/ws/logs/')) {
            logSockets.push(this);
            const firstAgent = this.url.includes('/agent-1');
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(firstAgent
              ? { type: 'reset', text: viewportOutput, metadata: { state: 'complete', latestAgentMessage: questionOutput, latestAssistantMessage: null, latestAssistantMessageOverflows: false } }
              : { type: 'reset', text: 'Second agent ready\n', metadata: { state: 'complete', latestAgentMessage: null, latestAssistantMessage: null, latestAssistantMessageOverflows: false } }) }));
            // expose one cheap viewport refresh
            Object.assign(window, {
              emitQuestionFrame: (frame: object) => logSockets.filter(socket => socket.url.includes('/agent-1')).forEach(socket => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }))),
              metadataRequestCount: () => logSockets.filter(socket => socket.url.includes('/agent-1')).flatMap(socket => socket.sent).filter(value => (JSON.parse(value) as { type?: string }).type === 'metadata').length,
              refreshQuestionViewport: () => logSockets.filter(socket => socket.url.includes('/agent-1')).forEach(socket => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: changedViewportOutput }) }))),
              wrapQuestionViewport: () => logSockets.filter(socket => socket.url.includes('/agent-1')).forEach(socket => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: wrappedViewportOutput }) })))
            });
          }
        });
      }
      // retain client protocol messages
      send(value: string) { this.sent.push(value); }
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  }, { questionOutput: output, viewportOutput: visibleOutput, changedViewportOutput: changedVisibleOutput, wrappedViewportOutput: wrappedVisibleOutput });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Action required', attention: 'question' }, { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/owen', title: 'Ready', attention: 'finished' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/prompt-history$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/question' && request.method() === 'POST') {
      selectedIndex = (request.postDataJSON() as { index: number }).index;
      answerCount += 1;
      // hold the second answer through a replacement question
      if (answerCount === 2) await new Promise<void>(resolve => { releasePendingAnswer = resolve; });
      completedAnswers += 1;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByText('Agent question')).toBeVisible();
  await expect(page.locator('.question-copy')).toContainText('Which strict-mode end state should govern this cleanup?');
  const choices = page.locator('.question-choice');
  await expect(choices).toHaveCount(4);
  await expect(choices).toHaveText([
    '1Global strict only (Recommended)   Set the UI project to strict.',
    '2Keep targeted checker              Enable global strict with a targeted checker.',
    '3Markers only',
    '4None of the above                  Optionally type a different answer.'
  ]);
  // retain complete answers across tmux wrapping
  await page.evaluate(async () => {
    (window as unknown as { wrapQuestionViewport: () => void }).wrapQuestionViewport();
    // wait through deferred question analysis
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  });
  await expect(choices).toHaveCount(4);
  await expect(choices).toHaveText([
    '1Global strict only (Recommended)   Set the UI project to strict.',
    '2Keep targeted checker              Enable global strict with a targeted checker.',
    '3Markers only',
    '4None of the above                  Optionally type a different answer.'
  ]);
  // retain complete answers across cheap refreshes
  await page.evaluate(async () => {
    (window as unknown as { refreshQuestionViewport: () => void }).refreshQuestionViewport();
    // wait through deferred question analysis
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  });
  await expect(choices).toHaveCount(4);
  await expect(choices).toHaveText([
    '1Global strict only (Recommended)   Set the UI project to strict.',
    '2Keep targeted checker              Enable global strict with a targeted checker.',
    '3Markers only',
    '4None of the above                  Optionally type a different answer.'
  ]);
  await expect(choices.nth(0)).toHaveCSS('font-size', '11.52px');
  await expect(choices.nth(0)).toHaveCSS('display', 'grid');
  const numberBounds = await choices.nth(0).locator('b').boundingBox();
  expect(numberBounds!.width).toBeGreaterThanOrEqual(22);
  // capture relative question geometry
  const layout = await choices.evaluateAll(buttons => buttons.map(button => {
    const buttonBounds = button.getBoundingClientRect();
    const numberBounds = button.querySelector('b')!.getBoundingClientRect();
    const answerBounds = button.querySelector('span')!.getBoundingClientRect();
    return {
      height: buttonBounds.height,
      numberTop: numberBounds.top - buttonBounds.top,
      numberLeft: numberBounds.left - buttonBounds.left,
      numberBottomSpace: buttonBounds.bottom - numberBounds.bottom,
      answerCenter: answerBounds.top + answerBounds.height / 2 - buttonBounds.top - buttonBounds.height / 2
    };
  }));
  const wrapped = layout[1]!;
  const short = layout[2]!;
  expect(wrapped.height).toBeGreaterThan(short.height);
  // keep every number pinned while centering its answer
  for (const choice of layout) {
    expect(choice.numberTop).toBeCloseTo(layout[0]!.numberTop, 1);
    expect(choice.numberLeft).toBeCloseTo(layout[0]!.numberLeft, 1);
    expect(choice.answerCenter).toBeCloseTo(0, 1);
  }
  expect(wrapped.numberBottomSpace).toBeGreaterThan(short.numberBottomSpace);
  await choices.nth(1).click();
  await expect.poll(() => selectedIndex).toBe(1);
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // ignore an authoritative capture that raced the pane redraw
  await page.evaluate(async ({ text, complete }) => {
    (window as unknown as { emitQuestionFrame: (frame: object) => void }).emitQuestionFrame({ type: 'reset', text, metadata: { state: 'complete', latestAgentMessage: complete, latestAssistantMessage: null, latestAssistantMessageOverflows: false } });
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  }, { text: wrappedVisibleOutput, complete: output });
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // retain the dismissal across tab remounts
  const tabs = page.getByRole('tab');
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // cross a no-question generation before repeating the same question
  await page.evaluate(async () => {
    (window as unknown as { emitQuestionFrame: (frame: object) => void }).emitQuestionFrame({ type: 'reset', text: '• Working on the selected cleanup\n' });
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  });
  await expect(page.getByText('Agent question')).toHaveCount(0);
  await page.evaluate(async ({ text }) => {
    (window as unknown as { emitQuestionFrame: (frame: object) => void }).emitQuestionFrame({ type: 'reset', text });
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  }, { text: wrappedVisibleOutput });
  await expect(page.locator('.question-copy')).toContainText('this cleanup?');
  await expect(choices).toHaveCount(2);

  // keep a replacement visible while a partial prior answer resolves
  selectedIndex = undefined;
  await choices.nth(1).click();
  await expect.poll(() => answerCount).toBe(2);

  // replace a visibly different question immediately
  await page.evaluate(async ({ text }) => {
    (window as unknown as { emitQuestionFrame: (frame: object) => void }).emitQuestionFrame({ type: 'reset', text });
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  }, { text: nextVisibleOutput });
  await expect(page.locator('.question-copy')).toContainText('Which deployment environment should receive this release?');
  await expect(choices).toHaveText(['1Staging', '2Production']);
  await expect.poll(() => typeof releasePendingAnswer).toBe('function');
  releasePendingAnswer!();
  await expect.poll(() => completedAnswers).toBe(2);
  await expect(page.locator('.question-copy')).toContainText('Which deployment environment should receive this release?');

  // ignore stale metadata from the answered question
  await page.evaluate(({ text, complete }) => (window as unknown as { emitQuestionFrame: (frame: object) => void }).emitQuestionFrame({ type: 'reset', text, metadata: { state: 'complete', latestAgentMessage: complete, latestAssistantMessage: null, latestAssistantMessageOverflows: false } }), { text: nextVisibleOutput, complete: output });
  await expect(page.locator('.question-copy')).toContainText('Which deployment environment should receive this release?');

  // expand the replacement from authoritative metadata
  await page.evaluate(({ text, complete }) => (window as unknown as { emitQuestionFrame: (frame: object) => void }).emitQuestionFrame({ type: 'reset', text, metadata: { state: 'complete', latestAgentMessage: complete, latestAssistantMessage: null, latestAssistantMessageOverflows: false } }), { text: nextVisibleOutput, complete: combinedQuestionOutput });
  await expect(choices).toHaveText(['1Staging', '2Production', '3Cancel']);
  const refreshesBeforeWorking = await page.evaluate(() => (window as unknown as { metadataRequestCount: () => number }).metadataRequestCount());

  // remove stale choices when the pane moves on
  await page.evaluate(async () => {
    (window as unknown as { emitQuestionFrame: (frame: object) => void }).emitQuestionFrame({ type: 'reset', text: '• Working on the selected deployment\n' });
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  });
  await expect(page.getByText('Agent question')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { metadataRequestCount: () => number }).metadataRequestCount())).toBeGreaterThan(refreshesBeforeWorking);

  // clear both cached and live state on an authoritative empty reset
  await page.evaluate(async () => {
    (window as unknown as { emitQuestionFrame: (frame: object) => void }).emitQuestionFrame({ type: 'reset', text: '', metadata: { state: 'complete', latestAgentMessage: null, latestAssistantMessage: null, latestAssistantMessageOverflows: false } });
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  });
  await expect(page.getByText('Agent question')).toHaveCount(0);
  await expect(page.locator('.terminal-frame.active .xterm-rows')).not.toContainText('Working on the selected deployment');
});
