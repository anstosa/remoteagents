import { expect, test } from '@playwright/test';

// require one rendered element box
function requireBounds(bounds: { x: number; y: number; width: number; height: number } | null, label: string): asserts bounds is { x: number; y: number; width: number; height: number } {
  expect(bounds, `${label} bounds`).not.toBeNull();
  // fail with one precise element label
  if (bounds === null) throw new Error(`${label} bounds unavailable`);
}

test('bookmarks the current chat above notes and resumes a selected bookmark', async ({ page }) => {
  const originalTitle = 'Review the release migration plan and confirm every regional deployment, rollback, and support handoff before launch';
  const bookmarks = [{ id: 'bookmark-identifier-001', threadId: '0198c333-3333-7333-8333-333333333333', title: originalTitle, createdAt: '2026-08-20T20:00:00.000Z' }];
  let currentBookmarkId: string | undefined = 'bookmark-identifier-001';
  let bookmarkedCurrent = 0;
  let renamedBookmark = '';
  let deletedBookmark = '';
  let switchedBookmark = '';
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve one controlled browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve one idle agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], worktrees: [] } });
    // disable optional browser services
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    // serve the shared note and bookmark groups
    if (url.pathname === '/api/worktrees/cora/notes' && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/cora/bookmarks' && request.method() === 'GET') {
      return route.fulfill({ json: { bookmarks, canResume: true, currentBookmarkId } });
    }
    // bookmark the current chat
    if (url.pathname === '/api/agents/agent-1/bookmarks' && request.method() === 'POST') {
      bookmarkedCurrent += 1;
      const saved = { id: 'bookmark-identifier-002', threadId: '0198c444-4444-7444-8444-444444444444', title: 'Implement worktree chat bookmarks', createdAt: '2026-08-20T21:00:00.000Z' };
      bookmarks.unshift(saved);
      currentBookmarkId = saved.id;
      return route.fulfill({ status: 201, json: saved });
    }
    const bookmarkMatch = /^\/api\/worktrees\/cora\/bookmarks\/([^/]+)$/u.exec(url.pathname);
    // rename one saved chat
    if (bookmarkMatch && request.method() === 'PATCH') {
      const title = (request.postDataJSON() as { title: string }).title;
      const bookmark = bookmarks.find(candidate => candidate.id === bookmarkMatch[1]);
      // require the fixture bookmark
      if (bookmark === undefined) return route.fulfill({ status: 404, json: { error: 'bookmark unavailable' } });
      bookmark.title = title;
      renamedBookmark = title;
      return route.fulfill({ json: bookmark });
    }
    // delete one saved chat
    if (bookmarkMatch && request.method() === 'DELETE') {
      const bookmarkId = bookmarkMatch[1];
      // require the captured bookmark identifier
      if (bookmarkId === undefined) return route.fulfill({ status: 404, json: { error: 'bookmark unavailable' } });
      deletedBookmark = bookmarkId;
      const index = bookmarks.findIndex(candidate => candidate.id === deletedBookmark);
      const [removed] = bookmarks.splice(index, 1);
      // clear the current fixture selection
      if (currentBookmarkId === deletedBookmark) currentBookmarkId = undefined;
      return route.fulfill({ json: removed });
    }
    const switchMatch = /^\/api\/worktrees\/cora\/bookmarks\/([^/]+)\/switch$/u.exec(url.pathname);
    // resume the selected chat
    if (switchMatch && request.method() === 'POST') {
      const bookmarkId = switchMatch[1];
      // require the captured bookmark identifier
      if (bookmarkId === undefined) return route.fulfill({ status: 404, json: { error: 'bookmark unavailable' } });
      switchedBookmark = bookmarkId;
      return route.fulfill({ status: 201, json: { agentId: 'agent-2' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.setViewportSize({ width: 520, height: 720 });
  await page.goto('/');
  const bookmarkButton = page.getByRole('button', { name: 'Bookmarked chats' });
  const notesButton = page.getByRole('button', { name: 'Notes' });
  await expect(bookmarkButton).toHaveAccessibleName('Bookmarked chats (1)');
  const [bookmarkBounds, notesBounds] = await Promise.all([bookmarkButton.boundingBox(), notesButton.boundingBox()]);
  requireBounds(bookmarkBounds, 'bookmark button');
  requireBounds(notesBounds, 'notes button');
  expect(bookmarkBounds.y).toBeLessThan(notesBounds.y);

  await bookmarkButton.click();
  await expect(bookmarkButton).toHaveAccessibleName('Bookmarked chats (1)');
  const menu = page.locator('.bookmarks-menu');
  const bookmarkCurrent = menu.getByRole('button', { name: 'Bookmark this chat' });
  const originalChoice = menu.locator('[aria-current="true"]').filter({ hasText: originalTitle });
  const originalName = menu.getByText(originalTitle);
  await expect(originalName).toBeVisible();
  await expect(bookmarkCurrent).toBeDisabled();
  await expect(originalChoice).toHaveAttribute('aria-current', 'true');
  const [menuBounds, nameBounds, rowPresentation] = await Promise.all([
    menu.boundingBox(),
    originalName.boundingBox(),
    menu.locator('.bookmark-row').first().evaluate(element => {
      const row = getComputedStyle(element);
      const choiceElement = element.querySelector('.bookmark-choice');
      // require the row action under review
      if (!(choiceElement instanceof HTMLElement)) throw new Error('bookmark choice unavailable');
      const choice = getComputedStyle(choiceElement);
      return { overflow: row.overflow, radius: row.borderRadius, choiceRadius: choice.borderRadius, choiceBorder: choice.borderWidth, selectionShadow: row.boxShadow };
    })
  ]);
  requireBounds(menuBounds, 'bookmark menu');
  requireBounds(nameBounds, 'bookmark name');
  expect(menuBounds.width).toBeGreaterThan(320);
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(nameBounds.height).toBeGreaterThan(20);
  expect(rowPresentation.overflow).toBe('hidden');
  expect(parseFloat(rowPresentation.radius)).toBeGreaterThan(0);
  expect(rowPresentation.choiceRadius).toBe('0px');
  expect(rowPresentation.choiceBorder).toBe('0px');
  expect(rowPresentation.selectionShadow).not.toBe('none');
  await menu.getByRole('button', { name: `Rename saved chat: ${originalTitle}` }).click();
  const chatName = menu.getByRole('textbox', { name: 'Chat name' });
  await chatName.fill('Release migration checklist');
  await menu.getByRole('button', { name: 'Save chat name' }).click();
  await expect.poll(() => renamedBookmark).toBe('Release migration checklist');
  await expect(menu.getByText('Release migration checklist')).toBeVisible();
  const renamedMenuBounds = await menu.boundingBox();
  requireBounds(renamedMenuBounds, 'renamed bookmark menu');
  expect(renamedMenuBounds.width).toBeLessThan(menuBounds.width - 60);
  await menu.getByRole('button', { name: 'Delete saved chat: Release migration checklist' }).click();
  await expect.poll(() => deletedBookmark).toBe('bookmark-identifier-001');
  await expect(menu.getByText('Release migration checklist')).toBeHidden();
  await expect(bookmarkCurrent).toBeEnabled();
  await bookmarkCurrent.click();
  await expect.poll(() => bookmarkedCurrent).toBe(1);
  await expect(bookmarkButton).toHaveAccessibleName('Bookmarked chats (1)');
  await expect(bookmarkCurrent).toBeDisabled();
  const savedChoice = menu.locator('[aria-current="true"]').filter({ hasText: 'Implement worktree chat bookmarks' });
  await expect(savedChoice).toHaveAttribute('aria-current', 'true');

  await savedChoice.click();
  await expect.poll(() => switchedBookmark).toBe('bookmark-identifier-002');
  await expect(menu).toBeHidden();
});

test('shows the server reason when the selected chat cannot be bookmarked', async ({ page }) => {
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    // serve one controlled browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve one configured agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 0, title: 'Ready' }], worktrees: [] } });
    // expose one empty bookmark group
    if (url.pathname === '/api/worktrees/cora/bookmarks' && request.method() === 'GET') return route.fulfill({ json: { bookmarks: [], canResume: true } });
    // reject ambiguous session identity
    if (url.pathname === '/api/agents/agent-1/bookmarks' && request.method() === 'POST') return route.fulfill({ status: 409, json: { error: "This agent has an ambiguous or unavailable Codex chat." } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Bookmarked chats' }).click();
  await page.getByRole('button', { name: 'Bookmark this chat' }).click();

  await expect(page.getByRole('alert')).toHaveText("This agent has an ambiguous or unavailable Codex chat.");
});
