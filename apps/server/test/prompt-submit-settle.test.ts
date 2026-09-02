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
    let submitted = false;
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      // the composer is empty for the first polls, then renders the pasted prompt
      capture: async () => { captures += 1; return submitted || captures < 3 ? '› ' : '› render me '; },
      sendKeys: async () => { capturesAtSubmit = captures; submitted = true; return true; },
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'render me');
      await service.observe(agent);
      // the submit key was held until the paste had rendered, not fired against an empty composer
      expect(capturesAtSubmit).toBeGreaterThanOrEqual(3);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // preserve paragraph breaks while waiting for submission
  it('submits a multi-paragraph queued prompt after its complete draft renders', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-multiline-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const prompt = 'First paragraph.\n\nalpha · beta\n\nReply exactly MULTI_DONE.';
    const sent: string[][] = [];
    let submitted = false;
    // keep one stable target
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      // retain the composed prompt for the live snapshot
      pastePrompt: async () => true,
      // render blank composer rows exactly like Codex
      capture: async () => submitted
        ? ['› First paragraph.', '', '  alpha · beta', '', '  Reply exactly MULTI_DONE.', '', '• Working', '', '› Ask Codex to do anything'].join('\n')
        : ['› First paragraph.', '', '  alpha · beta', '', '  Reply exactly MULTI_DONE.', '', '  gpt-5.6-sol · ~/remoteagents · main'].join('\n'),
      // accept the queued prompt
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, prompt);
      await service.observe(agent);

      expect(sent).toEqual([['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // exclude footer text from durable acknowledgement
  it('does not mistake Codex status text for a live queued draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-status-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    let submissions = 0;
    // keep one stable target
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      // model a paste that never reaches the composer
      pastePrompt: async () => true,
      // expose the prompt text only at the start of the footer
      capture: async () => ['› ', '', '  gpt-5.6-sol · ~/remoteagents · main'].join('\n'),
      // count accidental submissions
      sendKeys: async () => { submissions += 1; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'gpt-5.6-sol');
      await service.observe(agent);

      expect(submissions).toBe(0);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'gpt-5.6-sol' }]);
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
    let submitted = false;
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); return true; },
      // block the first render check so the second submit arrives mid-settle
      capture: async () => { markReached(); await rendered; return submitted ? '› ' : '› msg1 '; },
      sendKeys: async () => { submitted = true; return true; },
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'msg1');
      const first = service.observe(agent);
      await reached;   // msg1 is settling; its scope is held
      await expect(service.submit(agent.id, 'msg2')).resolves.toBe(true);
      // msg2 was not pasted onto the settling composer; it queued behind msg1
      expect(pasted).toEqual(['msg1']);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'msg1' }, { text: 'msg2' }]);
      releaseRender();
      await expect(first).resolves.toBeUndefined();
      expect(pasted).toEqual(['msg1']);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'msg2' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not mistake matching scrollback text for the live composer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-settle-scrollback-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    let captures = 0;
    let capturesAtSubmit = -1;
    let submitted = false;
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      // keep matching text in history while the live composer is still empty
      capture: async () => {
        captures += 1;
        const composer = submitted || captures < 5 ? '› ' : '› repeated prompt ';
        return ['› repeated prompt', '', '• Previous answer', '', composer].join('\n');
      },
      sendKeys: async () => { capturesAtSubmit = captures; submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'repeated prompt');
      await service.observe(agent);
      // require the live composer rather than any matching history row
      expect(capturesAtSubmit).toBeGreaterThanOrEqual(7);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not submit when only matching prompt history is visible', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-history-only-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    let submissions = 0;
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => ['› repeated prompt', '', '• Previous answer', '', '─ Worked for 1s'].join('\n'),
      sendKeys: async () => { submissions += 1; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'repeated prompt');
      await service.observe(agent);
      expect(submissions).toBe(0);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'repeated prompt' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('chooses the active queue key after the composer settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-key-race-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const idle = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const working = stated({ ...idle, title: '⠋ Working' });
    let becameWorking = false;
    let submitted = false;
    const sent: string[][] = [];
    const discovery = { target: async () => ({ agent: becameWorking ? working : idle, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      // start external work during the settle window
      capture: async () => { becameWorking = true; return submitted ? '› ' : '› follow active work '; },
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(`agent:${idle.id}`, 'follow active work');
      await service.observe(idle);
      expect(sent).toEqual([['Tab']]);
      await expect(service.listQueued(idle.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('retains a direct prompt when the pane becomes active and Codex swallows Tab', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-direct-race-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const idle = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const working = stated({ ...idle, title: '⠋ Working' });
    let targets = 0;
    const sent: string[][] = [];
    // reclassify the target after the initial submit decision
    const discovery = { target: async () => ({ agent: targets++ === 0 ? idle : working, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => '› direct race ',
      // model every bounded Tab attempt being swallowed despite successful tmux delivery
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await expect(service.submit(idle.id, 'direct race')).resolves.toBe(true);
      expect(sent).toEqual([['Tab'], ['Tab'], ['Tab']]);
      await expect(service.listQueued(idle.id)).resolves.toMatchObject([{ text: 'direct race' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('retains a durable prompt when Codex leaves it in the composer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-unaccepted-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const scope = `agent:${agent.id}`;
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => '› durable prompt ',
      // model one swallowed key despite successful tmux delivery
      sendKeys: async () => true
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(scope, 'durable prompt');
      await service.observe(agent);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'durable prompt' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('retries a queued prompt when Codex swallows the first submit key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-retry-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const sent: string[][] = [];
    let submitted = false;
    // keep one stable target
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      // accept the paste
      pastePrompt: async () => true,
      // keep the server-owned draft visible until the retry reaches Codex
      capture: async () => submitted ? '› ' : '› retry me ',
      // swallow the first key while the prior turn finishes
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        sent.push(keys);
        // accept the retry
        if (sent.length === 2) submitted = true;
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    // verify retry delivery
    try {
      await queue.enqueue(`agent:${agent.id}`, 'retry me');
      await service.observe(agent);
      expect(sent).toEqual([['Enter'], ['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally {
      // remove test state
      await rm(directory, { recursive: true, force: true });
    }
  });

  // recognize Codex's dedicated shell composer
  it('submits a durable command from Codex shell mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-shell-mode-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const sent: string[][] = [];
    let submitted = false;
    // keep one stable target
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      // accept the shell paste
      pastePrompt: async () => true,
      // render Codex's real shell-mode marker and footer
      capture: async () => submitted
        ? ['• You ran git status', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol · /tmp'].join('\n')
        : ['! git status', '', '  gpt-5.6-sol · /tmp                                      Shell mode'].join('\n'),
      // accept the rendered shell command
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, '!git status');
      await service.observe(agent);

      expect(sent).toEqual([['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally {
      // remove test state
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains a durable shell command when Codex leaves it in the composer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-shell-unaccepted-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const scope = `agent:${agent.id}`;
    const sent: string[][] = [];
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      // keep the actual shell composer visible through every retry
      capture: async () => ['! git status', '', '  gpt-5.6-sol · /tmp                                      Shell mode'].join('\n'),
      // model every bounded Enter attempt being swallowed despite successful tmux delivery
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(scope, '!git status');
      await service.observe(agent);
      expect(sent).toEqual([['Enter'], ['Enter'], ['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: '!git status' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('submits a durable shell command after its collapsed draft renders', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-shell-collapsed-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    const command = `!${'x'.repeat(33)}`;
    let submitted = false;
    const sent: string[][] = [];
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => submitted ? '› ' : `› [Pasted Content ${command.length} chars]`,
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, command);
      await service.observe(agent);
      expect(sent).toEqual([['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('uses best-effort durable delivery for an Adapter without draft observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-generic-adapter-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/tmp', title: 'Ready' });
    let captures = 0;
    const discovery = { target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => { captures += 1; return 'another agent'; },
      sendKeys: async () => true
    };
    const adapter = {
      stateSource: 'title',
      submission: { prepare: (prompt: string) => ({ text: prompt, keys: ['Enter'] }), interrupt: ['C-c'], selectOption: () => ['Enter'] },
      turns: { latestCompleted: () => undefined, lastPrompt: () => undefined, latestMessage: () => undefined, failed: () => false }
    };
    const service = new PromptService(discovery as never, tmux as never, [], undefined, queue, undefined, () => adapter as never);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'generic prompt');
      await service.observe(agent);
      expect(captures).toBe(0);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
