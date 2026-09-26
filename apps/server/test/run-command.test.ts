import { describe, expect, it } from 'vitest';
import { run } from '../src/tmux/command.js';

// A long capture arrives over several pipe reads; a character split between two of them
// must decode whole, not as two replacement characters.
describe('run', () => {
  it('decodes a UTF-8 character split across two pipe reads', async () => {
    const script = 'process.stdout.write(Buffer.from([0xe2, 0x9e])); setTimeout(() => process.stdout.write(Buffer.from([0x9c, 0x0a])), 100);';
    await expect(run(process.execPath, ['-e', script])).resolves.toMatchObject({ code: 0, stdout: '➜\n' });
  });
});
