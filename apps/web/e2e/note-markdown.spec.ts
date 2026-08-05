import { expect, test } from '@playwright/test';

test('renders saved notes as markdown and focuses into source editing', async ({ page }) => {
  const markdown = [
    '# Release notes',
    '',
    'Review **carefully** and use [the guide](https://example.com/docs).',
    '',
    '- First item',
    '- [x] Verified',
    '',
    '> Important',
    '',
    '```ts',
    'const ready = true;',
    '```',
    '',
    '<script>window.__noteScriptRan = true</script>',
    '',
    ' Area                 Your console        Competitive',
    '                                          position',
    '━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━',
    ' Remote/mobile        Browser, PWA,       Strong; better',
    ' supervision          voice, software     than most',
    '                      keyboard, push      terminal-only',
    '                      alerts              tools',
    '───────────────────  ──────────────────  ───────────────────',
    ' Existing-session     Automatically       Major advantage;',
    ' discovery            finds Codex/OMX     many competitors',
    '                      tmux sessions       only understand',
    '                                          sessions they',
    '                                          created',
    '───────────────────  ──────────────────  ───────────────────',
    ' Durable history      Notes and saved     Behind',
    '                      prompts'
  ].join('\n');
  const note = { id: 'note-identifier-001', text: markdown };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [note] } });
    if (url.pathname === `/api/worktrees/cora/notes/${note.id}` && request.method() === 'PUT') {
      note.text = (request.postDataJSON() as { text: string }).text;
      return route.fulfill({ json: note });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await page.locator('.notes-menu .note-choice').click();

  const preview = page.getByLabel('Note preview');
  await expect(preview).toBeVisible();
  const outputFontSize = await page.locator('.terminal-frame.active .xterm').evaluate(element => getComputedStyle(element).fontSize);
  await expect(preview).toHaveCSS('font-size', outputFontSize);
  await expect(page.getByRole('textbox', { name: 'Note content' })).toHaveCount(0);
  await expect(preview.getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();
  await expect(preview.locator('strong')).toHaveText('carefully');
  await expect(preview.getByRole('link', { name: 'the guide' })).toHaveAttribute('href', 'https://example.com/docs');
  await expect(preview.getByRole('listitem')).toHaveCount(2);
  await expect(preview.getByRole('checkbox')).toBeChecked();
  await expect(preview.locator('blockquote')).toHaveText('Important');
  await expect(preview.locator('pre code')).toHaveText('const ready = true;');
  await expect(preview).toContainText('<script>window.__noteScriptRan = true</script>');
  await expect(page.locator('.note-markdown script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __noteScriptRan?: boolean }).__noteScriptRan)).toBeUndefined();
  const table = preview.getByRole('table');
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText(['Area', 'Your console', 'Competitive position']);
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('row').nth(1).getByRole('cell')).toHaveText(['Remote/mobile supervision', 'Browser, PWA, voice, software keyboard, push alerts', 'Strong; better than most terminal-only tools']);
  await expect(table.getByRole('row').nth(2).getByRole('cell')).toHaveText(['Existing-session discovery', 'Automatically finds Codex/OMX tmux sessions', 'Major advantage; many competitors only understand sessions they created']);
  await expect(table.getByRole('row').nth(3).getByRole('cell')).toHaveText(['Durable history', 'Notes and saved prompts', 'Behind']);

  await preview.click();
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveCSS('font-size', outputFontSize);
  await expect(editor).toHaveValue(markdown);
  await page.getByRole('button', { name: 'Copy note' }).focus();
  await expect(preview).toBeVisible();
});
