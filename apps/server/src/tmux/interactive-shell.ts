import { basename } from 'node:path';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// resolve the container-managed interactive shell
export function interactiveShellPath(): string {
  return process.env.RAC_INTERACTIVE_SHELL?.trim() || '/usr/bin/zsh';
}

// resolve the shell path visible to the host tmux server
export function hostInteractiveShellPath(): string {
  return process.env.RAC_HOST_INTERACTIVE_SHELL?.trim() || interactiveShellPath();
}

// match tmux's pane_current_command value
export function interactiveShellName(shell: string): string {
  return basename(shell);
}

// restore the explicitly configured host environment
export function hostCommand(command: string, home: string, path = process.env.RAC_HOST_PATH?.trim()): string {
  const pathExport = path ? `export PATH=${quote(path)}\n` : '';
  return `export HOME=${quote(home)}\n${pathExport}${command}`;
}

// bootstrap zsh after its normal operator configuration
function zshBootstrap(command: string, home: string, shell: string): string {
  const homeAssignment = home === '$HOME' ? '' : `export HOME=${quote(home)}\n`;
  const environmentInitializer = `[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"`;
  const interactiveInitializer = `[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
__rac_start_agent() {
  precmd_functions=(\${precmd_functions:#__rac_start_agent})
  unfunction __rac_start_agent
  local command="$RAC_AGENT_COMMAND"
  unset RAC_AGENT_COMMAND
  rm -rf -- "$RAC_RC_DIR"
  unset RAC_RC_DIR ZDOTDIR
  eval "$command"
}
typeset -ga precmd_functions
precmd_functions+=(__rac_start_agent)`;
  return `${homeAssignment}rcdir="$(mktemp -d)" || exit
printf '%s' ${quote(environmentInitializer)} > "$rcdir/.zshenv" || exit
printf '%s' ${quote(interactiveInitializer)} > "$rcdir/.zshrc" || exit
export RAC_RC_DIR="$rcdir"
export RAC_AGENT_COMMAND=${quote(command)}
export ZDOTDIR="$rcdir"
exec ${quote(shell)} -i`;
}

// bootstrap bash after its normal operator configuration
function bashBootstrap(command: string, home: string, shell: string): string {
  const homeAssignment = home === '$HOME' ? '' : `export HOME=${quote(home)}\n`;
  const interactiveInitializer = `[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
__rac_start_agent() {
  # remove this one-time array hook
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=("\${PROMPT_COMMAND[@]:1}")
  else
    PROMPT_COMMAND="\${PROMPT_COMMAND#__rac_start_agent}"
    PROMPT_COMMAND="\${PROMPT_COMMAND#;}"
  fi
  unset -f __rac_start_agent
  local command="$RAC_AGENT_COMMAND"
  unset RAC_AGENT_COMMAND
  rm -rf -- "$RAC_RC_DIR"
  unset RAC_RC_DIR
  eval "$command"
}
# prepend without discarding existing prompt hooks
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__rac_start_agent "\${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__rac_start_agent\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi`;
  return `${homeAssignment}rcdir="$(mktemp -d)" || exit
printf '%s' ${quote(interactiveInitializer)} > "$rcdir/.bashrc" || exit
export RAC_RC_DIR="$rcdir"
export RAC_AGENT_COMMAND=${quote(command)}
exec ${quote(shell)} --noprofile --rcfile "$rcdir/.bashrc" -i`;
}

// start an agent after interactive job control initializes
export function interactiveShellBootstrap(command: string, home = '$HOME', shell = interactiveShellPath()): string {
  const name = interactiveShellName(shell);
  // use the matching startup contract
  if (name === 'zsh') return zshBootstrap(command, home, shell);
  if (name === 'bash') return bashBootstrap(command, home, shell);
  throw new Error(`unsupported interactive shell: ${shell}`);
}
