const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const initializer = `rm -f -- "$RAC_BASH_INIT"
unset RAC_BASH_INIT
__rac_start_agent() {
  PROMPT_COMMAND=
  unset -f __rac_start_agent
  local command="$RAC_AGENT_COMMAND"
  unset RAC_AGENT_COMMAND
  eval "$command"
}
PROMPT_COMMAND=__rac_start_agent`;

/**
 * Start the agent from an interactive shell's first prompt. Running it from
 * bash's rc file is too early for job control, while `bash -lc <agent>` leaves
 * no interactive shell to reclaim the terminal after Ctrl-Z.
 */
export function interactiveShellBootstrap(command: string): string {
  return `init="$(mktemp)" || exit
printf '%s' ${quote(initializer)} > "$init" || exit
export RAC_BASH_INIT="$init"
export RAC_AGENT_COMMAND=${quote(command)}
exec /bin/bash --noprofile --rcfile "$init" -i`;
}
