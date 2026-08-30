import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptService } from '../src/prompts/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { stated } from './helpers/agent.js';

const socket = { fingerprint: 'socket', path: '/tmp/sock', device: 1, inode: 1 };

// Regression for the reported bug: Codex's Tab submit was intermittently swallowed
// by a composer that had not yet rendered the paste. The prompt then never started,
// and observe() relocated the queued prompt behind it into saved prompts (the badge
// vanished, nothing reached Codex). send() now settles the paste in the composer
// before pressing the submit key, and holds the scope so a quick second submit
// queues behind the first instead of double-pasting during the settle.
describe('interactive submit settle', () => {
  it('waits for the pasted prompt to render in the composer before submitting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-settle-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    let captures = 0;
    let capturesAtSubmit = -1;
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      // the composer is empty for the first polls, then renders the pasted prompt
      capture: async () => { captures += 1; return captures >= 3 ? '› render me ' : '› '; },
      sendKeys: async (_s: unknown, _p: string, keys: string[]) => { if (keys.includes('Tab')) capturesAtSubmit = captures; return true; },
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await expect(service.submit(agent.id, 'render me')).resolves.toBe(true);
      // the Tab was held until the paste had rendered, not fired against an empty composer
      expect(capturesAtSubmit).toBeGreaterThanOrEqual(3);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('queues a quick second submit behind the first while its paste settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-settle-race-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const pasted: string[] = [];
    let releaseRender!: () => void;
    let markReached!: () => void;
    const rendered = new Promise<void>(resolve => { releaseRender = resolve; });
    const reached = new Promise<void>(resolve => { markReached = resolve; });
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); return true; },
      // block the first render check so the second submit arrives mid-settle
      capture: async () => { markReached(); await rendered; return '› msg1 '; },
      sendKeys: async () => true,
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      const first = service.submit(agent.id, 'msg1');
      await reached;   // msg1 is settling; its scope is held
      await expect(service.submit(agent.id, 'msg2')).resolves.toBe(true);
      // msg2 was not pasted onto the settling composer; it queued behind msg1
      expect(pasted).toEqual(['msg1']);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'msg2' }]);
      releaseRender();
      await expect(first).resolves.toBe(true);
      expect(pasted).toEqual(['msg1']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
