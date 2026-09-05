import { expect, test } from '@playwright/test';

// The server now parses inline questions from the viewed agent's capture and
// sends the current one on each authoritative metadata frame. The web renders
// what it is given and no longer parses pane text, so this spec feeds `question`
// through the stubbed metadata payload rather than through terminal output.

const strictQuestion = {
  id: 'question-strict',
  text: 'Which strict-mode end state should govern this cleanup?',
  choices: [
    'Global strict only (Recommended)   Set the UI project to strict.',
    'Keep targeted checker              Enable global strict with a targeted checker.',
    'Markers only',
    'None of the above                  Optionally type a different answer.'
  ],
  source: 'parsed'
};
const deployQuestion = {
  id: 'question-deploy',
  text: 'Which deployment environment should receive this release?',
  choices: ['Staging', 'Production', 'Cancel'],
  source: 'parsed'
};
const modelQuestion = {
  id: 'question-model',
  text: 'Select Model and Effort',
  choices: [
    'gpt-6-astra (current)  Our most capable model for complex, demanding work.',
    'gpt-5.6-sol            Reliable agentic workhorse for everyday tasks.',
    'gpt-5.6-terra          Balanced agentic coding model for everyday work.',
    'gpt-5.6-luna           Fast and affordable agentic coding model.',
    'gpt-5.5                Proven previous-generation model for coding and general work.',
    'gpt-5.4-mini           Small, fast, and cost-efficient model for simpler coding tasks.',
    'gpt-5.3-codex-spark    Ultra-fast coding model.'
  ],
  source: 'parsed'
};

