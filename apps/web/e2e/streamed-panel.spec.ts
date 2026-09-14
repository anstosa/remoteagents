import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, pushQuestion, pushMetadata, pushExit, dropPane, paneConnectCount, paneInputText, paneFrameTypes, paneLastViewport, paneAckTotal } from './pane-stream-mock.js';

// The Agent panel over the Pane stream, at the app level: it mints a `pane` ticket, opens
// the pane socket, seeds and appends bytes, and sends the viewport/input/ack frames — plus
// the app wiring the component does not own (the question picker, metadata → notes). The
// component's own behaviour (scrolling, safety, font/theme, reconnect) is covered by
// streamed-terminal.spec.ts; this asserts the panel is wired to it.

const question = {
  id: 'question-deploy',
  text: 'Which deployment environment should receive this release?',
  choices: ['Staging', 'Production', 'Cancel'],
  source: 'parsed'
};

const routeApi = async (page: import('@playwright/test').Page, capture: { answers: { index: number; questionId: string }[]; prompts: { prompt: string }[] } = { answers: [], prompts: [] }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Working', attention: 'working', queuedPromptCount: 0 }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      capture.prompts.push(request.postDataJSON() as { prompt: string });
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/agents/agent-1/question' && request.method() === 'POST') {
      capture.answers.push(request.postDataJSON() as { index: number; questionId: string });
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

test('mints a pane ticket, seeds, appends bytes and sends viewport, input and ack frames', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');

  // The panel mounts and opens the pane socket; the first size lets the seed apply.
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'SEED-LINE\r\n');
  const log = page.getByLabel('Live log');
  await expect(log).toContainText('SEED-LINE');

  // Live bytes arrive after the seed, in order, and are acked as they are consumed.
  await pushBytes(page, 'agent-1', 'LIVE-LINE\r\n');
  await expect(log).toContainText('LIVE-LINE');
  await expect.poll(() => paneAckTotal(page, 'agent-1')).toBeGreaterThan(0);

  // The panel requested a grid (the Size claim) before the seed.
  expect(await paneLastViewport(page, 'agent-1')).toMatchObject({ cols: expect.any(Number), rows: expect.any(Number) });

  // Typing into the focused pane goes out as input frames.
  await log.locator('.xterm-screen').click();
  await page.keyboard.type('ls');
  await expect.poll(() => paneInputText(page, 'agent-1')).toContain('ls');
  expect(await paneFrameTypes(page, 'agent-1')).toContain('viewport');
});

test('a question frame shows the picker and answering posts through the question endpoint', async ({ page }) => {
  const capture = { answers: [] as { index: number; questionId: string }[], prompts: [] as { prompt: string }[] };
  await installPaneMock(page);
  await routeApi(page, capture);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');

  await pushQuestion(page, 'agent-1', question);
  await expect(page.getByText('Agent question')).toBeVisible();
  const choices = page.locator('.question-choice');
  await expect(choices).toHaveText(['1Staging', '2Production', '3Cancel']);
  await choices.nth(1).click();
  await expect.poll(() => capture.answers.length).toBe(1);
  expect(capture.answers[0]).toEqual({ index: 1, questionId: 'question-deploy' });
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // The optimistic dismissal holds while the derive still reports the same question.
  await pushQuestion(page, 'agent-1', question);
  await expect(page.getByText('Agent question')).toHaveCount(0);
  // A null question clears the dismissal: re-reporting the same question shows it again.
  await pushQuestion(page, 'agent-1', null);
  await expect(page.getByText('Agent question')).toHaveCount(0);
  await pushQuestion(page, 'agent-1', question);
  await expect(page.getByText('Agent question')).toBeVisible();
});

test('a metadata frame feeds Save latest response', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'done\r\n');

  const reply = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ');
  await pushMetadata(page, 'agent-1', reply, false);
  await page.getByRole('button', { name: /Notes/ }).click();
  await expect(page.getByRole('button', { name: 'Save latest response' })).toBeEnabled();
});

test('a dropped socket keeps the terminal mounted then reconnects', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'BEFORE-DROP\r\n');
  await expect(page.getByLabel('Live log')).toContainText('BEFORE-DROP');

  const before = await paneConnectCount(page, 'agent-1');
  await dropPane(page, 'agent-1', 1006, 'lost');
  // The component re-subscribes after its reconnect delay, minting a fresh ticket.
  await expect.poll(() => paneConnectCount(page, 'agent-1'), { timeout: 5000 }).toBeGreaterThan(before);
  await expect(page.getByLabel('Live log')).toBeVisible();

  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'AFTER-RECONNECT\r\n');
  await expect(page.getByLabel('Live log')).toContainText('AFTER-RECONNECT');
});

test('an exit shows the pane status and keeps the terminal mounted', async ({ page }) => {
  await installPaneMock(page);
  await routeApi(page);
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'live output\r\n');
  await pushExit(page, 'agent-1', 'pane closed');
  await expect(page.locator('.streamed-terminal-status')).toHaveText('pane closed');
  await expect(page.getByLabel('Live log').locator('.xterm')).toBeVisible();
});
