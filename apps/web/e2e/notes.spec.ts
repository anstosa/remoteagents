import { expect, test } from '@playwright/test';

test('creates, previews, edits, autosaves, and deletes per-worktree notes', async ({ page }) => {
  test.setTimeout(60_000);
  const notes: Array<{ id: string; text: string }> = [];
  const savedTexts: string[] = [];
  let created = 0;
  let failNextSave = false;
  let failedSaves = 0;
  let failNextDelete = false;
  let failedDeletes = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }], worktrees: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'POST') {
      const note = { id: `note-identifier-00${++created}`, text: '' };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const noteMatch = /^\/api\/worktrees\/cora\/notes\/([^/]+)$/u.exec(url.pathname);
    if (noteMatch && request.method() === 'PUT') {
      const payload = request.postDataJSON() as { text: string };
      if (failNextSave) {
        failNextSave = false;
        failedSaves += 1;
        return route.fulfill({ status: 503, json: { error: 'temporary failure' } });
      }
      const note = notes.find(candidate => candidate.id === noteMatch[1]);
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      note.text = payload.text;
      savedTexts.push(payload.text);
      return route.fulfill({ json: note });
    }
    if (noteMatch && request.method() === 'DELETE') {
      if (failNextDelete) {
        failNextDelete = false;
        failedDeletes += 1;
        return route.fulfill({ status: 503, json: { error: 'temporary failure' } });
      }
      const index = notes.findIndex(candidate => candidate.id === noteMatch[1]);
      if (index < 0) return route.fulfill({ status: 404, json: { error: 'missing' } });
      return route.fulfill({ json: notes.splice(index, 1)[0] });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const notesButton = page.getByRole('button', { name: 'Notes' });
  const pageUp = page.getByRole('button', { name: 'Page up' });
  await expect(notesButton).toBeVisible();
  await expect(notesButton).toHaveAccessibleName('Notes (0)');
  await expect(notesButton.locator('.notes-icon-sheet')).toHaveAttribute('d', 'M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z');
  const [notesBounds, pageUpBounds] = await Promise.all([notesButton.boundingBox(), pageUp.boundingBox()]);
  expect(notesBounds!.y).toBeLessThan(pageUpBounds!.y);

  await notesButton.click();
  const pane = page.getByRole('dialog', { name: 'Worktree note' });
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await expect(pane).toBeVisible();
  await expect(notesButton.locator('.notes-count')).toHaveText('1');
  await expect(editor).toHaveValue('');
  await pane.evaluate(async element => await Promise.all(element.getAnimations().map(animation => animation.finished)));
  const [paneBounds, outputBounds] = await Promise.all([pane.boundingBox(), page.locator('.log').boundingBox()]);
  expect(paneBounds!.y).toBeCloseTo(outputBounds!.y, 0);
  expect(paneBounds!.height / outputBounds!.height).toBeGreaterThan(0.45);
  expect(paneBounds!.height / outputBounds!.height).toBeLessThan(0.55);

  await editor.fill('Remember to review the migration plan carefully');
  await expect.poll(() => savedTexts).toContain('Remember to review the migration plan carefully');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await editor.fill('Remember to review the migration plan carefully before unload');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => savedTexts).toContain('Remember to review the migration plan carefully before unload');
  await page.getByRole('button', { name: 'Close note' }).click();
  await expect(pane).toHaveCount(0);
  await expect(notesButton).toBeFocused();

  await notesButton.click();
  await expect(page.getByRole('button', { name: 'Remember to review the migration plan…' })).toBeVisible();
  await page.getByRole('button', { name: '+ New note' }).click();
  failNextSave = true;
  await editor.fill('Second useful reminder');
  await page.getByRole('button', { name: 'Close note' }).click();
  await expect.poll(() => failedSaves).toBe(1);

  await notesButton.click();
  await page.getByRole('button', { name: 'Second useful reminder…' }).click();
  await expect.poll(() => savedTexts).toContain('Second useful reminder');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await editor.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(notesButton).toBeFocused();

  await notesButton.click();
  await expect(page.locator('.notes-menu .note-choice')).toHaveCount(2);
  await expect(notesButton.locator('.notes-count')).toHaveText('2');
  await page.getByRole('button', { name: 'Second useful reminder…' }).click();
  await expect(editor).toHaveValue('Second useful reminder');
  failNextSave = true;
  await editor.fill('Second useful reminder with a dirty delete');
  await expect.poll(() => failedSaves).toBe(2);
  failNextDelete = true;
  await page.getByRole('button', { name: 'Delete note' }).click();
  await expect.poll(() => failedDeletes).toBe(1);
  await expect(page.getByText('Unable to save', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notes (2; 1 unsaved)' })).toBeVisible();
  await page.getByRole('button', { name: 'Close note' }).click();
  await notesButton.click();
  await page.getByRole('button', { name: 'Second useful reminder with a dirty…' }).click();
  await expect(editor).toHaveValue('Second useful reminder with a dirty delete');
  await expect.poll(() => savedTexts).toContain('Second useful reminder with a dirty delete');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete note' }).click();
  await expect(pane).toHaveCount(0);
  await expect(notesButton).toBeFocused();
  await expect(notesButton.locator('.notes-count')).toHaveText('1');
  expect(notes).toEqual([{ id: 'note-identifier-001', text: 'Remember to review the migration plan carefully before unload' }]);
});
