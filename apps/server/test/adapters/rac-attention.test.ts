import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../../../scripts/hooks/rac-attention', import.meta.url));

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

// a stub tmux that records each invocation's arguments, one line per call
async function stubTmux(): Promise<{ bin: string; calls: () => Promise<string[]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'rac-tmux-'));
  dirs.push(dir);
  const record = join(dir, 'calls.log');
  const bin = join(dir, 'tmux');
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\n`, { mode: 0o755 });
  return { bin, calls: async () => (await readFile(record, 'utf8').catch(() => '')).split('\n').filter(line => line !== '') };
}

async function attention(args: string[], env: Record<string, string>): Promise<void> {
  await run('/bin/sh', [script, ...args], { env: { PATH: '/usr/bin:/bin', ...env } });
}

describe('rac-attention', () => {
  it('sets @rac_attention and @rac_session in one tmux invocation', async () => {
    const tmux = await stubTmux();
    await attention(['working'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%7', CLAUDE_CODE_SESSION_ID: 'sid-123' });
    const calls = await tmux.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('set-option -p -t %7 @rac_attention working');
    expect(calls[0]).toContain('set-option -p -t %7 @rac_session sid-123');
  });

  it('sets only @rac_attention when no session id is known', async () => {
    const tmux = await stubTmux();
    await attention(['finished'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%7' });
    const calls = await tmux.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('@rac_attention finished');
    expect(calls[0]).not.toContain('@rac_session');
  });

  it('prefers an explicit --session over $CLAUDE_CODE_SESSION_ID and ignores extra args', async () => {
    const tmux = await stubTmux();
    await attention(['question', '--session', 'explicit', '{"hook":"event"}'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%9', CLAUDE_CODE_SESSION_ID: 'env-session' });
    const calls = await tmux.calls();
    expect(calls[0]).toContain('@rac_attention question');
    expect(calls[0]).toContain('@rac_session explicit');
  });

  it('does nothing outside a tmux pane', async () => {
    const tmux = await stubTmux();
    await attention(['working'], { RAC_TMUX_BIN: tmux.bin, CLAUDE_CODE_SESSION_ID: 'sid' });
    expect(await tmux.calls()).toHaveLength(0);
  });

  it('does nothing for an unrecognized state', async () => {
    const tmux = await stubTmux();
    await attention(['bogus'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%7' });
    expect(await tmux.calls()).toHaveLength(0);
  });

  it('exits cleanly when no tmux binary resolves', async () => {
    // RAC_TMUX_BIN unset and PATH without tmux: command -v tmux fails, exit 0
    await expect(attention(['working'], { TMUX_PANE: '%7', PATH: '/nonexistent' })).resolves.toBeUndefined();
  });
});
