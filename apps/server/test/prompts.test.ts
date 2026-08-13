import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maxPromptAttachmentBytes, PromptService } from '../src/prompts/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { SavedPromptService } from '../src/saved-prompts/service.js';
const socket={fingerprint:'socket',path:'/tmp/sock',device:1,inode:1}; const agent={id:'socket:%1',paneId:'%1',sessionId:'socket:$1',socketFingerprint:'socket',workspace:'/tmp',title:''};
it('allows prompt attachments totaling 25 MiB', () => {
  expect(maxPromptAttachmentBytes).toBe(25 * 1024 * 1024);
});
describe('safe prompt flow',()=>{it('pastes through a generated buffer and uses Tab to queue after the active turn',async()=>{const calls:string[][]=[];const discovery={target:async()=>({agent,socket})};const tmux={pastePrompt:async(_s:unknown,_p:string,b:string,p:string)=>{calls.push(['paste',b,p]);return true},queue:async(_s:unknown,p:string)=>{calls.push(['tab',p]);return true},interrupt:async()=>true};const service=new PromptService(discovery as never,tmux as never);await expect(service.submit(agent.id,'hello; $(not-a-command)')).resolves.toBe(true);expect(calls[0]?.[0]).toBe('paste');expect(calls[0]?.[2]).toBe('hello; $(not-a-command) ');expect(calls.slice(1)).toEqual([['tab','%1']]);expect(calls[0]?.[1]).toMatch(/^rac-/)});it('stages attached files in a Git-ignored location and references each one in the queued prompt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rac-attachments-'));
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');
  execFileSync('/usr/bin/git', ['init', '--quiet', workspace]);
  const attachedAgent = { ...agent, workspace };
  const pasted: string[] = [];
  const discovery = { target: async () => ({ agent: attachedAgent, socket }) };
  const tmux = { pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt); return true; }, queue: async () => true, interrupt: async () => true };
  try {
    const service = new PromptService(discovery as never, tmux as never);
    await expect(service.submit(attachedAgent.id, 'Review this.', [{ name: 'notes.txt', data: Buffer.from('attachment body').toString('base64') }])).resolves.toBe(true);
    expect(pasted[0]).toMatch(/Attached files:\n@node_modules\/\.remote-agent-console\/attachments\/.+\/notes\.txt /);
    const path = /@(node_modules\/[^\s]+)/.exec(pasted[0] ?? '')?.[1];
    expect(path).toBeDefined();
    await expect(readFile(join(workspace, path!), 'utf8')).resolves.toBe('attachment body');
    expect(execFileSync('/usr/bin/git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' })).not.toContain('node_modules');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

