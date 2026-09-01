import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigDir, claudeConversationTitle, validClaudeSessionId } from '../../src/adapters/claude-conversations.js';

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
const title = (configDir: string) => claudeConversationTitle(id, cwd, { RAC_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv);

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
    expect(await title(configDir)).toBe('Wire the Claude adapter');
  });

  it('falls back to the first typed human prompt when there is no ai-title', async () => {
    const configDir = await transcript([
      { type: 'mode', mode: 'normal', sessionId: id },
      { type: 'user', promptSource: 'meta', origin: { kind: 'human' }, message: { content: 'system preamble' } },
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'the real first prompt' } },
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'a later prompt' } },
    ]);
    expect(await title(configDir)).toBe('the real first prompt');
  });

  it('ignores non-string prompt content and malformed lines', async () => {
    const configDir = await transcript([
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'blocks' }] } },
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'plain text wins' } },
    ]);
    expect(await title(configDir)).toBe('plain text wins');
  });

  it('normalizes whitespace and clamps a long title with an ellipsis', async () => {
    const spaced = await transcript([
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'first\n\tprompt   with   spaces' } },
    ]);
    expect(await title(spaced)).toBe('first prompt with spaces');
    const long = await transcript([{ type: 'ai-title', aiTitle: 'x'.repeat(200), sessionId: id }]);
    const clamped = await title(long);
    expect(clamped).toHaveLength(120);
    expect(clamped!.endsWith('…')).toBe(true);
  });

  it('returns undefined for an unknown cwd, a bad id, or a missing transcript', async () => {
    const configDir = await transcript([{ type: 'ai-title', aiTitle: 'x', sessionId: id }]);
    expect(await claudeConversationTitle(id, undefined, { RAC_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(await claudeConversationTitle('bad', cwd, { RAC_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(await claudeConversationTitle(id, '/some/other/dir', { RAC_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
