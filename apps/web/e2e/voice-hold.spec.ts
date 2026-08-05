import { expect, test } from '@playwright/test';

test('latches dictation after a long press and stops only on tap, submit, or save', async ({ page }) => {
  let queued = 0;
  let saved = 0;
  await page.addInitScript(() => {
    const speech = { starts: 0, aborts: 0 };
    let active: {
      onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onend: (() => void) | null;
    } | undefined;
    class MockSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = '';
      onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      start() { speech.starts += 1; active = this; }
      abort() {
        speech.aborts += 1;
        if (active === this) active = undefined;
        this.onend?.();
      }
    }
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: MockSpeechRecognition });
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, '__speechState', { configurable: true, value: speech });
    Object.defineProperty(window, '__emitSpeech', { configurable: true, value: (transcript: string) => {
      active?.onresult?.({ resultIndex: 0, results: [[{ transcript }]] });
    } });
    Object.defineProperty(window, '__endSpeech', { configurable: true, value: () => {
      const ended = active;
      active = undefined;
      ended?.onend?.();
    } });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'POST') {
      saved += 1;
      const body = request.postDataJSON() as { prompt: string };
      return route.fulfill({ status: 201, json: { id: 'saved-prompt-001', text: body.prompt } });
    }
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queued += 1;
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toHaveAttribute('aria-description', 'Press and hold to start dictation. Tap again to stop.');
  await expect(page.getByRole('button', { name: /voice input/iu })).toHaveCount(0);

  const pointAtPrompt = async () => {
    const bounds = await prompt.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  };
  const startDictation = async (expectedStarts: number) => {
    await pointAtPrompt();
    await page.mouse.down();
    await page.waitForTimeout(550);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __speechState: { starts: number } }).__speechState.starts)).toBe(expectedStarts);
    await page.mouse.up();
    await expect(prompt).toHaveClass(/voice-listening/u);
  };

  await startDictation(1);
  await expect(prompt).toHaveCSS('border-top-color', 'rgb(243, 139, 168)');
  await expect(prompt).toHaveCSS('outline-style', 'none');
  await expect(prompt).toHaveCSS('animation-name', 'voice-listening');
  expect(await page.evaluate(() => (window as unknown as { __speechState: { aborts: number } }).__speechState.aborts)).toBe(0);

  await page.evaluate(() => (window as unknown as { __emitSpeech: (transcript: string) => void }).__emitSpeech('dictated prompt'));
  await expect(prompt).toHaveValue('dictated prompt');

  await page.evaluate(() => (window as unknown as { __endSpeech: () => void }).__endSpeech());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __speechState: { starts: number } }).__speechState.starts)).toBe(2);
  await expect(prompt).toHaveClass(/voice-listening/u);
  expect(await page.evaluate(() => (window as unknown as { __speechState: { aborts: number } }).__speechState.aborts)).toBe(0);

  await pointAtPrompt();
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __speechState: { aborts: number } }).__speechState.aborts)).toBe(1);
  await expect(prompt).not.toHaveClass(/voice-listening/u);

  await prompt.fill('queue this prompt');
  await startDictation(3);
  await prompt.press('Enter');
  await expect.poll(() => queued).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __speechState: { aborts: number } }).__speechState.aborts)).toBe(2);
  await expect(prompt).not.toHaveClass(/voice-listening/u);

  await startDictation(4);
  await page.evaluate(() => (window as unknown as { __emitSpeech: (transcript: string) => void }).__emitSpeech('save this prompt'));
  await expect(prompt).toHaveValue('save this prompt');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => saved).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __speechState: { aborts: number } }).__speechState.aborts)).toBe(3);
  await expect(prompt).not.toHaveClass(/voice-listening/u);
});
