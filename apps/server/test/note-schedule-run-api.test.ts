import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeNoteService } from '../src/notes/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptService } from '../src/prompts/service.js';
import type { Schedule, ScheduleTarget } from '../src/schedule/types.js';
import type { Agent, Dashboard } from '../src/domain/models.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { testSocket } from './helpers/discovery-stubs.js';
import { appearingDiscovery, launchFake, recordingTmux, reuseWorld, zeroPollDelay } from './helpers/run.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const host = 'agents.example.com';
const mutate = { host, origin: `https://${host}`, cookie: '__Host-rac=x', 'x-csrf-token': 'csrf' };
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

const worktree = testWorktree({ id: 'wt-main', projectId: 'proj', label: 'Proj · main', path: '/repo', identity: '/repo', main: true });
const codexPane = { id: 'agent-1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/repo', worktreeId: 'wt-main', title: 'Ready', kind: 'codex' as const };
const claudePane = { ...codexPane, kind: 'claude' as const };

// seed a note keyed under the project with a Schedule (and optionally a remembered agent id)
async function scheduledNote(schedule: Partial<Schedule> & { target: ScheduleTarget }, previousAgentId?: string, text = 'Draft the weekly report'): Promise<{ notes: WorktreeNoteService; queued: QueuedPromptService; noteId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rac-schedule-run-')); dirs.push(root);
  const notes = new WorktreeNoteService(join(root, 'notes.json'));
  const created = await notes.create('proj');
  if (text) await notes.update('proj', created!.id, text);
  await notes.setSchedule('proj', created!.id, { cron: '0 9 * * *', kind: 'codex', enabled: true, updatedAt: new Date().toISOString(), ...schedule });
  if (previousAgentId !== undefined) await notes.recordLastRun('proj', created!.id, { at: new Date(0).toISOString(), status: 'launched', agentId: previousAgentId });
  return { notes, queued: new QueuedPromptService(join(root, 'queue.json')), noteId: created!.id };
}

