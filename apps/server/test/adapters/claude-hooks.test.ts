import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claudeFiles, claudeHooksJson, claudeHooksSettings } from '../../src/adapters/claude-hooks.js';

const golden = readFileSync(fileURLToPath(new URL('../fixtures/claude/hooks.json', import.meta.url)), 'utf8');

describe('claude hooks settings', () => {
  it('renders the pinned golden hooks.json for a known context', () => {
    expect(claudeHooksJson({ repoRoot: '/srv/remoteagents', tmuxBin: '/usr/bin/tmux' })).toBe(golden);
  });

  it('exposes the settings file through the files map', () => {
    expect(claudeFiles({ repoRoot: '/srv/remoteagents', tmuxBin: '/usr/bin/tmux' })).toEqual({ 'hooks.json': golden });
  });

  it('bakes RAC_TMUX_BIN only when a tmux binary is configured (never under the bridge)', () => {
    const baked = claudeHooksSettings({ repoRoot: '/repo', tmuxBin: '/opt/tmux' });
    expect(baked.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe('RAC_TMUX_BIN=/opt/tmux /repo/scripts/hooks/rac-attention working');
    const bridged = claudeHooksSettings({ repoRoot: '/host/repo' });
    expect(bridged.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe('/host/repo/scripts/hooks/rac-attention working');
  });

  it('maps every ADR 0001 event to its Attention state and reports nothing on SessionEnd', () => {
    const { hooks } = claudeHooksSettings({ repoRoot: '/repo', tmuxBin: '/usr/bin/tmux' });
    const state = (entry: { hooks: { command: string }[] }) => entry.hooks[0]!.command.split(' ').pop();
    expect(state(hooks.SessionStart[0]!)).toBe('finished');
    expect(state(hooks.UserPromptSubmit[0]!)).toBe('working');
    // AskUserQuestion carries its payload; ExitPlanMode only reports the state (ADR 0006)
    expect(hooks.PreToolUse.map(entry => [entry.matcher, state(entry), entry.hooks[0]!.command.endsWith('--payload')])).toEqual([
      ['AskUserQuestion', '--payload', true],
      ['ExitPlanMode', 'question', false],
    ]);
    expect(state(hooks.Elicitation[0]!)).toBe('question');
    expect(state(hooks.PermissionRequest[0]!)).toBe('question');
    expect(state(hooks.PostToolUse[0]!)).toBe('working');
    expect(state(hooks.PermissionDenied[0]!)).toBe('working');
    expect(state(hooks.ElicitationResult[0]!)).toBe('working');
    expect(state(hooks.Stop[0]!)).toBe('finished');
    expect(state(hooks.StopFailure[0]!)).toBe('finished');
    // Notification splits on notification_type: the prompt is a question, going idle is finished
    expect(hooks.Notification.map(entry => [entry.matcher, state(entry)])).toEqual([
      ['permission_prompt', 'question'],
      ['idle_prompt', 'finished'],
    ]);
    expect(hooks.SessionEnd).toBeUndefined();
    // every handler is a synchronous command with a 5s budget
    for (const entries of Object.values(hooks)) for (const entry of entries) for (const handler of entry.hooks) {
      expect(handler.type).toBe('command');
      expect(handler.timeout).toBe(5);
    }
  });
});
