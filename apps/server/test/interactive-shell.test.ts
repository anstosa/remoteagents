import { describe, expect, it } from 'vitest';
import { interactiveShellBootstrap } from '../src/tmux/interactive-shell.js';

describe('interactive agent shell', () => {
  it('starts the agent from the first prompt after job control is active', () => {
    const command = "cd -- '/home/ubuntu/dave' && eval 'detach && new task-1'";
    const bootstrap = interactiveShellBootstrap(command);

    expect(bootstrap).toContain('exec /bin/bash --noprofile --rcfile "$init" -i');
    expect(bootstrap).toContain('PROMPT_COMMAND=__rac_start_agent');
    expect(bootstrap).toContain(`export RAC_AGENT_COMMAND='cd -- '\\''/home/ubuntu/dave'\\'' && eval '\\''detach && new task-1'\\'''`);
  });
});
