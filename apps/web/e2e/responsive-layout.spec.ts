import { expect, test } from '@playwright/test';

test('keeps the active tab, output, and prompt controls inside a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 428, height: 952 });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({
      json: {
        generation: 1,
        agents: [
          { id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', displayLabel: '🥔 Cora', title: 'Ready' },
          { id: 'agent-2', sessionId: 'socket:$2', workspace: '/worktrees/owen', displayLabel: '🥔 Owen', title: 'Ready' },
          { id: 'agent-3', sessionId: 'socket:$3', workspace: '/worktrees/dave', displayLabel: '🥔 Dave', title: 'Ready' },
          { id: 'agent-4', sessionId: 'socket:$4', workspace: '/worktrees/eric', displayLabel: '🥔 Eric', title: 'Ready' },
          { id: 'agent-5', sessionId: 'socket:$5', workspace: '/worktrees/remote-agents', displayLabel: '📱 Remote Agents', title: 'Ready', projectUrl: 'https://project.example.com', stack: { actions: ['start', 'build'], tunnel: true }, pullRequest: { number: 42, title: 'Move the worktree tabs', status: 'open', url: 'https://github.com/octo/repo/pull/42' } }
        ],
        worktrees: []
      }
    });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (/^\/api\/agents\/agent-[1-5]\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/agent-[1-5]\/saved-prompts$/u.test(url.pathname) && request.method() === 'GET') return route.fulfill({ json: { prompts: [{ id: 'saved-1', text: 'Saved prompt' }] } });
    if (url.pathname === '/api/agents/agent-5/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const activeTab = page.getByRole('tab', { name: /^📱 Remote Agents/u });
  await activeTab.click();
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Live log')).toBeVisible();
  await page.locator('.log-topbar').evaluate(element => {
    const prompt = document.createElement('span');
    prompt.className = 'last-prompt';
    prompt.textContent = `Last prompt: ${'A deliberately long prompt that must remain on one line. '.repeat(8)}`;
    element.prepend(prompt);
  });

  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      activeTab: bounds('[role="tab"][aria-selected="true"]'),
      output: bounds('.log'),
      outputBorder: (() => {
        const style = getComputedStyle(document.querySelector<HTMLElement>('.log')!);
        return { top: style.borderTopWidth, bottom: style.borderBottomWidth };
      })(),
      outputFooter: bounds('.log-topbar'),
      lastPrompt: bounds('.last-prompt'),
      lastPromptStyle: (() => {
        const style = getComputedStyle(document.querySelector<HTMLElement>('.last-prompt')!);
        return { lineHeight: Number.parseFloat(style.lineHeight), whiteSpace: style.whiteSpace };
      })(),
      pullRequest: bounds('.pull-request-card'),
      tabs: bounds('.tabs'),
      prompt: bounds('.prompt'),
      promptActions: bounds('.prompt-actions'),
      controls: [...document.querySelectorAll<HTMLElement>('.prompt-actions button, .prompt-actions .project-open')].map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top };
      })
    };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.activeTab.left).toBeGreaterThanOrEqual(0);
  expect(layout.activeTab.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(Math.abs(layout.output.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.output.width - layout.viewportWidth)).toBeLessThanOrEqual(1);
  expect(layout.outputBorder).toEqual({ top: '0px', bottom: '1px' });
  expect(Math.abs(layout.outputFooter.top - layout.output.bottom)).toBeLessThanOrEqual(1);
  expect(layout.lastPrompt.height).toBeLessThanOrEqual(layout.lastPromptStyle.lineHeight + 1);
  expect(layout.lastPromptStyle.whiteSpace).toBe('nowrap');
  expect(Math.abs(layout.tabs.top - layout.outputFooter.bottom)).toBeLessThanOrEqual(1);
  await expect(page.locator('.log > .log-topbar')).toHaveCount(0);
  await expect(page.locator('.log + .log-topbar')).toHaveCount(1);
  expect(layout.pullRequest.top).toBeGreaterThanOrEqual(layout.tabs.bottom);
  expect(layout.pullRequest.bottom).toBeLessThanOrEqual(layout.prompt.top);
  expect(layout.controls.every(control => control.left >= 0 && control.right <= layout.viewportWidth)).toBe(true);
  const finalRowTop = Math.max(...layout.controls.map(control => control.top));
  const finalRowRight = Math.max(...layout.controls.filter(control => Math.abs(control.top - finalRowTop) < 1).map(control => control.right));
  expect(Math.abs(layout.promptActions.right - finalRowRight)).toBeLessThanOrEqual(1);
});
