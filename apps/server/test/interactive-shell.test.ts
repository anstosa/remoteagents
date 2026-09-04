import { afterEach, describe, expect, it } from 'vitest';
import { hostInteractiveShellPath, interactiveShellBootstrap, interactiveShellPath } from '../src/tmux/interactive-shell.js';

const previousInteractiveShell = process.env.RAC_INTERACTIVE_SHELL;
const previousHostInteractiveShell = process.env.RAC_HOST_INTERACTIVE_SHELL;

// restore shared runtime configuration
afterEach(() => {
  if (previousInteractiveShell === undefined) delete process.env.RAC_INTERACTIVE_SHELL;
  else process.env.RAC_INTERACTIVE_SHELL = previousInteractiveShell;
  if (previousHostInteractiveShell === undefined) delete process.env.RAC_HOST_INTERACTIVE_SHELL;
  else process.env.RAC_HOST_INTERACTIVE_SHELL = previousHostInteractiveShell;
});

describe('interactive agent shell', () => {
  it('starts the agent from the first prompt after job control is active', () => {
    const command = "cd -- '/home/ubuntu/dave' && eval 'detach && new task-1'";
    const bootstrap = interactiveShellBootstrap(command);

    expect(interactiveShellPath()).toBe('/usr/bin/zsh');
    expect(hostInteractiveShellPath()).toBe('/usr/bin/zsh');
    expect(bootstrap).toContain('source "$HOME/.zshenv"');
    expect(bootstrap).toContain('source "$HOME/.zshrc"');
    expect(bootstrap).toContain('precmd_functions+=(__rac_start_agent)');
    expect(bootstrap).toContain("exec '/usr/bin/zsh' -i");
    expect(bootstrap).toContain(`export RAC_AGENT_COMMAND='cd -- '\\''/home/ubuntu/dave'\\'' && eval '\\''detach && new task-1'\\'''`);
  });

  it('sets the host home before zsh loads the operator configuration', () => {
    const bootstrap = interactiveShellBootstrap('codex', '/home/ubuntu');

    expect(bootstrap.startsWith("export HOME='/home/ubuntu'\n")).toBe(true);
  });

  it('supports a configured Bash shell and its normal rc file', () => {
    process.env.RAC_INTERACTIVE_SHELL = '/bin/bash';
    process.env.RAC_HOST_INTERACTIVE_SHELL = '/usr/local/bin/bash';

    const bootstrap = interactiveShellBootstrap('codex', '/home/operator', hostInteractiveShellPath());

    expect(interactiveShellPath()).toBe('/bin/bash');
    expect(hostInteractiveShellPath()).toBe('/usr/local/bin/bash');
    expect(bootstrap).toContain('source "$HOME/.bashrc"');
    expect(bootstrap).toContain('PROMPT_COMMAND=(__rac_start_agent "${PROMPT_COMMAND[@]}")');
    expect(bootstrap).toContain('PROMPT_COMMAND="__rac_start_agent${PROMPT_COMMAND:+;$PROMPT_COMMAND}"');
    expect(bootstrap).toContain("exec '/usr/local/bin/bash' --noprofile --rcfile");
  });

  it('supports a configured fish shell, loading its config and starting the agent as a job', () => {
    process.env.RAC_INTERACTIVE_SHELL = '/usr/bin/fish';

    const command = "cd -- '/home/ubuntu/dave' && eval 'detach && new task-1'";
    const bootstrap = interactiveShellBootstrap(command, '$HOME');

    expect(interactiveShellPath()).toBe('/usr/bin/fish');
    // fish loads its own config via `-i`; the hook rides along on `-C`
    expect(bootstrap).toContain("exec '/usr/bin/fish' -i -C '");
    expect(bootstrap).toContain('--on-event fish_prompt');
    // the agent runs through the reader (real job control), not inside the event handler
    expect(bootstrap).toContain('commandline -r -- __rac_run');
    expect(bootstrap).toContain('commandline -f execute');
    // the POSIX command travels in the environment and is unset before the agent inherits it
    expect(bootstrap).toContain('cmd=$RAC_AGENT_COMMAND; unset RAC_AGENT_COMMAND; eval "$cmd"');
    expect(bootstrap).toContain(`set -gx RAC_AGENT_COMMAND 'cd -- '\\''/home/ubuntu/dave'\\'' && eval '\\''detach && new task-1'\\'''`);
    // no HOME override when home is the inherited `$HOME` sentinel
    expect(bootstrap.startsWith('set -gx RAC_AGENT_COMMAND')).toBe(true);
  });

  it('sets the host home before fish loads the operator configuration', () => {
    process.env.RAC_INTERACTIVE_SHELL = '/usr/bin/fish';

    const bootstrap = interactiveShellBootstrap('codex', '/home/ubuntu');

    expect(bootstrap.startsWith("set -gx HOME '/home/ubuntu'\n")).toBe(true);
  });
});
