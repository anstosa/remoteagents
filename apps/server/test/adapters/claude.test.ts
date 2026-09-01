import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/adapters/claude.js';

const hooks = '/data/adapters/claude/hooks.json';
const files = { 'hooks.json': hooks };
const id = '0199a4e1-c0b7-4a90-bf22-abcdef012345';

describe('claude adapter launch', () => {
  it('injects --settings after the mode flag in every mode', () => {
    expect(claudeAdapter.launch({ mode: 'fresh', cwd: '/w', sandboxed: false, files }).args).toEqual(['--settings', hooks]);
    expect(claudeAdapter.launch({ mode: 'continue', cwd: '/w', sandboxed: false, files }).args).toEqual(['--continue', '--settings', hooks]);
    expect(claudeAdapter.launch({ mode: 'resume', conversationId: id, cwd: '/w', sandboxed: false, files }).args).toEqual(['--resume', id, '--settings', hooks]);
  });

  it('omits --settings when no hooks file was rendered', () => {
    expect(claudeAdapter.launch({ mode: 'fresh', cwd: '/w', sandboxed: false }).args).toEqual([]);
    expect(claudeAdapter.launch({ mode: 'continue', cwd: '/w', sandboxed: false }).args).toEqual(['--continue']);
  });

  it('falls back to a fresh launch when a resume carries no conversation id', () => {
    expect(claudeAdapter.launch({ mode: 'resume', cwd: '/w', sandboxed: false, files }).args).toEqual(['--settings', hooks]);
  });
});
