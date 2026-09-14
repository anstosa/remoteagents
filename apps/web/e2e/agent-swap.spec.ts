import { expect, test } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, paneInputList } from './pane-stream-mock.js';

// Swap to terminal still backgrounds the agent and shows its pane, but the pane now
// streams over a single `/ws/pane/:id` socket: there is no separate logs/input socket and
// no `terminal` ticket kind. Typed Enter in the swapped composer and a blank Enter from
// the normal composer forward as pane input, not a prompt POST.

test('backgrounds an idle agent and swaps the output area to its streamed pane', async ({ page }) => {
  const ticketKinds: string[] = [];
  let backgroundRequests = 0;
  let foregroundRequests = 0;
  let promptRequests = 0;
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready', kind: 'codex', attention: 'finished', queuedPromptCount: 0 }, { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/delta', title: 'Second', kind: 'claude', attention: 'finished', queuedPromptCount: 0 }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/background') { backgroundRequests += 1; return route.fulfill({ status: 204 }); }
    if (url.pathname === '/api/agents/agent-1/foreground') { foregroundRequests += 1; return route.fulfill({ status: 204 }); }
    if (url.pathname === '/api/agents/agent-1/prompt') { promptRequests += 1; return route.fulfill({ status: 204 }); }
    if (/^\/api\/agents\/agent-[12]\/prompt-history$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/tickets$/u.test(url.pathname)) {
      const payload = request.postDataJSON() as { kind?: unknown };
      if (typeof payload.kind === 'string') ticketKinds.push(payload.kind);
      return route.fulfill({ json: { ticket: `${String(payload.kind)}-ticket` } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Ready\r\n');
  await expect(page.getByRole('button', { name: 'Open terminal' })).toHaveCount(0);
  await expect(page.locator('.prompt-actions > .swap-agent')).toHaveCount(0);
  const swapFromMenu = async () => {
    await page.getByRole('button', { name: 'More options' }).click();
    const swap = page.locator('.more-menu').getByRole('button', { name: 'Swap to terminal' });
    await expect(swap).toBeEnabled();
    await expect(swap.locator('.more-menu-icon')).toHaveCount(1);
    await swap.click();
  };
  await swapFromMenu();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Interactive agent pane')).toBeVisible();
  const returnToAgent = page.getByRole('button', { name: 'Return to agent output' });
  await expect(returnToAgent).toBeVisible();
  await expect(returnToAgent).toHaveClass(/swap-agent/u);
  await expect(page.getByRole('button', { name: 'Swap to terminal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Queue' })).toHaveCount(0);
  await expect.poll(() => backgroundRequests).toBe(1);
  // The swapped pane streams over one socket the moment it opens.
  await seedPaneSize(page, 'agent-1', 80, 24);

  const enter = page.getByRole('button', { name: 'Enter', exact: true });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(enter).toBeEnabled();
  await prompt.fill('printf terminal-mode');
  await enter.click();
  await expect(prompt).toHaveValue('');
  await expect.poll(() => paneInputList(page, 'agent-1')).toEqual(['printf terminal-mode\r']);
  await enter.click();
  await expect.poll(() => paneInputList(page, 'agent-1')).toEqual(['printf terminal-mode\r', '\r']);
  expect(promptRequests).toBe(0);

  // The panel opens one pane socket per view: it mints only `pane` tickets, never the retired
  // `logs` (snapshot poll / dashboard prefetch), `input` (separate input socket) or `terminal`
  // (swap) kinds.
  expect(ticketKinds).toContain('pane');
  expect(ticketKinds).not.toContain('logs');
  expect(ticketKinds).not.toContain('terminal');
  expect(ticketKinds).not.toContain('input');

  await returnToAgent.click();
  await expect(page.getByLabel('Live log')).toBeVisible();
  await expect.poll(() => foregroundRequests).toBe(1);
  await seedPaneSize(page, 'agent-1', 80, 24);

  // A blank Enter from the normal composer forwards to the pane, not a prompt POST.
  await prompt.press('Enter');
  await expect.poll(() => paneInputList(page, 'agent-1')).toEqual(['printf terminal-mode\r', '\r', '\r']);
  expect(promptRequests).toBe(0);

  await swapFromMenu();
  await expect(page.getByLabel('Interactive agent pane')).toBeVisible();
  await expect.poll(() => backgroundRequests).toBe(2);
  await page.getByRole('tab', { name: /^Second/u }).click();
  await expect(page.getByLabel('Live log')).toBeVisible();
  await expect.poll(() => foregroundRequests).toBe(2);
});
