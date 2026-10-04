import type { ReplacedFlagValue } from '../launch/service.js';
import type { ReviewAgentKind } from './efforts.js';

// The per-launch arguments of an interactive Review run (ADR 0010): the same read-only
// restrictions as its headless run, plus the model and effort when given. Claude gets only
// the read tools and no MCP servers, and may read the run's prompt directory; the Adapter's
// own `--settings` (the state-reporting hooks) stays in place. Codex runs read-only and never
// asks for approval.
export function reviewRunArgs(kind: ReviewAgentKind, run: { model?: string; effort?: string; readDirectory?: string }): string[] {
  if (kind === 'claude') return ['--tools', 'Read,Grep,Glob', '--strict-mcp-config', ...(run.readDirectory === undefined ? [] : ['--add-dir', run.readDirectory]), ...(run.model === undefined ? [] : ['--model', run.model]), ...(run.effort === undefined ? [] : ['--effort', run.effort])];
  return ['--sandbox', 'read-only', '--ask-for-approval', 'never', ...(run.model === undefined ? [] : ['-m', run.model]), ...(run.effort === undefined ? [] : ['-c', `model_reasoning_effort=${run.effort}`])];
}

// the operator flags (`adapters.<kind>.args`) a Review run drops: the ones its own arguments
// replace (Codex refuses a repeated `--sandbox` or `--model`) and the ones that would loosen
// its read-only policy, such as Codex's sandbox bypass or extra MCP servers for Claude
export const reviewReplacedFlags: Record<ReviewAgentKind, ReadonlyMap<string, ReplacedFlagValue>> = {
  claude: new Map<string, ReplacedFlagValue>([['--tools', 'many'], ['--strict-mcp-config', 'none'], ['--mcp-config', 'many'], ['--model', 'one'], ['--effort', 'one']]),
  codex: new Map<string, ReplacedFlagValue>([['-s', 'one'], ['--sandbox', 'one'], ['-a', 'one'], ['--ask-for-approval', 'one'], ['-m', 'one'], ['--model', 'one'], ['--dangerously-bypass-approvals-and-sandbox', 'none'], ['--yolo', 'none'], ['--full-auto', 'none'], ['--approve-for-me', 'none'], ['--add-dir', 'one']])
};
