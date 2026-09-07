import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigDir, claudeConversationName, claudeConversationSummaries, validClaudeSessionId } from '../../src/adapters/claude-conversations.js';

const cwd = '/tachi/code/remoteagents';
const encoded = '-tachi-code-remoteagents';
const id = '11111111-2222-4333-8444-555555555555';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function transcript(lines: object[]): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), 'rac-claude-'));
  dirs.push(configDir);
  const projectDir = join(configDir, 'projects', encoded);
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, `${id}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n'));
  return configDir;
}
// write the per-session `custom-title.json` sidecar beside the transcript
async function writeSidecar(configDir: string, contents: object): Promise<void> {
  await writeRawSidecar(configDir, JSON.stringify(contents));
}
// write arbitrary (possibly corrupt) sidecar bytes, to exercise the parse guard
async function writeRawSidecar(configDir: string, raw: string): Promise<void> {
  const sidecarDir = join(configDir, 'projects', encoded, id);
  await mkdir(sidecarDir, { recursive: true });
  await writeFile(join(sidecarDir, 'custom-title.json'), raw);
}
const name = (configDir: string) => claudeConversationName(id, cwd, { RAC_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv);

describe('claude conversations', () => {
  it('accepts session UUIDs and rejects everything else', () => {
    expect(validClaudeSessionId(id)).toBe(true);
    expect(validClaudeSessionId('not-a-uuid')).toBe(false);
    expect(validClaudeSessionId('01998a4e-1c0b-7a90-bf22')).toBe(false);
  });

  it('resolves the config dir from the seam, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    expect(claudeConfigDir({ RAC_CLAUDE_CONFIG_DIR: '/seam', CLAUDE_CONFIG_DIR: '/real', HOME: '/home/x' } as NodeJS.ProcessEnv)).toBe('/seam');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/real', HOME: '/home/x' } as NodeJS.ProcessEnv)).toBe('/real');
    expect(claudeConfigDir({ HOME: '/home/x' } as NodeJS.ProcessEnv)).toBe('/home/x/.claude');
  });

  it('reads the last ai-title record', async () => {
    const configDir = await transcript([
      { type: 'mode', mode: 'normal', sessionId: id },
      { type: 'ai-title', aiTitle: 'First guess', sessionId: id },
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'hello there' } },
      { type: 'ai-title', aiTitle: 'Wire the Claude adapter', sessionId: id },
    ]);
    expect(await name(configDir)).toBe('Wire the Claude adapter');
  });

  it('prefers the human custom-title over an ai-title that follows it (the renamed-session bug)', async () => {
    // Claude re-emits an ai-title after every prompt boundary, so a renamed session's
    // transcript ends on a generated title; the human custom-title must still win
    const configDir = await transcript([
      { type: 'ai-title', aiTitle: 'auto guess one', sessionId: id },
      { type: 'custom-title', customTitle: 'diagnose-shell', sessionId: id },
      { type: 'agent-name', agentName: 'diagnose-shell', sessionId: id },
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'another prompt' } },
      { type: 'ai-title', aiTitle: 'auto guess two', sessionId: id },
    ]);
    expect(await name(configDir)).toBe('diagnose-shell');
  });

  it('reads the custom-title from the sidecar when the transcript carries none', async () => {
    // a `-p --name` run writes the transcript records but not the sidecar, and a
    // long transcript can push a re-emitted custom-title out of the head window; the
    // sidecar is an equal source for the human name
    const configDir = await transcript([
      { type: 'ai-title', aiTitle: 'generated title', sessionId: id },
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'the first prompt' } },
    ]);
    await writeSidecar(configDir, { customTitle: 'ship the release' });
    expect(await name(configDir)).toBe('ship the release');
  });

  it('treats an absent, malformed, or corrupt sidecar as unnamed, not an error', async () => {
    const configDir = await transcript([{ type: 'ai-title', aiTitle: 'generated title', sessionId: id }]);
    // no sidecar at all
    expect(await name(configDir)).toBe('generated title');
    // well-formed JSON missing the customTitle field
    await writeSidecar(configDir, { notATitle: 'x' });
    expect(await name(configDir)).toBe('generated title');
    // a genuinely corrupt sidecar the JSON parse must swallow
    await writeRawSidecar(configDir, '{ not json');
    expect(await name(configDir)).toBe('generated title');
  });

  it('falls back to the first typed human prompt when there is no title at all', async () => {
    const configDir = await transcript([
      { type: 'mode', mode: 'normal', sessionId: id },
      { type: 'user', promptSource: 'meta', origin: { kind: 'human' }, message: { content: 'system preamble' } },
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'the real first prompt' } },
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'a later prompt' } },
    ]);
    expect(await name(configDir)).toBe('the real first prompt');
  });

  it('ignores non-string prompt content and malformed lines', async () => {
    const configDir = await transcript([
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'blocks' }] } },
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'plain text wins' } },
    ]);
    expect(await name(configDir)).toBe('plain text wins');
  });

  it('normalizes whitespace and clamps a long name with an ellipsis', async () => {
    const spaced = await transcript([
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'first\n\tprompt   with   spaces' } },
    ]);
    expect(await name(spaced)).toBe('first prompt with spaces');
    const long = await transcript([{ type: 'custom-title', customTitle: 'x'.repeat(200), sessionId: id }]);
    const clamped = await name(long);
    expect(clamped).toHaveLength(120);
    expect(clamped!.endsWith('…')).toBe(true);
  });

  it('returns undefined for an unknown cwd, a bad id, or a missing transcript', async () => {
    const configDir = await transcript([{ type: 'ai-title', aiTitle: 'x', sessionId: id }]);
    expect(await claudeConversationName(id, undefined, { RAC_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(await claudeConversationName('bad', cwd, { RAC_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(await claudeConversationName(id, '/some/other/dir', { RAC_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('claude conversation list', () => {
  const dirA = '/tachi/code/remoteagents.worktrees/named-sessions';
  const dirB = '/tachi/code/remoteagents';
  const idFor = (n: number) => `${n.toString(16).padStart(8, '0')}-2222-4333-8444-555555555555`;
  const at = (iso: string) => Date.parse(iso);

  // the encoder ported into the reader, replicated here so a long-directory test can write
  // the transcript where the reader will look for it
  function encodeProject(dir: string): string {
    const dashed = dir.replace(/[^a-zA-Z0-9]/gu, '-');
    if (dashed.length <= 200) return dashed;
    let hash = 0;
    for (let index = 0; index < dir.length; index += 1) hash = ((hash << 5) - hash + dir.charCodeAt(index)) | 0;
    return `${dashed.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
  }

  async function configWith(...transcripts: Array<{ dir: string; id: string; records: object[]; mtimeMs?: number; sidecar?: object }>): Promise<string> {
    const configDir = await mkdtemp(join(tmpdir(), 'rac-claude-list-'));
    dirs.push(configDir);
    for (const { dir, id: sessionId, records, mtimeMs, sidecar } of transcripts) {
      const projectDir = join(configDir, 'projects', encodeProject(dir));
      await mkdir(projectDir, { recursive: true });
      const file = join(projectDir, `${sessionId}.jsonl`);
      await writeFile(file, records.map(record => JSON.stringify(record)).join('\n'));
      if (mtimeMs !== undefined) await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
      // the per-session `custom-title.json` sidecar beside the transcript
      if (sidecar !== undefined) {
        await mkdir(join(projectDir, sessionId), { recursive: true });
        await writeFile(join(projectDir, sessionId, 'custom-title.json'), JSON.stringify(sidecar));
      }
    }
    return configDir;
  }
  const list = (configDir: string, directories: string[]) => claudeConversationSummaries(directories, { RAC_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv);
  // a typed human turn with a timestamp, so a transcript has a faithful last-active time
  const turn = (content: string, iso: string) => ({ type: 'user', promptSource: 'typed', origin: { kind: 'human' }, entrypoint: 'cli', message: { content }, timestamp: iso });

  it('lists named conversations across directories, newest-active first, tagging automatic and directory', async () => {
    const configDir = await configWith(
      { dir: dirA, id: idFor(1), records: [{ type: 'custom-title', customTitle: 'alpha' }, turn('hi', '2026-09-05T12:00:00.000Z'), { type: 'ai-title', aiTitle: 'later guess' }] },
      { dir: dirA, id: idFor(2), records: [{ type: 'ai-title', aiTitle: 'beta' }, turn('yo', '2026-09-05T13:00:00.000Z')] },
      { dir: dirB, id: idFor(3), records: [{ type: 'custom-title', customTitle: 'gamma' }, turn('sup', '2026-09-05T11:00:00.000Z')] },
    );
    const listed = await list(configDir, [dirA, dirB]);
    expect(listed).toEqual([
      { id: idFor(2), name: 'beta', automatic: true, lastActiveAt: at('2026-09-05T13:00:00.000Z'), directory: dirA },
      { id: idFor(1), name: 'alpha', automatic: false, lastActiveAt: at('2026-09-05T12:00:00.000Z'), directory: dirA },
      { id: idFor(3), name: 'gamma', automatic: false, lastActiveAt: at('2026-09-05T11:00:00.000Z'), directory: dirB },
    ]);
  });

  it('excludes unnamed, empty, and SDK/print-mode transcripts', async () => {
    const configDir = await configWith(
      { dir: dirA, id: idFor(1), records: [{ type: 'custom-title', customTitle: 'kept' }, turn('hi', '2026-09-05T12:00:00.000Z')] },
      // no title record at all → unnamed, not listed (no first-prompt fallback for listing)
      { dir: dirA, id: idFor(2), records: [turn('an unnamed conversation', '2026-09-05T12:30:00.000Z')] },
      // a 0-byte transcript has no message record and is skipped before its name is read —
      // the sidecar here proves the skip is load-bearing (without it the sidecar name would list it)
      { dir: dirA, id: idFor(3), records: [], sidecar: { customTitle: 'empty but sidecar-named' } },
      // a named `-p`/SDK run is persisted but hidden from the picker
      { dir: dirA, id: idFor(4), records: [{ type: 'custom-title', customTitle: 'sdk run' }, { type: 'user', promptSource: 'sdk', entrypoint: 'sdk-cli', message: { content: 'x' }, timestamp: '2026-09-05T14:00:00.000Z' }] },
    );
    const listed = await list(configDir, [dirA]);
    expect(listed.map(row => row.name)).toEqual(['kept']);
  });

  it('reads the bounded tail: a newer title and timestamp beyond the head window win', async () => {
    // a transcript larger than the 128 KB head window and the 256 KB tail window: the head
    // sees only the early title/timestamp, the tail carries the re-emitted newer ones. Proves
    // the tail is scanned (last record wins) and recency is the last timestamped record.
    const filler = Array.from({ length: 3000 }, (_, index) => ({ type: 'assistant', message: { content: `filler ${index} ${'x'.repeat(90)}` } }));
    const records = [
      { type: 'custom-title', customTitle: 'head-name' },
      turn('early turn', '2026-09-05T09:00:00.000Z'),
      ...filler,
      { type: 'custom-title', customTitle: 'tail-name' },
      turn('late turn', '2026-09-05T20:00:00.000Z'),
    ];
    const configDir = await configWith({ dir: dirA, id: idFor(1), records });
    const listed = await list(configDir, [dirA]);
    expect(listed).toEqual([{ id: idFor(1), name: 'tail-name', automatic: false, lastActiveAt: at('2026-09-05T20:00:00.000Z'), directory: dirA }]);
  });

  it('recovers a human name from the sidecar when the window sees only an ai-title', async () => {
    // a `custom-title` set long ago can fall outside the bounded window with no re-emit,
    // leaving only the generated ai-title in view; the sidecar restores the human name and
    // un-marks the row automatic (matching claudeConversationName)
    const configDir = await configWith({ dir: dirA, id: idFor(1), records: [{ type: 'ai-title', aiTitle: 'generated guess' }, turn('hi', '2026-09-05T12:00:00.000Z')], sidecar: { customTitle: 'ship the release' } });
    const listed = await list(configDir, [dirA]);
    expect(listed).toEqual([{ id: idFor(1), name: 'ship the release', automatic: false, lastActiveAt: at('2026-09-05T12:00:00.000Z'), directory: dirA }]);
  });

  it('orders by the last timestamped record, never the file mtime', async () => {
    // id1 has the newer file mtime but the older conversation activity; id2 the reverse
    const configDir = await configWith(
      { dir: dirA, id: idFor(1), records: [{ type: 'custom-title', customTitle: 'stale-but-touched' }, turn('hi', '2026-09-05T10:00:00.000Z')], mtimeMs: at('2026-09-06T23:00:00.000Z') },
      { dir: dirA, id: idFor(2), records: [{ type: 'custom-title', customTitle: 'fresh-activity' }, turn('yo', '2026-09-05T18:00:00.000Z')], mtimeMs: at('2026-09-06T01:00:00.000Z') },
    );
    const listed = await list(configDir, [dirA]);
    expect(listed.map(row => row.name)).toEqual(['fresh-activity', 'stale-but-touched']);
  });

  it('opens only the newest 200 transcripts by mtime, dropping the oldest', async () => {
    const transcripts = Array.from({ length: 201 }, (_, index) => ({
      dir: dirA,
      id: idFor(index + 1),
      records: [{ type: 'custom-title', customTitle: `c${index + 1}` }, turn('hi', '2026-09-05T12:00:00.000Z')],
      // index 0 is the oldest mtime, so it falls outside the newest-200 window
      mtimeMs: at('2026-09-01T00:00:00.000Z') + index * 60_000,
    }));
    const configDir = await configWith(...transcripts);
    const listed = await list(configDir, [dirA]);
    expect(listed).toHaveLength(200);
    expect(listed.map(row => row.name)).not.toContain('c1');
  });

  it('tolerates a missing project directory', async () => {
    const configDir = await configWith({ dir: dirA, id: idFor(1), records: [{ type: 'custom-title', customTitle: 'only' }, turn('hi', '2026-09-05T12:00:00.000Z')] });
    const listed = await list(configDir, ['/no/such/worktree', dirA]);
    expect(listed.map(row => row.name)).toEqual(['only']);
  });

  it('resolves a directory whose dashed name exceeds 200 characters via the hashed encoding', async () => {
    const longDir = `/tachi/code/${'nested-'.repeat(40)}leaf`;
    expect(longDir.replace(/[^a-zA-Z0-9]/gu, '-').length).toBeGreaterThan(200);
    const configDir = await configWith({ dir: longDir, id: idFor(1), records: [{ type: 'custom-title', customTitle: 'deep' }, turn('hi', '2026-09-05T12:00:00.000Z')] });
    const listed = await list(configDir, [longDir]);
    expect(listed).toEqual([{ id: idFor(1), name: 'deep', automatic: false, lastActiveAt: at('2026-09-05T12:00:00.000Z'), directory: longDir }]);
  });
});
