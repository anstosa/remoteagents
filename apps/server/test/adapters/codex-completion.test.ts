import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexRolloutBaseline, codexTurnSince, completionFromRecords, maxOrdinalFromRecords } from '../../src/adapters/codex-conversations.js';

const cleanups: string[] = [];
const savedEnv = { proc: process.env.RAC_HOST_PROC, home: process.env.CODEX_HOME };

afterEach(async () => {
  process.env.RAC_HOST_PROC = savedEnv.proc;
  process.env.CODEX_HOME = savedEnv.home;
  await Promise.all(cleanups.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

type Record = { type: string; ordinal: number; payload: unknown };

// one turn's lifecycle as Codex records it: task_started, the response items, then a
// terminal task_complete carrying the answer (a real rollout, trimmed to essentials)
const turnRecords = (base: number, turnId: string, prompt: string, answer: string): Record[] => [
  { type: 'response_item', ordinal: base, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
  { type: 'event_msg', ordinal: base + 1, payload: { type: 'task_started', turn_id: turnId, started_at: '2026-08-30T15:32:24.000Z' } },
  { type: 'response_item', ordinal: base + 2, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } },
  { type: 'event_msg', ordinal: base + 3, payload: { type: 'task_complete', turn_id: turnId, last_agent_message: answer, duration_ms: 1200, completed_at: '2026-08-30T15:32:25.200Z' } }
];

// write one representative Codex rollout with ordinal-stamped records, returning its path
async function writeRollout(home: string, id: string, records: Record[], cwd = '/home/ubuntu/cora'): Promise<string> {
  const directory = join(home, 'sessions', '2026', '08', '30');
  await mkdir(directory, { recursive: true });
  const meta = { type: 'session_meta', ordinal: 0, payload: { id, cwd, timestamp: '2026-08-30T15:32:23.000Z', originator: 'codex-tui' } };
  const file = join(directory, `rollout-2026-08-30T15-32-23-${id}.jsonl`);
  await writeFile(file, `${[meta, ...records].map(line => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

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

const lines = (records: Record[]): string[] => records.map(record => JSON.stringify(record));

describe('Codex rollout completion', () => {
  it('reads a completed turn and its answer from the task_complete event', () => {
    const records = turnRecords(1, 't1', 'Summarize the change', 'It renames the flag.');
    expect(completionFromRecords(lines(records), 0)).toEqual({ kind: 'completed', ordinal: 4, answer: 'It renames the flag.' });
  });

  it('only reports turns recorded past the baseline ordinal', () => {
    const records = [...turnRecords(1, 't1', 'First', 'First answer'), ...turnRecords(5, 't2', 'Second', 'Second answer')];
    // baseline just before the second turn: the first turn's completion is ignored
    expect(completionFromRecords(lines(records), 4)).toEqual({ kind: 'completed', ordinal: 8, answer: 'Second answer' });
    // baseline at or past the newest completion: nothing new yet
    expect(completionFromRecords(lines(records), 8)).toEqual({ kind: 'pending' });
  });

  it('reports an interrupted turn as aborted', () => {
    const records: Record[] = [
      { type: 'response_item', ordinal: 1, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do it' }] } },
      { type: 'event_msg', ordinal: 2, payload: { type: 'task_started', turn_id: 't1', started_at: '2026-08-30T15:32:24.000Z' } },
      { type: 'event_msg', ordinal: 3, payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted', duration_ms: 400, completed_at: '2026-08-30T15:32:24.400Z' } }
    ];
    expect(completionFromRecords(lines(records), 0)).toEqual({ kind: 'aborted', ordinal: 3 });
  });

  it('stays pending while only task_started has been recorded', () => {
    const records: Record[] = [
      { type: 'response_item', ordinal: 1, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do it' }] } },
      { type: 'event_msg', ordinal: 2, payload: { type: 'task_started', turn_id: 't1', started_at: '2026-08-30T15:32:24.000Z' } }
    ];
    expect(completionFromRecords(lines(records), 0)).toEqual({ kind: 'pending' });
  });

  it('ignores truncated JSON lines and honours the newest terminal event', () => {
    const records = turnRecords(1, 't1', 'Prompt', 'Answer');
    expect(completionFromRecords([...lines(records), '{"type":"event_msg","ordina'], 0)).toEqual({ kind: 'completed', ordinal: 4, answer: 'Answer' });
  });

  it('reports the max ordinal as a baseline, skipping unparseable lines', () => {
    const records = turnRecords(1, 't1', 'Prompt', 'Answer');
    expect(maxOrdinalFromRecords([...lines(records), 'not json'])).toBe(4);
    expect(maxOrdinalFromRecords([])).toBeUndefined();
  });

  it('resolves the pane rollout by fd-walk and reads its baseline and newest completion', async () => {
    const home = await codexHome();
    const id = '0198d100-0000-7000-8000-000000000001';
    const file = await writeRollout(home, id, turnRecords(1, 't1', 'Add the reader', 'Reader added.'));
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, [file]);

    // session_meta(0) + 4 turn records -> max ordinal 4, pinned to the resolved file
    await expect(codexRolloutBaseline({ pid: 321 })).resolves.toEqual({ rollout: file, ordinal: 4 });
    await expect(codexTurnSince({ rollout: file, ordinal: 0 })).resolves.toEqual({ kind: 'completed', ordinal: 4, answer: 'Reader added.' });
    await expect(codexTurnSince({ rollout: file, ordinal: 4 })).resolves.toEqual({ kind: 'pending' });
  });

  it('falls back to the working-directory match when the fd-walk is blocked', async () => {
    const home = await codexHome();
    const id = '0198d100-0000-7000-8000-000000000002';
    // writeRollout records cwd '/home/ubuntu/cora' in session_meta
    const file = await writeRollout(home, id, turnRecords(1, 't1', 'Add it', 'Added.'));
    process.env.CODEX_HOME = home;
    // no descriptors: a confined service cannot readlink a sandboxed pane's fds
    process.env.RAC_HOST_PROC = await fakeProc(321, []);

    await expect(codexRolloutBaseline({ pid: 321, cwd: '/home/ubuntu/cora' })).resolves.toEqual({ rollout: file, ordinal: 4 });
    // a non-matching directory resolves nothing rather than a stranger's rollout
    await expect(codexRolloutBaseline({ pid: 321, cwd: '/home/ubuntu/other' })).resolves.toBeUndefined();
  });

  it('matches the raw host cwd even when realpath resolves elsewhere (Docker bind mounts)', async () => {
    const home = await codexHome();
    // the host worktree the pane reports (`#{pane_current_path}`) is, inside the
    // container, a symlink whose realpath differs — as a differently bind-mounted
    // worktree would be; Codex recorded that same host path string in session_meta
    const realDir = await mkdtemp(join(tmpdir(), 'rac-real-'));
    cleanups.push(realDir);
    const linkParent = await mkdtemp(join(tmpdir(), 'rac-link-'));
    cleanups.push(linkParent);
    const hostCwd = join(linkParent, 'project');
    await symlink(realDir, hostCwd);
    const id = '0198d100-0000-7000-8000-000000000003';
    const file = await writeRollout(home, id, turnRecords(1, 't1', 'Do it', 'Done.'), hostCwd);
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, []);

    // realpath(hostCwd) === realDir !== hostCwd, so only the raw-string match resolves it
    await expect(codexRolloutBaseline({ pid: 321, cwd: hostCwd })).resolves.toEqual({ rollout: file, ordinal: 4 });
  });

  it('returns undefined when neither the fd-walk nor the cwd resolves a rollout', async () => {
    process.env.CODEX_HOME = await codexHome();
    process.env.RAC_HOST_PROC = await fakeProc(321, []);
    await expect(codexRolloutBaseline({ pid: 321 })).resolves.toBeUndefined();
    await expect(codexRolloutBaseline({ pid: 321, cwd: '/home/ubuntu/cora' })).resolves.toBeUndefined();
    // a pinned rollout that no longer exists reads as undefined, not a throw
    await expect(codexTurnSince({ rollout: join(tmpdir(), 'rac-missing-rollout.jsonl'), ordinal: 0 })).resolves.toBeUndefined();
  });
});
