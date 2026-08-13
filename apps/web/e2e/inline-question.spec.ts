import { expect, test } from '@playwright/test';

test('captures the selected first multi-select choice as a compact numbered agent question', async ({ page }) => {
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
  let selectedIndex: number | undefined;
  await page.addInitScript(({ questionOutput, viewportOutput }) => {
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
          if (this.url.includes('/ws/logs/')) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'reset', text: viewportOutput, latestAgentMessage: questionOutput }) }));
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
  }, { questionOutput: output, viewportOutput: visibleOutput });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Action required' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/question' && request.method() === 'POST') {
      selectedIndex = (request.postDataJSON() as { index: number }).index;
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
});
