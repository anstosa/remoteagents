import { describe, expect, it } from 'vitest';
import { hostInteractiveShell, interactiveShell, interactiveShellBootstrap } from '../src/tmux/interactive-shell.js';

describe('interactive agent shell', () => {
  it('starts the agent from the first prompt after job control is active', () => {
    const command = "cd -- '/home/ubuntu/dave' && eval 'detach && new task-1'";
    const bootstrap = interactiveShellBootstrap(command);

    expect(interactiveShell).toBe('/usr/bin/zsh');
    expect(hostInteractiveShell).toBe('/home/linuxbrew/.linuxbrew/bin/zsh');
    expect(bootstrap).toContain('source "$HOME/.zshenv"');
    expect(bootstrap).toContain('source "$HOME/.zshrc"');
    expect(bootstrap).toContain('precmd_functions+=(__rac_start_agent)');
    expect(bootstrap).toContain(`exec ${interactiveShell} -i`);
    expect(bootstrap).toContain(`export RAC_AGENT_COMMAND='cd -- '\\''/home/ubuntu/dave'\\'' && eval '\\''detach && new task-1'\\'''`);
  });

  it('sets the host home before zsh loads the operator configuration', () => {
    const bootstrap = interactiveShellBootstrap('codex', '/home/ubuntu');

    expect(bootstrap.startsWith("export HOME='/home/ubuntu'\n")).toBe(true);
  });
});
