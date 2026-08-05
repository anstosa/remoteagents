import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maxPromptAttachmentBytes, PromptService } from '../src/prompts/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
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
  const discovery = { target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { calls.push(prompt.trimEnd()); return true; },
    queue: async () => true,
    enter: async () => true,
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

    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    expect(calls).toEqual(['Second managed prompt']);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'First managed prompt' }]);

    await service.observe(mutableAgent);
    expect(calls).toHaveLength(1);
    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    expect(calls).toEqual(['Second managed prompt', 'First managed prompt']);
    expect(recorded).toEqual(['Second managed prompt', 'First managed prompt']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps a dispatching prompt durable when delivery fails while another prompt is enqueued', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-durable-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = { ...agent, title: '⠋ Working' };
  const pasted: string[] = [];
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
    interrupt: async () => true
  };
  const service = new PromptService(discovery as never, tmux as never, [], undefined, queue);
  try {
    await expect(service.submit(agent.id, 'First durable prompt')).resolves.toBe(true);
    await expect(service.submit(agent.id, 'Second durable prompt')).resolves.toBe(true);

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