it('maps a discovered host worktree path to its mounted workspace before staging attachments', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rac-mounted-'));
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');
  execFileSync('/usr/bin/git', ['init', '--quiet', workspace]);
  const discoveredAgent = { ...agent, workspace: '/host/worktree' };
  const pasted: string[] = [];
  const discovery = { target: async () => ({ agent: discoveredAgent, socket }) };
  const tmux = { pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt); return true; }, queue: async () => true, interrupt: async () => true };
  try {
    const service = new PromptService(discovery as never, tmux as never, [{ id: 'worktree', label: 'Worktree', path: workspace, identity: workspace, hostPath: '/host/worktree', available: true, pinned: false }]);
    await expect(service.submit(discoveredAgent.id, 'Read.', [{ name: 'notes.txt', data: Buffer.from('mounted').toString('base64') }])).resolves.toBe(true);
    const path = /@(node_modules\/[^\s]+)/.exec(pasted[0] ?? '')?.[1];
    await expect(readFile(join(workspace, path!), 'utf8')).resolves.toBe('mounted');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

it('records successful submissions in the configured worktree history', async () => {
  const recorded: Array<[string, string]> = [];
  let submissions = 0;
  const discovery = { target: async () => ({ agent, socket }) };
  const tmux = { pastePrompt: async () => true, queue: async () => ++submissions === 1, interrupt: async () => true };
  const history = { record: async (scope: string, text: string) => { recorded.push([scope, text]); } };
  const worktree = { id: 'cora', label: 'Cora', path: '/tmp', identity: '/tmp', available: true, pinned: false };
  const service = new PromptService(discovery as never, tmux as never, [worktree], history as never);

  await expect(service.submit(agent.id, 'first prompt')).resolves.toBe(true);
  await expect(service.submit(agent.id, 'failed prompt')).resolves.toBe(false);

  expect(recorded).toEqual([['worktree:cora', 'first prompt']]);
});

// capture fast responses between dashboard polls
it('records the final assistant answer when the busy state is missed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-answer-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = { ...agent, title: 'Ready' };
  const completed: Array<[string, string, string]> = [];
  const historyEntry = { id: 'prompt-history-001', text: 'Summarize this', createdAt: '2026-08-07T01:00:00.000Z' };
  const discovery = { target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async () => true,
    queue: async () => true,
    capture: async () => ['› Summarize this', '', '• Final summary', '', '  - One detail', '─ Worked for 2s', ''].join('\n'),
    interrupt: async () => true
  };
  const history = {
    record: async () => historyEntry,
    recordAnswer: async (scope: string, entryId: string, answer: string) => {
      completed.push([scope, entryId, answer]);
      return { ...historyEntry, answer, answeredAt: '2026-08-07T01:00:02.000Z' };
    }
  };
  const service = new PromptService(discovery as never, tmux as never, [], history as never, queue);
  try {
    await expect(service.submit(agent.id, 'Summarize this')).resolves.toBe(true);
    await service.observe(mutableAgent);

    expect(completed).toEqual([['agent:socket:%1', historyEntry.id, 'Final summary\n\n- One detail']]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// retain completion tracking until the terminal response is capturable
it('retries answer recording after the agent first appears finished', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-answer-race-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = { ...agent, title: 'Ready' };
  const completed: string[] = [];
  const historyEntry = { id: 'prompt-history-race', text: 'Explain the race', createdAt: '2026-08-07T01:00:00.000Z' };
  let capture = ['› Explain the race', '', '• Still rendering'].join('\n');
  const discovery = { target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async () => true,
    queue: async () => true,
    capture: async () => capture,
    interrupt: async () => true
  };
  const history = {
    record: async () => historyEntry,
    // collect persisted answers
    recordAnswer: async (_scope: string, _entryId: string, answer: string) => {
      completed.push(answer);
      return { ...historyEntry, answer, answeredAt: '2026-08-07T01:00:02.000Z' };
    }
  };
  const service = new PromptService(discovery as never, tmux as never, [], history as never, queue);
  try {
    await expect(service.submit(agent.id, 'Explain the race')).resolves.toBe(true);
    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);

    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    expect(completed).toEqual([]);

    capture = ['› Explain the race', '', '• Final answer', '', '─ Worked for 1s', ''].join('\n');
    await service.observe(mutableAgent);

    expect(completed).toEqual(['Final answer']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// retry transient history storage failures
it('does not settle completion until the answer is stored in history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-answer-storage-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = { ...agent, title: 'Ready' };
  const historyEntry = { id: 'prompt-history-storage', text: 'Persist this', createdAt: '2026-08-07T01:00:00.000Z' };
  let attempts = 0;
  const discovery = { target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async () => true,
    queue: async () => true,
    capture: async () => ['› Persist this', '', '• Durable answer', '', '─ Worked for 1s', ''].join('\n'),
    interrupt: async () => true
  };
  const history = {
    record: async () => historyEntry,
    // fail the first persistence attempt
    recordAnswer: async (_scope: string, _entryId: string, answer: string) => {
      attempts += 1;
      return attempts === 1 ? undefined : { ...historyEntry, answer, answeredAt: '2026-08-07T01:00:02.000Z' };
    }
  };
  const service = new PromptService(discovery as never, tmux as never, [], history as never, queue);
  try {
    await expect(service.submit(agent.id, 'Persist this')).resolves.toBe(true);
    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);

    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    await service.observe(mutableAgent);

    expect(attempts).toBe(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('submits Codex shell-mode commands with Enter instead of queueing Tab', async () => {
  const calls: string[][] = [];
  const discovery = { target: async () => ({ agent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, buffer: string, prompt: string) => { calls.push(['paste', buffer, prompt]); return true; },
    enter: async (_socket: unknown, pane: string) => { calls.push(['enter', pane]); return true; },
    queue: async (_socket: unknown, pane: string) => { calls.push(['queue', pane]); return true; },
    interrupt: async () => true
  };

  await expect(new PromptService(discovery as never, tmux as never).submit(agent.id, '!git status')).resolves.toBe(true);

  expect(calls[0]?.[0]).toBe('paste');
  expect(calls[0]?.[2]).toBe('!git status');
  expect(calls.slice(1)).toEqual([['enter', '%1']]);
});

it('holds prompts while an agent works and dispatches them in the managed order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-managed-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = { ...agent, title: '⠋ Working' };
  const calls: string[] = [];
  const recorded: string[] = [];
  let capture = ['› Active prompt', '', '• Working'].join('\n');
  const discovery = { target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { calls.push(prompt.trimEnd()); return true; },
    queue: async () => true,
    enter: async () => true,
    capture: async () => capture,
    interrupt: async () => true
  };
  const history = { record: async (_scope: string, text: string) => { recorded.push(text); } };
  const service = new PromptService(discovery as never, tmux as never, [], history as never, queue);
  try {
    await expect(service.submit(agent.id, 'First managed prompt')).resolves.toBe(true);
    await expect(service.submit(agent.id, 'Second managed prompt')).resolves.toBe(true);
    const waiting = await service.listQueued(agent.id);
    expect(waiting?.map(prompt => prompt.text)).toEqual(['First managed prompt', 'Second managed prompt']);
    await service.moveQueued(agent.id, waiting![1]!.id, 'earlier');

    capture = ['› Active prompt', '', '• Completed successfully', '', '─ Worked for 1s', ''].join('\n');
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    expect(calls).toEqual(['Second managed prompt']);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'First managed prompt' }]);

    await service.observe(mutableAgent);
    expect(calls).toHaveLength(1);
    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);
    capture = ['› Second managed prompt', '', '• Completed successfully', '', '─ Worked for 1s', ''].join('\n');
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    expect(calls).toEqual(['Second managed prompt', 'First managed prompt']);
    expect(recorded).toEqual(['Second managed prompt', 'First managed prompt']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('saves queued prompts instead of dispatching them after active work fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-failed-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const saved = new SavedPromptService(join(directory, 'saved.json'));
  const mutableAgent = { ...agent, title: '⠋ Working' };
  const pasted: string[] = [];
  let capture = ['› Earlier prompt', '', '• Earlier answer', '', '─ Worked for 1s', '', '› Active prompt', '', '• Working'].join('\n');
  const discovery = { target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt.trimEnd()); return true; },
    queue: async () => true,
    enter: async () => true,
    capture: async () => capture,
    interrupt: async () => true
  };
  const service = new PromptService(discovery as never, tmux as never, [], undefined, queue, saved);
  try {
    await expect(service.submit(agent.id, 'First queued prompt')).resolves.toBe(true);
    await expect(service.submit(agent.id, 'Second queued prompt', [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }])).resolves.toBe(true);

    capture = ['› Earlier prompt', '', '• Earlier answer', '', '─ Worked for 1s', '', '› Active prompt', '', '■ Request failed', ''].join('\n');
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);

    expect(pasted).toEqual([]);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    await expect(saved.list(agent.id)).resolves.toMatchObject([
      { text: 'Second queued prompt', attachments: [{ name: 'context.txt', size: 7 }] },
      { text: 'First queued prompt' }
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps a failed queue transfer halted until every prompt is saved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-halted-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = { ...agent, title: '⠋ Working' };
  const pasted: string[] = [];
  const transferred: string[] = [];
  let saveSucceeds = false;
  const discovery = { target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt.trimEnd()); return true; },
    queue: async () => true,
    enter: async () => true,
    capture: async () => ['› Active prompt', '', '■ Cancelled', ''].join('\n'),
    interrupt: async () => true
  };
  const saved = {
    // simulate transient saved-prompt storage failure
    save: async (_scope: string, text: string) => {
      if (!saveSucceeds) return undefined;
      transferred.push(text);
      return { id: 'saved-prompt-id', text };
    }
  };
  const service = new PromptService(discovery as never, tmux as never, [], undefined, queue, saved as never);
  try {
    await expect(service.submit(agent.id, 'Queued after cancellation')).resolves.toBe(true);
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    await service.observe(mutableAgent);

    expect(pasted).toEqual([]);
    expect(transferred).toEqual([]);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'Queued after cancellation' }]);

    saveSucceeds = true;
    await service.observe(mutableAgent);

    expect(transferred).toEqual(['Queued after cancellation']);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('marks queued prompts for saving when cancellation succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-cancelled-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const saved = new SavedPromptService(join(directory, 'saved.json'));
  const mutableAgent = { ...agent, title: '⠋ Working' };
  const interrupts: string[] = [];
  const discovery = { target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async () => true,
    queue: async () => true,
    enter: async () => true,
    capture: async () => ['› Active prompt', '', '• Completed successfully', '', '─ Worked for 1s', ''].join('\n'),
    interrupt: async (_socket: unknown, pane: string) => { interrupts.push(pane); return true; }
  };
  const service = new PromptService(discovery as never, tmux as never, [], undefined, queue, saved);
  try {
    await expect(service.submit(agent.id, 'Do not run this')).resolves.toBe(true);
    await expect(service.cancel(agent.id)).resolves.toBe(true);
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);

    expect(interrupts).toEqual(['%1']);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    await expect(saved.list(agent.id)).resolves.toMatchObject([{ text: 'Do not run this' }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps a dispatching prompt durable when delivery fails while another prompt is enqueued', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-durable-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = { ...agent, title: '⠋ Working' };
  const pasted: string[] = [];
  let capture = ['› Active prompt', '', '• Working'].join('\n');
  let deliveryResult = false;
  let releasePaste: (() => void) | undefined;
  let pasteStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { pasteStarted = resolve; });
  const blocked = new Promise<void>(resolve => { releasePaste = resolve; });
  const discovery = { target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => {
      pasted.push(prompt.trimEnd());
      pasteStarted?.();
      await blocked;
      return deliveryResult;
    },
    queue: async () => true,
    enter: async () => true,
    capture: async () => capture,
    interrupt: async () => true
  };
  const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
  try {
    await expect(service.submit(agent.id, 'First durable prompt')).resolves.toBe(true);
    await expect(service.submit(agent.id, 'Second durable prompt')).resolves.toBe(true);

    capture = ['› Active prompt', '', '• Completed successfully', '', '─ Worked for 1s', ''].join('\n');
    mutableAgent.title = 'Ready';
    const dispatch = service.observe(mutableAgent);
    await started;
    await expect(new QueuedPromptService(join(directory, 'queue.json')).list(`agent:${agent.id}`)).resolves.toMatchObject([
      { text: 'First durable prompt' },
      { text: 'Second durable prompt' }
    ]);
    await expect(service.submit(agent.id, 'Concurrently queued prompt')).resolves.toBe(true);
    releasePaste?.();
    await dispatch;

    await expect(new QueuedPromptService(join(directory, 'queue.json')).list(`agent:${agent.id}`)).resolves.toMatchObject([
      { text: 'First durable prompt' },
      { text: 'Second durable prompt' },
      { text: 'Concurrently queued prompt' }
    ]);

    deliveryResult = true;
    await service.observe(mutableAgent);
    expect(pasted).toEqual(['First durable prompt', 'First durable prompt']);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([
      { text: 'Second durable prompt' },
      { text: 'Concurrently queued prompt' }
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('dismisses composer autocomplete before queuing a skill or plugin prompt',async()=>{const pasted:string[]=[];const discovery={target:async()=>({agent,socket})};const tmux={pastePrompt:async(_s:unknown,_p:string,_b:string,p:string)=>{pasted.push(p);return true},queue:async()=>true,interrupt:async()=>true};const service=new PromptService(discovery as never,tmux as never);await expect(service.submit(agent.id,'Use $my-plugin')).resolves.toBe(true);await expect(service.submit(agent.id,'/skill already resolved ')).resolves.toBe(true);expect(pasted).toEqual(['Use $my-plugin ','/skill already resolved '])});it('does not queue a stale target',async()=>{let count=0;const discovery={target:async()=>++count===1?{agent,socket}:undefined};const tmux={pastePrompt:async()=>true,queue:async()=>true,interrupt:async()=>true};const service=new PromptService(discovery as never,tmux as never);await expect(service.submit(agent.id,'synthetic')).resolves.toBe(false)});it('sends Ctrl-C only to the discovered agent pane',async()=>{const calls:string[][]=[];const discovery={target:async()=>({agent,socket})};const tmux={interrupt:async(_s:unknown,p:string)=>{calls.push(['interrupt',p]);return true}};const service=new PromptService(discovery as never,tmux as never);await expect(service.cancel(agent.id)).resolves.toBe(true);expect(calls).toEqual([['interrupt','%1']])});it('kills only the discovered pane when deleting an agent',async()=>{const calls:string[][]=[];const discovery={target:async()=>({agent,socket})};const tmux={close:async(_s:unknown,p:string)=>{calls.push(['close',p]);return true}};const service=new PromptService(discovery as never,tmux as never);await expect(service.close(agent.id)).resolves.toBe(true);expect(calls).toEqual([['close','%1']])})});