test('renders inline questions from the metadata payload and answers through one endpoint', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  let selectedIndex: number | undefined;
  let selectedQuestionId: string | undefined;
  let answerCount = 0;
  const submittedPrompts: Array<{ prompt: string; attachments: unknown[] }> = [];
  await page.addInitScript(({ firstQuestion }) => {
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
          if (this.url.includes('/ws/logs/')) {
            logSockets.push(this);
            const firstAgent = this.url.includes('/agent-1');
            // the server delivers the parsed question at the frame top level
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(firstAgent
              ? { type: 'reset', text: 'Action required\n', question: firstQuestion, metadata: { state: 'complete', latestAgentMessage: null, latestAssistantMessage: null, latestAssistantMessageOverflows: false } }
              : { type: 'reset', text: 'Second agent ready\n', metadata: { state: 'complete', latestAgentMessage: null, latestAssistantMessage: null, latestAssistantMessageOverflows: false } }) }));
            // emit an arbitrary later frame to agent-1's log socket
            Object.assign(window, {
              emitQuestionFrame: (frame: object) => logSockets.filter(socket => socket.url.includes('/agent-1')).forEach(socket => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })))
            });
          }
        });
      }
      send(value: string) { this.sent.push(value); }
      close() {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  }, { firstQuestion: strictQuestion });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Action required', attention: 'question' }, { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/owen', title: 'Ready', attention: 'finished' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/prompt-history$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // capture notes and false-positive prompts
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      submittedPrompts.push(request.postDataJSON() as { prompt: string; attachments: unknown[] });
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/agents/agent-1/question' && request.method() === 'POST') {
      const body = request.postDataJSON() as { index: number; questionId: string };
      selectedIndex = body.index;
      selectedQuestionId = body.questionId;
      answerCount += 1;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  const emit = (frame: object) => page.evaluate(async payload => {
    (window as unknown as { emitQuestionFrame: (frame: object) => void }).emitQuestionFrame(payload);
    // wait through deferred question analysis
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  }, frame);
  // a cheap viewport frame carries no metadata; the question rides it at the top
  // level. Its text mirrors the pane (which changes with the question), because the
  // server only emits a frame when the pane output actually changed.
  const cheapFrame = (question?: { text: string }) => ({ type: 'reset', text: `${question ? question.text : 'Working on the task'}\n`, ...(question === undefined ? {} : { question }) });

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
  // the numbered-choice layout is unchanged: numbers pinned, answers centered
  await expect(choices.nth(0)).toHaveCSS('display', 'grid');
  const numberBounds = await choices.nth(0).locator('b').boundingBox();
  expect(numberBounds!.width).toBeGreaterThanOrEqual(22);
  const layout = await choices.evaluateAll(buttons => buttons.map(button => {
    const buttonBounds = button.getBoundingClientRect();
    const numberBounds = button.querySelector('b')!.getBoundingClientRect();
    const answerBounds = button.querySelector('span')!.getBoundingClientRect();
    return {
      height: buttonBounds.height,
      numberTop: numberBounds.top - buttonBounds.top,
      numberLeft: numberBounds.left - buttonBounds.left,
      answerCenter: answerBounds.top + answerBounds.height / 2 - buttonBounds.top - buttonBounds.height / 2
    };
  }));
  expect(layout[1]!.height).toBeGreaterThan(layout[2]!.height);
  for (const choice of layout) {
    expect(choice.numberTop).toBeCloseTo(layout[0]!.numberTop, 1);
    expect(choice.numberLeft).toBeCloseTo(layout[0]!.numberLeft, 1);
    expect(choice.answerCenter).toBeCloseTo(0, 1);
  }

  // expanded notes use the existing prompt submission path
  const notesToggle = page.getByRole('button', { name: 'Add notes' });
  await expect(notesToggle).toHaveAttribute('aria-expanded', 'false');
  await notesToggle.click();
  const notes = page.getByRole('textbox', { name: 'Answer notes' });
  await expect(notes).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide notes' })).toHaveAttribute('aria-expanded', 'true');
  await notes.fill('Keep the cleanup scoped to the selected option.');
  await page.getByRole('button', { name: 'Submit notes' }).click();
  await expect.poll(() => submittedPrompts.length).toBe(1);
  expect(submittedPrompts[0]).toEqual({ prompt: 'Keep the cleanup scoped to the selected option.', attachments: [] });
  await expect(notes).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Switch to normal prompt mode' })).toBeVisible();

  // normal mode remains available when detection is a false positive
  await page.getByRole('button', { name: 'Switch to normal prompt mode' }).click();
  await expect(page.getByRole('button', { name: 'Switch to answer mode' })).toBeVisible();
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Treat the detected question as ordinary output.');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(() => submittedPrompts.length).toBe(2);
  expect(submittedPrompts[1]).toEqual({ prompt: 'Treat the detected question as ordinary output.', attachments: [] });
  await page.getByRole('button', { name: 'Switch to answer mode' }).click();
  await expect(page.getByRole('button', { name: 'Switch to normal prompt mode' })).toBeVisible();

  // answering posts the question id and the chosen index through the one endpoint
  await choices.nth(1).click();
  await expect.poll(() => selectedIndex).toBe(1);
  expect(selectedQuestionId).toBe(strictQuestion.id);
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // the optimistic dismissal holds while a cheap frame still reports the same question
  await emit(cheapFrame(strictQuestion));
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // and survives a tab remount
  const tabs = page.getByRole('tab');
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // a frame carrying no question clears the dismissal
  await emit(cheapFrame());
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // extracted controls must not shrink their source viewport
  const liveLog = page.getByLabel('Live log');
  const normalLogHeight = await liveLog.evaluate(element => element.getBoundingClientRect().height);
  await emit(cheapFrame(modelQuestion));
  await expect(page.getByRole('region', { name: 'Agent question' })).toContainText('Select Model and Effort');
  await expect(choices).toHaveCount(7);
  const modelLogHeight = await liveLog.evaluate(element => element.getBoundingClientRect().height);
  expect(modelLogHeight).toBeGreaterThanOrEqual(normalLogHeight);
  selectedIndex = undefined;
  await choices.nth(1).click();
  await expect.poll(() => selectedIndex).toBe(1);
  expect(selectedQuestionId).toBe(modelQuestion.id);

  // a new question (a different id) arriving on a cheap frame — no metadata, so it
  // must ride the frame itself — is shown promptly and answered on its own id
  await emit(cheapFrame(deployQuestion));
  await expect(page.locator('.question-copy')).toContainText('Which deployment environment should receive this release?');
  await expect(choices).toHaveText(['1Staging', '2Production', '3Cancel']);
  selectedIndex = undefined;
  await choices.nth(2).click();
  await expect.poll(() => selectedIndex).toBe(2);
  expect(selectedQuestionId).toBe(deployQuestion.id);
  await expect.poll(() => answerCount).toBe(3);
  await expect(page.getByText('Agent question')).toHaveCount(0);
});
