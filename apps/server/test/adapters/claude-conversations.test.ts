import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigDir, claudeConversationName, validClaudeSessionId } from '../../src/adapters/claude-conversations.js';

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
