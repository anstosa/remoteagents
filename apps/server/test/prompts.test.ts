import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptService } from '../src/prompts/service.js';
const socket={fingerprint:'socket',path:'/tmp/sock',device:1,inode:1}; const agent={id:'socket:%1',paneId:'%1',sessionId:'socket:$1',socketFingerprint:'socket',workspace:'/tmp',title:''};
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

it('dismisses composer autocomplete before queuing a skill or plugin prompt',async()=>{const pasted:string[]=[];const discovery={target:async()=>({agent,socket})};const tmux={pastePrompt:async(_s:unknown,_p:string,_b:string,p:string)=>{pasted.push(p);return true},queue:async()=>true,interrupt:async()=>true};const service=new PromptService(discovery as never,tmux as never);await expect(service.submit(agent.id,'Use $my-plugin')).resolves.toBe(true);await expect(service.submit(agent.id,'/skill already resolved ')).resolves.toBe(true);expect(pasted).toEqual(['Use $my-plugin ','/skill already resolved '])});it('does not queue a stale target',async()=>{let count=0;const discovery={target:async()=>++count===1?{agent,socket}:undefined};const tmux={pastePrompt:async()=>true,queue:async()=>true,interrupt:async()=>true};const service=new PromptService(discovery as never,tmux as never);await expect(service.submit(agent.id,'synthetic')).resolves.toBe(false)});it('sends Ctrl-C only to the discovered agent pane',async()=>{const calls:string[][]=[];const discovery={target:async()=>({agent,socket})};const tmux={interrupt:async(_s:unknown,p:string)=>{calls.push(['interrupt',p]);return true}};const service=new PromptService(discovery as never,tmux as never);await expect(service.cancel(agent.id)).resolves.toBe(true);expect(calls).toEqual([['interrupt','%1']])});it('kills only the discovered pane when deleting an agent',async()=>{const calls:string[][]=[];const discovery={target:async()=>({agent,socket})};const tmux={close:async(_s:unknown,p:string)=>{calls.push(['close',p]);return true}};const service=new PromptService(discovery as never,tmux as never);await expect(service.close(agent.id)).resolves.toBe(true);expect(calls).toEqual([['close','%1']])})});
