import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptService } from '../src/prompts/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { adapterFor } from '../src/adapters/registry.js';
import type { CompletionBaseline } from '../src/adapters/types.js';

const socket = { fingerprint: 'socket', path: '/tmp/sock', device: 1, inode: 1 };

// represent mutable adapter state across scenarios
type ResetTestAgent = {
  id: string;
  paneId: string;
  workspace: string;
  kind: 'claude' | 'codex' | 'omx';
  title: string;
  attention: 'finished' | 'working';
  displayLabel?: string;
  conversationId?: string;
};

// create shared durable services and agent state
const createResetFixture = async (kind: ResetTestAgent['kind'] = 'codex') => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-reset-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const history = new PromptHistoryService(join(directory, 'history.json'));
  const agent: ResetTestAgent = {
    id: 'socket:%1',
    paneId: '%1',
    workspace: '/tmp',
    kind,
    title: 'Ready',
    attention: 'finished'
  };
  const saved: string[] = [];
  // expose the default pane without scenario-specific terminal behavior
  const discovery = {
    worktreesNow: () => [],
    target: async () => ({ agent, socket }),
    paneProcessId: () => 123,
    paneWorkingDirectory: () => '/tmp'
  };
  // record accidental transfers to undelivered notes
  const drain = async (_scope: string, prompt: { text: string }) => {
    saved.push(prompt.text);
    return true;
  };
  // remove the isolated durable files
  const cleanup = async () => rm(directory, { recursive: true, force: true });
  return { agent, cleanup, discovery, drain, history, queue, saved };
};

