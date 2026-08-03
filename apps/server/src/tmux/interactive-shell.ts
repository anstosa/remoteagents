const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const interactiveShell = '/usr/bin/zsh';
export const hostInteractiveShell = '/home/linuxbrew/.linuxbrew/bin/zsh';

const environmentInitializer = `[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"`;
const interactiveInitializer = `[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
__rac_start_agent() {
  precmd_functions=(\${precmd_functions:#__rac_start_agent})
  unfunction __rac_start_agent
  local command="$RAC_AGENT_COMMAND"
  unset RAC_AGENT_COMMAND
  rm -rf -- "$RAC_ZDOTDIR"
  unset RAC_ZDOTDIR ZDOTDIR
  eval "$command"
}
typeset -ga precmd_functions
precmd_functions+=(__rac_start_agent)`;

/**
 * Start the agent from zsh's first prompt after interactive job control and
 * the operator's normal zsh configuration have both initialized.
 */
export function interactiveShellBootstrap(command: string, home = '$HOME', shell = interactiveShell): string {
  const homeAssignment = home === '$HOME' ? '' : `export HOME=${quote(home)}\n`;
  return `${homeAssignment}zdotdir="$(mktemp -d)" || exit
printf '%s' ${quote(environmentInitializer)} > "$zdotdir/.zshenv" || exit
printf '%s' ${quote(interactiveInitializer)} > "$zdotdir/.zshrc" || exit
export RAC_ZDOTDIR="$zdotdir"
export RAC_AGENT_COMMAND=${quote(command)}
export ZDOTDIR="$zdotdir"
exec ${shell} -i`;
}
