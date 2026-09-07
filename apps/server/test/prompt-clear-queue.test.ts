import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptService } from '../src/prompts/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';

const socket = { fingerprint: 'socket', path: '/tmp/sock', device: 1, inode: 1 };

// Regression for the reported bug: sending `/clear` to Claude, then a follow-up
// prompt in the next few seconds, dropped the follow-up. `/clear` never reports
// `working`, so its awaiting-start phase sat through reportedWorkingGraceMs and then
// halted, sweeping the queued follow-up into saved prompts instead of dispatching it.
describe('clear then queue', () => {
  afterEach(() => vi.useRealTimers());

  it('dispatches a prompt queued right after /clear instead of losing it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const directory = await mkdtemp(join(tmpdir(), 'rac-clear-queue-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = { id: 'socket:%1', paneId: '%1', workspace: '/tmp', kind: 'claude' as const, displayLabel: 'Claude', attention: 'finished' as const };
    const scope = `agent:${agent.id}`;
    const pasted: string[] = [];
    const saved: string[] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt); return true; },
      capture: async () => '',
      sendKeys: async () => true,
    };
    const savedPrompts = { save: async (_scope: string, text: string) => { saved.push(text); return { id: 'saved' }; } };
    // resolve the real Claude adapter (reported-state, turn-less) by kind
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, savedPrompts as never);
    try {
      // send /clear: dispatched to the pane, leaving an awaiting-start phase
      await expect(service.submit(agent.id, '/clear')).resolves.toBe(true);
      // the operator immediately queues a follow-up while /clear is still awaiting-start
      await expect(service.submit(agent.id, 'do the thing')).resolves.toBe(true);
      // let the reportedWorkingGraceMs (5s) window elapse with the pane still finished
      vi.setSystemTime(6_000);
      await service.observe(agent);

      // the follow-up must reach the pane, not be swept into saved prompts
      expect(pasted).toEqual(['/clear', 'do the thing']);
      expect(saved).toEqual([]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
