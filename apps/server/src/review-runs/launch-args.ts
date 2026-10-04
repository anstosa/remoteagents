import { execFile } from 'node:child_process';
import type { ReplacedFlagValue } from '../launch/service.js';
import { safeEnv } from '../tmux/command.js';
import type { ReviewAgentKind } from './efforts.js';

// The per-launch arguments of an interactive Review run (ADR 0010): the same read-only
// restrictions as its headless run, plus the model and effort when given. Claude gets only
// the read tools and no MCP servers, and may read the run's prompt directory; the Adapter's
// own `--settings` (the state-reporting hooks) stays in place. Codex runs read-only and never
// asks for approval; its MCP servers are disabled by `codexMcpDisableArgs`, appended by the host.
export function reviewRunArgs(kind: ReviewAgentKind, run: { model?: string; effort?: string; readDirectory?: string }): string[] {
  if (kind === 'claude') return ['--tools', 'Read,Grep,Glob', '--strict-mcp-config', ...(run.readDirectory === undefined ? [] : ['--add-dir', run.readDirectory]), ...(run.model === undefined ? [] : ['--model', run.model]), ...(run.effort === undefined ? [] : ['--effort', run.effort])];
  return ['--sandbox', 'read-only', '--ask-for-approval', 'never', ...(run.model === undefined ? [] : ['-m', run.model]), ...(run.effort === undefined ? [] : ['-c', `model_reasoning_effort=${run.effort}`])];
}

// the operator flags (`adapters.<kind>.args`) every Review run drops: the ones its own arguments
// always replace (Codex refuses a repeated `--sandbox`) and the ones that would loosen its
// read-only policy, such as Codex's sandbox bypass or extra MCP servers for Claude
const readOnlyFlags: Record<ReviewAgentKind, Array<[string, ReplacedFlagValue]>> = {
  claude: [['--tools', 'many'], ['--strict-mcp-config', 'none'], ['--mcp-config', 'many']],
  codex: [['-s', 'one'], ['--sandbox', 'one'], ['-a', 'one'], ['--ask-for-approval', 'one'], ['--dangerously-bypass-approvals-and-sandbox', 'none'], ['--yolo', 'none'], ['--full-auto', 'none'], ['--approve-for-me', 'none'], ['--add-dir', 'one']]
};
// the operator's model and effort flags, dropped only when the run supplies its own value (Codex
// refuses a repeated `--model`); Codex takes effort through `-c`, where the run's later value wins
const modelFlags: Record<ReviewAgentKind, string[]> = { claude: ['--model'], codex: ['-m', '--model'] };
const effortFlags: Record<ReviewAgentKind, string[]> = { claude: ['--effort'], codex: [] };

// the operator flags one Review run drops: always the read-only ones, the model and effort only
// when the run sets them, so an operator's own model still applies to a run that names none
export function reviewReplacedFlags(kind: ReviewAgentKind, run: { model?: string; effort?: string }): ReadonlyMap<string, ReplacedFlagValue> {
  const replaced = [...(run.model === undefined ? [] : modelFlags[kind]), ...(run.effort === undefined ? [] : effortFlags[kind])];
  return new Map<string, ReplacedFlagValue>([...readOnlyFlags[kind], ...replaced.map((flag): [string, ReplacedFlagValue] => [flag, 'one'])]);
}

// a Codex MCP server name a dotted `-c mcp_servers.<name>…` override can address
const codexMcpServerName = /^[A-Za-z0-9_-]{1,64}$/u;

// The names of the MCP servers Codex would load in a directory, as `codex mcp list --json` reports
// them under the launch's environment (the restricted pane environment with the Adapter's own
// overlaid); undefined when they cannot be listed.
export async function codexMcpServers(program: string, cwd: string, env: Record<string, string>, timeoutMs = 10_000): Promise<string[] | undefined> {
  const listed = await new Promise<string | undefined>(resolve => {
    execFile(program, ['mcp', 'list', '--json'], { cwd, env: { ...safeEnv(), ...env }, timeout: timeoutMs, maxBuffer: 1_000_000 }, (error, stdout) => { resolve(error === null ? stdout : undefined); });
  });
  if (listed === undefined) return undefined;
  try {
    const servers = JSON.parse(listed) as unknown;
    if (!Array.isArray(servers)) return undefined;
    const names = servers.map(server => (server as { name?: unknown } | null)?.name);
    return names.every(name => typeof name === 'string') ? names as string[] : undefined;
  } catch { return undefined; }
}

// The arguments that keep an interactive Codex Review run off every MCP server, whose tools run
// outside the read-only sandbox. The Codex TUI has no `--ignore-user-config`, and an empty
// `-c mcp_servers={}` merges into the configured table rather than replacing it, so each server is
// disabled by name. Undefined when a name cannot be addressed safely: the run must not launch.
export function codexMcpDisableArgs(names: string[]): string[] | undefined {
  if (!names.every(name => codexMcpServerName.test(name))) return undefined;
  return names.flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]);
}
