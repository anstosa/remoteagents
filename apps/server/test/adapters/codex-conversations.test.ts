import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexConversationTitle, discoverCodexConversation, openRollouts, validCodexThreadId } from '../../src/adapters/codex-conversations.js';

const cleanups: string[] = [];
const savedEnv = { proc: process.env.RAC_HOST_PROC, home: process.env.CODEX_HOME };

afterEach(async () => {
  process.env.RAC_HOST_PROC = savedEnv.proc;
  process.env.CODEX_HOME = savedEnv.home;
  await Promise.all(cleanups.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// write one representative Codex rollout, returning its absolute path
async function writeSession(home: string, name: string, session: { id: string; cwd: string; prompt: string; parentThreadId?: string }): Promise<string> {
  const directory = join(home, 'sessions', '2026', '08', '20');
  await mkdir(directory, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { id: session.id, cwd: session.cwd, timestamp: '2026-08-20T19:00:00.000Z', originator: 'codex-tui', ...(session.parentThreadId === undefined ? {} : { parent_thread_id: session.parentThreadId }) } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: session.prompt }] } }
  ];
  const file = join(directory, `${name}-${session.id}.jsonl`);
  await writeFile(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

// build a fake /proc tree whose one pid holds the given files open
async function fakeProc(pid: number, files: string[]): Promise<string> {
  const proc = await mkdtemp(join(tmpdir(), 'rac-proc-'));
  cleanups.push(proc);
  await mkdir(join(proc, String(pid), 'task', String(pid)), { recursive: true });
  await writeFile(join(proc, String(pid), 'task', String(pid), 'children'), '');
  const fd = join(proc, String(pid), 'fd');
  await mkdir(fd, { recursive: true });
  await Promise.all(files.map((file, index) => symlink(file, join(fd, String(index + 3)))));
  return proc;
}

async function codexHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'rac-codex-home-'));
  cleanups.push(home);
  return home;
}

describe('Codex conversation lookup', () => {
  it('validates exact thread ids', () => {
    expect(validCodexThreadId('0198c333-3333-7333-8333-333333333333')).toBe(true);
    expect(validCodexThreadId('not-a-uuid')).toBe(false);
    expect(validCodexThreadId('0198c333-3333-7333-8333')).toBe(false);
  });

  it('discovers the pane top-level conversation and its title', async () => {
    const home = await codexHome();
    const current = await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c333-3333-7333-8333-333333333333', cwd: '/home/ubuntu/cora', prompt: 'Add shared worktree bookmarks with a useful title' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, [current]);

    await expect(discoverCodexConversation({ pid: 123 })).resolves.toEqual({ id: '0198c333-3333-7333-8333-333333333333', title: 'Add shared worktree bookmarks with a useful title' });
  });

  it('ignores child threads and keeps the single top-level rollout', async () => {
    const home = await codexHome();
    const parent = await writeSession(home, 'rollout-2026-08-20T10-00-00', { id: '0198c111-1111-7111-8111-111111111111', cwd: '/home/ubuntu/cora', prompt: 'Top level' });
    const child = await writeSession(home, 'rollout-2026-08-20T11-00-00', { id: '0198c222-2222-7222-8222-222222222222', cwd: '/home/ubuntu/cora', prompt: 'Child task', parentThreadId: '0198c111-1111-7111-8111-111111111111' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, [parent, child]);

    await expect(discoverCodexConversation({ pid: 123 })).resolves.toMatchObject({ id: '0198c111-1111-7111-8111-111111111111' });
  });

  it('falls back to the working-directory match when the fd-walk is blocked', async () => {
    const home = await codexHome();
    await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c666-6666-7666-8666-666666666666', cwd: '/home/ubuntu/cora', prompt: 'Bookmark me from a confined service' });
    process.env.CODEX_HOME = home;
    // no descriptors: a confined service cannot readlink the pane's fds
    process.env.RAC_HOST_PROC = await fakeProc(123, []);

    await expect(discoverCodexConversation({ pid: 123, cwd: '/home/ubuntu/cora' })).resolves.toEqual({ id: '0198c666-6666-7666-8666-666666666666', title: 'Bookmark me from a confined service' });
    // a non-matching directory resolves nothing rather than a stranger's conversation
    await expect(discoverCodexConversation({ pid: 123, cwd: '/home/ubuntu/other' })).resolves.toBeUndefined();
    await expect(discoverCodexConversation({ pid: 123 })).resolves.toBeUndefined();
  });

  it('fails closed when the pane holds two top-level rollouts', async () => {
    const home = await codexHome();
    const first = await writeSession(home, 'rollout-2026-08-20T10-00-00', { id: '0198c111-1111-7111-8111-111111111111', cwd: '/home/ubuntu/cora', prompt: 'First open chat' });
    const second = await writeSession(home, 'rollout-2026-08-20T11-00-00', { id: '0198c333-3333-7333-8333-333333333333', cwd: '/home/ubuntu/cora', prompt: 'Second open chat' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, [first, second]);

    await expect(discoverCodexConversation({ pid: 123 })).resolves.toBeUndefined();
  });

  it('reads open rollout identities from the fd table', async () => {
    const home = await codexHome();
    const file = await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c444-4444-7444-8444-444444444444', cwd: '/home/ubuntu/cora', prompt: 'Held open' });
    process.env.RAC_HOST_PROC = await fakeProc(123, [file]);

    await expect(openRollouts(123)).resolves.toEqual([{ id: '0198c444-4444-7444-8444-444444444444', relativePath: 'sessions/2026/08/20/rollout-2026-08-20T12-00-00-0198c444-4444-7444-8444-444444444444.jsonl' }]);
  });

  it('reads a reported conversation title by its unique id', async () => {
    const home = await codexHome();
    await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c555-5555-7555-8555-555555555555', cwd: '/home/ubuntu/cora', prompt: 'Reported conversation title' });
    process.env.CODEX_HOME = home;

    await expect(codexConversationTitle('0198c555-5555-7555-8555-555555555555')).resolves.toBe('Reported conversation title');
    // an unknown id yields no title
    await expect(codexConversationTitle('0198c999-9999-7999-8999-999999999999')).resolves.toBeUndefined();
  });

  it('falls back to no title when the latest prompt is outside the bounded tail', async () => {
    const home = await codexHome();
    const file = await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c888-8888-7888-8888-888888888888', cwd: '/home/ubuntu/cora', prompt: 'Prompt outside the bounded tail' });
    await appendFile(file, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(4_300_000) }] } })}\n`);
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, [file]);

    await expect(discoverCodexConversation({ pid: 123 })).resolves.toEqual({ id: '0198c888-8888-7888-8888-888888888888' });
  });
});