// conversation resets must not wait for model answers or drain queued follow-ups
describe('clear then queue', () => {
  afterEach(() => vi.useRealTimers());

  // resets must release follow-ups without waiting for a nonexistent model answer
  it.each([
    ['codex', '/clear'], ['codex', '/new'], ['omx', '/clear'], ['omx', '/new']
  ] as const)('delivers queued work after %s %s and tracks the fresh conversation', async (kind, command) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const { agent, cleanup, discovery, drain, history, queue, saved } = await createResetFixture(kind);
    const scope = `agent:${agent.id}`;
    const pasted: string[] = [];
    let composer = '';
    let loading = false;
    let completed = false;
    const tmux = {
      // retain the exact draft until the submit key
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = prompt; return true; },
      // advance deterministic render time without faking filesystem work
      capture: async () => { vi.setSystemTime(Date.now() + 100); return `${loading ? 'model: loading\n' : ''}› ${composer || 'Ask Codex to do anything'}`; },
      // a reset briefly looks busy without producing a model turn
      sendKeys: async () => { loading = composer.trim() === command; composer = ''; agent.attention = 'working'; return true; }
    };
    const adapter = {
      ...adapterFor(kind)!,
      completion: {
        // model the stale file still held open until the first post-reset turn
        baseline: async (_pane: unknown, resetAt?: number): Promise<CompletionBaseline> => {
          return resetAt === undefined ? { rollout: 'stale.jsonl', ordinal: 3 } : { cwd: '/tmp', resetAt, ordinal: 0 };
        },
        // only the deferred fresh-thread baseline can see this completion
        since: async (baseline: CompletionBaseline) => completed && 'resetAt' in baseline
          ? { kind: 'completed' as const, ordinal: 4, answer: 'Fresh answer' }
          : { kind: 'pending' as const }
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain, () => adapter);
    try {
      // cover both direct input and an already queued reset
      if (command === '/clear') {
        await service.submit(agent.id, command);
        await service.submit(agent.id, 'first follow-up');
      } else {
        await queue.enqueue(scope, command);
        await queue.enqueue(scope, 'first follow-up');
        await service.observe(agent);
      }
      await service.submit(agent.id, 'second follow-up');
      expect(pasted).toEqual([command]);

      // a visible empty composer is not ready while the new session still loads
      vi.setSystemTime(Date.now() + 2_000);
      await service.observe(agent);
      agent.attention = 'finished';
      await service.observe(agent);
      expect(pasted).toEqual([command]);

      loading = false;
      await service.observe(agent);
      expect(pasted).toEqual([command, 'first follow-up']);
      await expect(history.list(scope)).resolves.toMatchObject([{ text: 'first follow-up' }]);
      await expect(history.list(scope)).resolves.toHaveLength(1);

      // the real answer releases the next prompt without a false undelivered drain
      completed = true;
      agent.attention = 'finished';
      await service.observe(agent);
      expect(pasted).toEqual([command, 'first follow-up', 'second follow-up']);
      expect(saved).toEqual([]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
      await expect(history.list(scope)).resolves.toMatchObject([{ text: 'second follow-up' }, { text: 'first follow-up', answer: 'Fresh answer' }]);
    } finally { await cleanup(); }
  });

  // retain the fresh-thread anchor even when no prompt was queued during the reset
  it.each([[false, false], [true, false], [false, true]])('handles delayed input with swallowed submission=%s and expired readiness=%s', async (swallowed, expired) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const { agent, cleanup, discovery, drain, history, queue, saved } = await createResetFixture();
    const pasted: string[] = [];
    const resets: Array<number | undefined> = [];
    let composer = '';
    let loading = expired;
    const tmux = {
      // keep failed delivery in the composer rather than losing the original paste
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = prompt; return true; },
      // drive deterministic render and acknowledgement polling
      capture: async () => { vi.setSystemTime(Date.now() + 100); return `${loading ? 'model: loading\n' : ''}› ${composer}`; },
      // acknowledge only the reset when the next prompt is intentionally swallowed
      sendKeys: async () => { if (!swallowed || composer.trim() === '/clear') composer = ''; return true; }
    };
    const adapter = {
      ...adapterFor('codex')!,
      completion: {
        // capture only the reset boundary used by the delayed real prompt
        baseline: async (_pane: unknown, resetAt?: number) => { resets.push(resetAt); return undefined; },
        since: async () => undefined
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain, () => adapter);
    try {
      await service.submit(agent.id, '/clear');
      vi.setSystemTime(Date.now() + (expired ? 11_000 : 2_000));
      await service.observe(agent);
      // an idle settled reset must not permanently reserve lifecycle operations
      const release = await service.acquireRestartLock(agent.id);
      expect(release).toEqual(expect.any(Function));
      release?.();
      loading = false;
      await service.submit(agent.id, 'delayed follow-up');
      await service.observe(agent);
      expect(resets).toEqual([expect.any(Number)]);
      await service.observe(agent);
      expect(pasted).toEqual(['/clear', 'delayed follow-up']);
      expect(saved).toEqual(swallowed ? ['delayed follow-up'] : []);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // a terminal-entered reset has no console dispatch or answer to recover
  it('delivers unattempted work after an external reset spinner returns to idle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const { agent, cleanup, discovery, drain, history, queue, saved } = await createResetFixture();
    agent.title = '⠋ Starting';
    agent.attention = 'working';
    const pasted: string[] = [];
    let composer = '';
    let completed = false;
    const tmux = {
      // observe actual delivery rather than assuming a queued prompt was sent
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = prompt; return true; },
      // the startup composer is visible before the title becomes idle
      capture: async () => { vi.setSystemTime(Date.now() + 100); return `› ${composer}`; },
      // acknowledge the eventual first real prompt
      sendKeys: async () => { composer = ''; return true; }
    };
    const adapter = {
      ...adapterFor('codex')!,
      completion: {
        // no reliable command timestamp exists for a terminal-entered reset
        baseline: async (_pane: unknown, _resetAt?: number, followReset?: boolean): Promise<CompletionBaseline> => {
          return { rollout: 'old.jsonl', ordinal: 3, ...(followReset ? { resetPane: { pid: 123, cwd: '/tmp' } } : {}) };
        },
        // the completion arrives in the new file only after the first prompt starts
        since: async (baseline: CompletionBaseline) => completed && 'resetPane' in baseline
          ? { kind: 'completed' as const, ordinal: 4, answer: 'Fresh answer' }
          : { kind: 'pending' as const }
      }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain, () => adapter);
    try {
      await service.submit(agent.id, 'after external clear');
      await service.submit(agent.id, 'second follow-up');
      expect(pasted).toEqual([]);
      agent.attention = 'finished';
      await service.observe(agent);
      vi.setSystemTime(Date.now() + 11_000);
      await service.observe(agent);
      expect(pasted).toEqual(['after external clear']);
      completed = true;
      await service.observe(agent);
      expect(pasted).toEqual(['after external clear', 'second follow-up']);
      expect(saved).toEqual([]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  // an unusable reset must not reserve a durable queue forever
  it.each(['loading', 'missing'] as const)('preserves follow-ups as notes when a reset stays %s', async failure => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const { agent, cleanup, drain, history, queue, saved } = await createResetFixture();
    const pasted: string[] = [];
    let composer = '';
    let reset = false;
    // keep discovery unavailable only after accepting the reset
    const discovery = { worktreesNow: () => [], target: async () => reset && failure === 'missing' ? undefined : { agent, socket } };
    const tmux = {
      // retain the reset draft for acknowledgement
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = prompt; return true; },
      // leave an empty composer visible beneath a loading header
      capture: async () => { vi.setSystemTime(Date.now() + 100); return `model: loading\n› ${composer}`; },
      // acknowledge the reset but never finish loading
      sendKeys: async () => { reset = true; composer = ''; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain);
    try {
      await queue.enqueue(`agent:${agent.id}`, '/clear');
      await queue.enqueue(`agent:${agent.id}`, 'recover this prompt');
      await service.observe(agent);
      vi.setSystemTime(Date.now() + 11_000);
      await service.observe(agent);
      await service.observe(agent);
      await service.observe(agent);
      expect(pasted).toEqual(['/clear']);
      expect(saved).toEqual(['recover this prompt']);
      await expect(queue.list(`agent:${agent.id}`)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });

  it('dispatches a prompt queued right after /clear instead of losing it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const { agent, cleanup, discovery, drain, history, queue, saved } = await createResetFixture('claude');
    agent.displayLabel = 'Claude';
    agent.title = 'Claude';
    agent.conversationId = 'before-clear';
    const pasted: string[] = [];
    const tmux = {
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt); return true; },
      capture: async () => '❯ ',
      // SessionStart reports the fresh session after the reset key
      sendKeys: async () => { agent.conversationId = 'after-clear'; return true; },
    };
    // resolve the real Claude adapter (reported-state, turn-less) by kind
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain as never);
    try {
      // send /clear without opening a model-answer phase
      await expect(service.submit(agent.id, '/clear')).resolves.toBe(true);
      // retain an immediate follow-up until the reported reset settles
      await expect(service.submit(agent.id, 'do the thing')).resolves.toBe(true);
      // let the reportedWorkingGraceMs (5s) window elapse with the pane still finished
      vi.setSystemTime(6_000);
      await service.observe(agent);

      // the follow-up must reach the pane, not be drained into a Note
      expect(pasted).toEqual(['/clear', 'do the thing']);
      expect(saved).toEqual([]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await cleanup(); }
  });
});
