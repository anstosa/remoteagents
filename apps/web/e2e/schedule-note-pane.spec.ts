import { expect, test } from '@playwright/test';

// pin the zone so the server-supplied nextRun renders as a fixed local sentence
test.use({ timezoneId: 'America/Los_Angeles' });

type ScheduleBody = { cron: string; kind: string; target: unknown; enabled: boolean };
type StoredNote = { id: string; text: string; title?: string; schedule?: ScheduleBody; nextRun?: string };

test('sets and removes a note Schedule from the pane against a stateful notes stub', async ({ page }) => {
  test.setTimeout(60_000);
  const notes: StoredNote[] = [];
  const scheduleWrites: Array<{ method: string; body?: ScheduleBody }> = [];
  let created = 0;
  const worktree = { id: 'wt-main', projectId: 'atlas', label: 'main', path: '/worktrees/atlas', main: true, detached: false, locked: false, available: true, pinned: true, order: 0, branch: 'main', launch: { kind: 'claude' } };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/atlas', worktreeId: 'wt-main', worktreeLabel: 'main', projectId: 'atlas', kind: 'claude', title: 'Ready' }], projects: [{ id: 'atlas', label: 'atlas', mode: 'repository', available: true, worktrees: [worktree] }] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/schedule/preview') return route.fulfill({ json: { next: ['2026-09-07T09:00:00-07:00', '2026-09-08T09:00:00-07:00', '2026-09-09T09:00:00-07:00'] } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'GET') return route.fulfill({ json: { notes } });
    if (url.pathname === '/api/worktrees/wt-main/notes' && request.method() === 'POST') {
      const note = { id: `note-identifier-00${++created}`, text: '' };
      notes.unshift(note);
      return route.fulfill({ status: 201, json: note });
    }
    const scheduleMatch = /^\/api\/worktrees\/wt-main\/notes\/([^/]+)\/schedule$/u.exec(url.pathname);
    if (scheduleMatch) {
      const note = notes.find(candidate => candidate.id === scheduleMatch[1]);
      if (note === undefined) return route.fulfill({ status: 404, json: { error: 'missing' } });
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as ScheduleBody;
        scheduleWrites.push({ method: 'PUT', body });
        note.schedule = body;
        note.nextRun = '2026-09-07T09:00:00-07:00';
        return route.fulfill({ json: { ...note } });
      }
      if (request.method() === 'DELETE') {
        scheduleWrites.push({ method: 'DELETE' });
        delete note.schedule;
        delete note.nextRun;
        return route.fulfill({ json: { id: note.id, text: note.text, ...(note.title === undefined ? {} : { title: note.title }) } });
      }
    }
    const noteMatch = /^\/api\/worktrees\/wt-main\/notes\/([^/]+)$/u.exec(url.pathname);
    if (noteMatch && request.method() === 'DELETE') {
      const index = notes.findIndex(candidate => candidate.id === noteMatch[1]);
      if (index < 0) return route.fulfill({ status: 404, json: { error: 'missing' } });
      return route.fulfill({ json: notes.splice(index, 1)[0] });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Notes' }).click();
  await page.getByRole('button', { name: '+ New note' }).click();
  await expect(page.getByRole('dialog', { name: 'Note' })).toBeVisible();
  const editor = page.getByRole('group', { name: 'Schedule', exact: true });
  await expect(editor).toContainText('Not scheduled.');
  await expect(editor).toContainText('atlas · main worktree');

  const openFlyout = () => page.getByRole('button', { name: 'Notes' }).click();
  const closeFlyout = () => page.locator('.flyout-backdrop').click();

  // create → the pane shows the sentence and the server's nextRun
  await editor.getByRole('button', { name: 'Schedule this note' }).click();
  await expect(editor.getByRole('switch', { name: 'Schedule enabled' })).toHaveText('● Runs');
  await expect(editor).toContainText('Next Mon 7 Sep 9:00 AM');
  await expect.poll(() => scheduleWrites.at(-1)).toEqual({ method: 'PUT', body: { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true } });

  // the fly-out row gains a yellow (not paused) clock badge for the enabled Schedule
  await openFlyout();
  await expect(page.locator('.note-schedule-badge')).toHaveCount(1);
  await expect(page.locator('.note-schedule-badge.paused')).toHaveCount(0);
  await closeFlyout();

  // pause → records the disabled write and dims the badge
  await editor.getByRole('switch', { name: 'Schedule enabled' }).click();
  await expect(editor.getByRole('switch', { name: 'Schedule enabled' })).toHaveText('○ Paused');
  await expect.poll(() => scheduleWrites.at(-1)).toEqual({ method: 'PUT', body: { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: false } });
  await openFlyout();
  await expect(page.locator('.note-schedule-badge.paused')).toHaveCount(1);
  await closeFlyout();

  // remove → back to unscheduled, request recorded, badge gone
  await editor.getByRole('button', { name: 'Remove schedule' }).click();
  await expect(editor).toContainText('Not scheduled.');
  await expect.poll(() => scheduleWrites.at(-1)).toEqual({ method: 'DELETE' });
  await openFlyout();
  await expect(page.locator('.note-schedule-badge')).toHaveCount(0);
});