const defaultProjects = [testProject({ id: 'proj' })];
async function runApp({ queued, projects = defaultProjects, ...deps }: Record<string, unknown>) {
  // pass the per-test queue under the key buildApp reads, so tests never share the default file
  return await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`), projects: projects as never }), { auth, control, dashboardUpdates, launchPollDelay: zeroPollDelay, queuedPrompts: queued, ...deps } as never);
}

const runNow = (noteId: string, worktreeId = 'wt-main') => ({ method: 'POST' as const, url: `/api/worktrees/${worktreeId}/notes/${noteId}/schedule/run`, headers: mutate });

// a discovery that always resolves one live agent (for the skipped-state paths)
const staticDiscovery = (agent: Agent) => ({
  invalidateWorktrees: () => {},
  worktreesNow: () => [worktree],
  worktrees: async () => [worktree],
  dashboard: async (): Promise<Dashboard> => ({ generation: 1, adapters: {}, agents: [agent], projects: [] }),
  target: async (id: string) => (id === agent.id ? { agent, socket: testSocket } : undefined),
});

describe('POST /api/worktrees/:id/notes/:noteId/schedule/run', () => {
  it('reuses the remembered Codex pane: resets it, then submits the note only after it settles', async () => {
    const idle: Agent = { ...codexPane, attention: 'finished' };
    const working: Agent = { ...codexPane, attention: 'working', title: '⠋ Working' };
    const { discovery, tmux } = reuseWorld({ worktree, socket: testSocket, agent: idle, afterReset: index => (index === 0 ? working : idle) });
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } }, 'agent-1');
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      const response = await server.inject(runNow(noteId));
      expect(response.statusCode).toBe(200);
      expect(response.json().schedule.lastRun).toMatchObject({ status: 'launched', agentId: 'agent-1' });
      // the reset command is pasted first and the note only after it settled; the transcript is not resumed
      const resetIndex = tmux.pasted.findIndex(text => text.trim() === '/new');
      const noteIndex = tmux.pasted.findIndex(text => text.includes('Draft the weekly report'));
      expect(resetIndex).toBe(0);
      expect(noteIndex).toBeGreaterThan(resetIndex);
      // Codex submits the /new reset with the idle Enter, never Tab (which would swallow the command)
      expect(tmux.sentKeys[0]).toEqual(['Enter']);
    } finally { await server.close(); }
  }, 15_000);

  it('reuses the remembered Claude pane, resetting with /clear before the note', async () => {
    const idle: Agent = { ...claudePane, attention: 'finished', conversationId: 'conv-old' };
    const fresh: Agent = { ...claudePane, attention: 'finished', conversationId: 'conv-new' };
    const { discovery, tmux } = reuseWorld({ worktree, socket: testSocket, agent: idle, afterReset: () => fresh, capture: () => '❯' });
    const { notes, queued, noteId } = await scheduledNote({ kind: 'claude', target: { worktreeId: 'wt-main' } }, 'agent-1');
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      const response = await server.inject(runNow(noteId));
      expect(response.statusCode).toBe(200);
      expect(response.json().schedule.lastRun).toMatchObject({ status: 'launched', agentId: 'agent-1' });
      expect(tmux.pasted[0].trim()).toBe('/clear');
      expect(tmux.pasted.some(text => text.includes('Draft the weekly report'))).toBe(true);
    } finally { await server.close(); }
  }, 15_000);

  it('skips a remembered pane that is still working, recording the reason and advancing lastRun.at', async () => {
    const working: Agent = { ...codexPane, attention: 'working', title: '⠋ Working' };
    const tmux = recordingTmux();
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } }, 'agent-1');
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery: staticDiscovery(working) });
    try {
      const response = await server.inject(runNow(noteId));
      expect(response.statusCode).toBe(200);
      const lastRun = response.json().schedule.lastRun;
      expect(lastRun).toMatchObject({ status: 'skipped', detail: 'previous run still working', agentId: 'agent-1' });
      expect(Date.parse(lastRun.at)).toBeGreaterThan(0);
      expect(tmux.pasted).toEqual([]);
    } finally { await server.close(); }
  });

  it('skips a remembered pane that is asking a question', async () => {
    const asking: Agent = { ...codexPane, attention: 'question' };
    const tmux = recordingTmux();
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } }, 'agent-1');
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery: staticDiscovery(asking) });
    try {
      const response = await server.inject(runNow(noteId));
      expect(response.json().schedule.lastRun).toMatchObject({ status: 'skipped', detail: 'previous run is asking a question' });
      expect(tmux.pasted).toEqual([]);
    } finally { await server.close(); }
  });

  it('skips a remembered pane whose composer already holds a draft, never pasting the reset', async () => {
    const idle: Agent = { ...codexPane, attention: 'finished' };
    const { discovery, tmux } = reuseWorld({ worktree, socket: testSocket, agent: idle, afterReset: () => idle, capture: () => '› a half-typed thought' });
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } }, 'agent-1');
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      const response = await server.inject(runNow(noteId));
      expect(response.json().schedule.lastRun).toMatchObject({ status: 'skipped', detail: 'composer has unsent text' });
      expect(tmux.pasted).toEqual([]);
    } finally { await server.close(); }
  });

  it('fails a reset that never settles, leaving the pane and never submitting the note', async () => {
    // Claude with an unchanged conversation id never settles: the /clear was merged (lost)
    const idle: Agent = { ...claudePane, attention: 'finished', conversationId: 'conv-old' };
    const { discovery, tmux } = reuseWorld({ worktree, socket: testSocket, agent: idle, afterReset: () => idle, capture: () => '❯' });
    const { notes, queued, noteId } = await scheduledNote({ kind: 'claude', target: { worktreeId: 'wt-main' } }, 'agent-1');
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      const response = await server.inject(runNow(noteId));
      expect(response.json().schedule.lastRun).toMatchObject({ status: 'failed', detail: 'reset did not settle' });
      // the reset was attempted but the note never followed
      expect(tmux.pasted.some(text => text.trim() === '/clear')).toBe(true);
      expect(tmux.pasted.some(text => text.includes('Draft the weekly report'))).toBe(false);
      expect(tmux.closed).toEqual([]);
    } finally { await server.close(); }
  }, 15_000);

  it('submits the note with the reset instant on reuse, so Codex completion anchors on the fresh thread', async () => {
    const idle: Agent = { ...codexPane, attention: 'finished' };
    const working: Agent = { ...codexPane, attention: 'working', title: '⠋ Working' };
    const { discovery, tmux } = reuseWorld({ worktree, socket: testSocket, agent: idle, afterReset: index => (index === 0 ? working : idle) });
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } }, 'agent-1');
    // a real prompt service over the same fakes, with submit wrapped to observe the reset instant
    const resetAts: Array<number | undefined> = [];
    const prompts = new PromptService(discovery as never, tmux as never, undefined, queued);
    const realSubmit = prompts.submit.bind(prompts);
    prompts.submit = ((agentId: string, text: string, attachments?: never, resetAt?: number) => { resetAts.push(resetAt); return realSubmit(agentId, text, attachments, resetAt); }) as typeof prompts.submit;
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery, prompts });
    try {
      expect((await server.inject(runNow(noteId))).json().schedule.lastRun).toMatchObject({ status: 'launched', agentId: 'agent-1' });
      // the reuse path submitted the note once, carrying a numeric reset instant (not undefined)
      expect(resetAts.length).toBe(1);
      expect(typeof resetAts[0]).toBe('number');
    } finally { await server.close(); }
  }, 15_000);

  it('skips a remembered pane it cannot read rather than pasting blind', async () => {
    const idle: Agent = { ...codexPane, attention: 'finished' };
    const { discovery, tmux } = reuseWorld({ worktree, socket: testSocket, agent: idle, afterReset: () => idle, capture: () => { throw new Error('capture failed'); } });
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } }, 'agent-1');
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      expect((await server.inject(runNow(noteId))).json().schedule.lastRun).toMatchObject({ status: 'skipped', detail: 'could not read the pane' });
      expect(tmux.pasted).toEqual([]);
    } finally { await server.close(); }
  });

  it('fails a reset when the pane vanishes mid-settle', async () => {
    const idle: Agent = { ...claudePane, attention: 'finished', conversationId: 'conv-old' };
    const { discovery, tmux } = reuseWorld({ worktree, socket: testSocket, agent: idle, afterReset: () => idle, capture: () => '❯', vanishAfterReset: true });
    const { notes, queued, noteId } = await scheduledNote({ kind: 'claude', target: { worktreeId: 'wt-main' } }, 'agent-1');
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      const lastRun = (await server.inject(runNow(noteId))).json().schedule.lastRun;
      expect(lastRun).toMatchObject({ status: 'failed', detail: 'reset did not settle' });
      // the reset was pasted, but the vanished pane meant the note never followed
      expect(tmux.pasted.some(text => text.trim() === '/clear')).toBe(true);
      expect(tmux.pasted.some(text => text.includes('Draft the weekly report'))).toBe(false);
    } finally { await server.close(); }
  }, 15_000);

  it('launches fresh when the remembered agent is gone, recording the new agent id', async () => {
    const tmux = recordingTmux();
    const launch = launchFake();
    // the remembered id resolves to nothing; a fresh Codex appears
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } }, 'ghost-agent-id');
    const server = await runApp({ notes, queued, tmux, launch, discovery });
    try {
      const response = await server.inject(runNow(noteId));
      expect(response.json().schedule.lastRun).toMatchObject({ status: 'launched', agentId: 'agent-1' });
      expect(launch.kinds).toEqual(['codex']);
      // a fresh launch never pastes a reset command
      expect(tmux.pasted.some(text => text.trim() === '/new')).toBe(false);
      expect(tmux.pasted.some(text => text.includes('Draft the weekly report'))).toBe(true);
    } finally { await server.close(); }
  }, 15_000);

  it('launches fresh when the remembered agent is a different kind, never touching it', async () => {
    const stale: Agent = { ...claudePane, id: 'stale-agent', attention: 'finished' };
    const fresh: Agent = { ...codexPane, id: 'agent-2', attention: 'finished' };
    let dashboards = 0;
    const discovery = {
      invalidateWorktrees: () => {},
      worktreesNow: () => [worktree],
      worktrees: async () => [worktree],
      dashboard: async (): Promise<Dashboard> => ({ generation: ++dashboards, adapters: {}, agents: dashboards > 1 ? [stale, fresh] : [stale], projects: [] }),
      target: async (id: string) => (id === stale.id ? { agent: stale, socket: testSocket } : id === fresh.id ? { agent: fresh, socket: testSocket } : undefined),
    };
    const tmux = recordingTmux();
    const launch = launchFake();
    const { notes, queued, noteId } = await scheduledNote({ kind: 'codex', target: { worktreeId: 'wt-main' } }, 'stale-agent');
    const server = await runApp({ notes, queued, tmux, launch, discovery });
    try {
      const response = await server.inject(runNow(noteId));
      expect(response.json().schedule.lastRun).toMatchObject({ status: 'launched', agentId: 'agent-2' });
      expect(launch.kinds).toEqual(['codex']);
      expect(tmux.pasted.some(text => text.trim() === '/new' || text.trim() === '/clear')).toBe(false);
    } finally { await server.close(); }
  }, 15_000);

  it('refuses a second Run now while one of the same Schedule is in flight (409)', async () => {
    let reached!: () => void; const reachedGate = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const base = launchFake();
    const launch = { ...base, launch: async (worktreeId: string, kind?: string) => { reached(); await gate; return base.launch(worktreeId, kind); } };
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } });
    const server = await runApp({ notes, queued, tmux: recordingTmux(), launch, discovery });
    try {
      const first = server.inject(runNow(noteId));
      await reachedGate;
      const second = await server.inject(runNow(noteId));
      expect(second.statusCode).toBe(409);
      release();
      expect((await first).statusCode).toBe(200);
    } finally { await server.close(); }
  }, 15_000);

  it('launches fresh for a Scratch target through launchHome', async () => {
    const tmux = recordingTmux();
    const launch = launchFake();
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, workspace: '/scratch', attention: 'finished' }, socket: testSocket });
    const { notes, queued, noteId } = await scheduledNote({ target: { scratch: true } });
    const server = await runApp({ notes, queued, tmux, launch, discovery });
    try {
      const response = await server.inject(runNow(noteId));
      expect(response.json().schedule.lastRun).toMatchObject({ status: 'launched', agentId: 'agent-1' });
      // the Scratch target dispatched to launchHome, not the worktree/project launch methods
      expect(launch.calls).toEqual([{ via: 'home', kind: 'codex' }]);
      expect(tmux.pasted.some(text => text.includes('Draft the weekly report'))).toBe(true);
    } finally { await server.close(); }
  }, 15_000);

  it('launches fresh for a directory Project target through launchProjectDirectory', async () => {
    const tmux = recordingTmux();
    const launch = launchFake();
    const fresh: Agent = { ...codexPane, id: 'agent-1', workspace: '/dir', displayLabel: 'Dir Proj', attention: 'finished' };
    const discovery = appearingDiscovery({ worktree, agent: fresh, socket: testSocket });
    const projects = [testProject({ id: 'proj' }), testProject({ id: 'dir-proj', label: 'Dir Proj', mode: 'directory', path: '/dir', identity: '/dir', available: true })];
    const { notes, queued, noteId } = await scheduledNote({ target: { projectId: 'dir-proj' } });
    const server = await runApp({ notes, queued, tmux, launch, discovery, projects });
    try {
      const response = await server.inject(runNow(noteId));
      expect(response.json().schedule.lastRun).toMatchObject({ status: 'launched', agentId: 'agent-1' });
      // the directory-Project target dispatched to launchProjectDirectory
      expect(launch.calls).toEqual([{ via: 'project', kind: 'codex' }]);
      expect(tmux.pasted.some(text => text.includes('Draft the weekly report'))).toBe(true);
    } finally { await server.close(); }
  }, 15_000);

  it('skips when the target worktree is gone, recording the reason', async () => {
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'ghost-wt' } });
    const server = await runApp({ notes, queued, tmux, launch: launchFake(), discovery });
    try {
      expect((await server.inject(runNow(noteId))).json().schedule.lastRun).toMatchObject({ status: 'skipped', detail: 'target is gone' });
      expect(tmux.pasted).toEqual([]);
    } finally { await server.close(); }
  });

  it('skips when the Schedule kind is no longer launchable', async () => {
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } });
    const server = await runApp({ notes, queued, tmux, launch: launchFake({ unlaunchable: true }), discovery });
    try {
      expect((await server.inject(runNow(noteId))).json().schedule.lastRun).toMatchObject({ status: 'skipped', detail: 'codex is not available' });
      expect(tmux.pasted).toEqual([]);
    } finally { await server.close(); }
  });

  it('skips a blank note without launching', async () => {
    const tmux = recordingTmux();
    const launch = launchFake();
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } }, undefined, '');
    const server = await runApp({ notes, queued, tmux, launch, discovery });
    try {
      expect((await server.inject(runNow(noteId))).json().schedule.lastRun).toMatchObject({ status: 'skipped', detail: 'note is empty' });
      expect(launch.kinds).toEqual([]);
    } finally { await server.close(); }
  });

  it('records a failed fresh launch that was refused', async () => {
    const tmux = recordingTmux();
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    const { notes, queued, noteId } = await scheduledNote({ target: { worktreeId: 'wt-main' } });
    const server = await runApp({ notes, queued, tmux, launch: launchFake({ refuse: true }), discovery });
    try {
      expect((await server.inject(runNow(noteId))).json().schedule.lastRun).toMatchObject({ status: 'failed', detail: 'launch refused' });
      expect(tmux.pasted).toEqual([]);
    } finally { await server.close(); }
  });

  it('launches fresh when the remembered agent is in another workspace', async () => {
    const stale: Agent = { ...codexPane, id: 'stale-agent', workspace: '/other', attention: 'finished' };
    const fresh: Agent = { ...codexPane, id: 'agent-2', workspace: '/repo', attention: 'finished' };
    let dashboards = 0;
    const discovery = {
      invalidateWorktrees: () => {},
      worktreesNow: () => [worktree],
      worktrees: async () => [worktree],
      dashboard: async (): Promise<Dashboard> => ({ generation: ++dashboards, adapters: {}, agents: dashboards > 1 ? [stale, fresh] : [stale], projects: [] }),
      target: async (id: string) => (id === stale.id ? { agent: stale, socket: testSocket } : id === fresh.id ? { agent: fresh, socket: testSocket } : undefined),
    };
    const tmux = recordingTmux();
    const launch = launchFake();
    const { notes, queued, noteId } = await scheduledNote({ kind: 'codex', target: { worktreeId: 'wt-main' } }, 'stale-agent');
    const server = await runApp({ notes, queued, tmux, launch, discovery });
    try {
      expect((await server.inject(runNow(noteId))).json().schedule.lastRun).toMatchObject({ status: 'launched', agentId: 'agent-2' });
      expect(launch.kinds).toEqual(['codex']);
      expect(tmux.pasted.some(text => text.trim() === '/new')).toBe(false);
    } finally { await server.close(); }
  }, 15_000);

  it('404s a note without a Schedule and an unknown note', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-schedule-run-none-')); dirs.push(root);
    const notes = new WorktreeNoteService(join(root, 'notes.json'));
    const created = await notes.create('proj');
    await notes.update('proj', created!.id, 'Just a note');
    const discovery = appearingDiscovery({ worktree, agent: { ...codexPane, attention: 'finished' }, socket: testSocket });
    const server = await runApp({ notes, queued: new QueuedPromptService(join(root, 'queue.json')), tmux: recordingTmux(), launch: launchFake(), discovery });
    try {
      expect((await server.inject(runNow(created!.id))).statusCode).toBe(404);
      expect((await server.inject(runNow('note-identifier-000'))).statusCode).toBe(404);
    } finally { await server.close(); }
  });
});
