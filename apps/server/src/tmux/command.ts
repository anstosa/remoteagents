import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
// build one restricted subprocess environment
export const safeEnv = (): NodeJS.ProcessEnv => { const user = userInfo(); return { HOME: user.homedir, USER: user.username, LOGNAME: user.username, SHELL: process.env.RAC_INTERACTIVE_SHELL?.trim() || user.shell || '/bin/sh', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin' }; };
// the variables tmux sets on the process it starts in a pane, naming that pane
const paneVariables = ['TMUX', 'TMUX_PANE'] as const;
/**
 * The environment for the shell a launch runner starts inside a tmux pane: the
 * restricted `safeEnv` plus the `TMUX`/`TMUX_PANE` pair tmux set on the runner
 * itself. An Agent's reporter hook (ADR 0001) writes `@rac_attention` and
 * `@rac_session` on `$TMUX_PANE` and exits silently without it, so dropping the
 * pair with the rest of the runner's environment left every runner-started Claude
 * unable to report its state or be bookmarked. Only those two pass through; the
 * console's secrets and everything else stay out. `source` is the runner's own
 * environment (a seam for tests; the runner runs under tmux, not the console).
 */
export const paneEnv = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env = safeEnv();
  for (const name of paneVariables) { const value = source[name]; if (value !== undefined && value !== '') env[name] = value; }
  return env;
};
export async function run(command: string, args: string[], input?: string, timeoutMs = 5000): Promise<{ code: number; stdout: string; stderr: string }> { return await new Promise((resolve, reject) => { const child = spawn(command, args, { shell: false, env: safeEnv(), stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs); child.stdout.on('data', d => { stdout = (stdout + d).slice(-1_000_000); }); child.stderr.on('data', d => { stderr = (stderr + d).slice(-16_384); }); child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); }); if (input !== undefined) child.stdin.end(input); else child.stdin.end(); }); }
