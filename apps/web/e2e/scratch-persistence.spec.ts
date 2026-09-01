import { expect, test } from '@playwright/test';

// verify scratch persistence controls end to end
test('creates notes and bookmarks from a scratch agent', async ({ page }) => {
  test.setTimeout(45_000);
  const notes: Array<{ id: string; text: string }> = [];
  const bookmarks: Array<{ id: string; threadId: string; title: string; createdAt: string }> = [];
  const savedTexts: string[] = [];
  let createdNotes = 0;
  let bookmarkedCurrent = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve one controlled browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve one scratch agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'scratch-1', sessionId: 'socket:$1', workspace: '/home/ubuntu', displayLabel: '~ Scratch', title: 'Ready' }], projects: [] } });
    // disable optional browser services
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // authorize the scratch log stream
    if (url.pathname === '/api/agents/scratch-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return empty supporting prompt resources
    if (/^\/api\/agents\/scratch-1\/(?:saved-prompts|queued-prompts|prompt-history|skills|message-files)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [], files: [] } });
    // list scratch notes
    if (url.pathname === '/api/agents/scratch-1/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    // create one scratch note
    if (url.pathname === '/api/agents/scratch-1/notes' && request.method() === 'POST') {
      const note = { id: `note-identifier-00${++createdNotes}`, text: '' };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const noteMatch = /^\/api\/agents\/scratch-1\/notes\/([^/]+)$/u.exec(url.pathname);
    // autosave one scratch note
    if (noteMatch && request.method() === 'PUT') {
      const note = notes.find(candidate => candidate.id === noteMatch[1]);
      // require the created fixture note
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'note unavailable' } });
      note.text = (request.postDataJSON() as { text: string }).text;
      savedTexts.push(note.text);
      return route.fulfill({ json: note });
    }
    // list scratch bookmarks
    if (url.pathname === '/api/agents/scratch-1/bookmarks' && request.method() === 'GET') return route.fulfill({ json: { bookmarks, canResume: false } });
    // bookmark the current scratch chat
    if (url.pathname === '/api/agents/scratch-1/bookmarks' && request.method() === 'POST') {
      bookmarkedCurrent += 1;
      const bookmark = { id: 'bookmark-identifier-001', threadId: '0198c333-3333-7333-8333-333333333333', title: 'Scratch task', createdAt: '2026-08-25T20:00:00.000Z' };
      bookmarks.unshift(bookmark);
      return route.fulfill({ status: 201, json: bookmark });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/');
  const notesButton = page.locator('.notes-toggle');
  const bookmarksButton = page.locator('.bookmarks-toggle');
  await expect(notesButton).toBeVisible();
  await expect(notesButton).toHaveAccessibleName('Notes (0)');
  await expect(bookmarksButton).toBeVisible();
  await expect(bookmarksButton).toHaveAccessibleName('Bookmarked chats (0)');

  await notesButton.click();
  await page.getByRole('button', { name: '+ New note' }).click();
  await page.getByRole('textbox', { name: 'Note content' }).fill('Scratch checklist');
  await expect.poll(() => savedTexts).toContain('Scratch checklist');
  await expect(notesButton).toHaveAccessibleName('Notes (1)');

  await bookmarksButton.click();
  await page.getByRole('button', { name: 'Bookmark this chat' }).click();
  await expect.poll(() => bookmarkedCurrent).toBe(1);
  await expect(bookmarksButton).toHaveAccessibleName('Bookmarked chats (1)');
  await expect(page.getByText('Exact chat resume is not available for scratch agents.')).toBeVisible();
});
