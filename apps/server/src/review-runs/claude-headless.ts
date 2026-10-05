import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { run } from '../tmux/command.js';
import { MAX_REVIEW_GENERATED_BYTES } from '../review-tour/contracts.js';
import { runReviewProcess } from './process.js';
import { claudeReviewTools, ReviewRunError, unavailable, type KindReviewRunner, type ReviewRunCapability, type ReviewRunRequest } from './runner.js';

// the result envelope carries the text result and usage beside the structured output
const envelopeBytes = (outputBytes: number) => 4 * outputBytes + 65_536;
const requiredFlags = ['--json-schema', '--tools', '--output-format', '--effort', '--no-session-persistence', '--strict-mcp-config'];
const authenticationFailure = /invalid api key|please run \/login|not logged in|authentication_error|oauth token (?:has )?expired/iu;

type ClaudeResult = { type?: unknown; is_error?: unknown; result?: unknown; structured_output?: unknown };

// the `claude -p` arguments of one read-only, unpersisted, schema-constrained run: only the
// read tools and no MCP servers, so the run cannot modify the Worktree
export function claudePrintArgs(request: Pick<ReviewRunRequest, 'schema' | 'model' | 'effort'>): string[] {
  const model = request.model === undefined ? [] : ['--model', request.model];
  const effort = request.effort === undefined ? [] : ['--effort', request.effort];
  return ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(request.schema), '--tools', claudeReviewTools, '--strict-mcp-config', '--no-session-persistence', ...model, ...effort];
}

// the result object from `--output-format json` (one object; an array of messages under --verbose)
function resultEnvelope(stdout: Buffer): ClaudeResult | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.toString('utf8')); } catch { return undefined; }
  const candidate: unknown = Array.isArray(parsed) ? [...parsed as unknown[]].reverse().find(entry => (entry as ClaudeResult | null)?.type === 'result') : parsed;
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as ClaudeResult : undefined;
}

// classify a failed run: a missing or expired login is the operator's to fix
function processFailure(diagnostics: string, envelope: ClaudeResult | undefined): ReviewRunError {
  const text = `${diagnostics}\n${typeof envelope?.result === 'string' ? envelope.result : ''}`;
  if (authenticationFailure.test(text)) return new ReviewRunError('authentication_required', false);
  return new ReviewRunError('generation_failed', true);
}

export class ClaudeHeadlessReviewRunner implements KindReviewRunner {
  private capabilityResult?: Promise<ReviewRunCapability>;

  // the Claude binary: an explicit override, else the configured adapters.claude program;
  // an empty string (nothing configured) reports unavailable rather than spawning a bare name
  constructor(private readonly binary = process.env.RAC_CLAUDE_BIN ?? '') {}

  // verify the configured CLI surface once; Claude has no cheap login check
  capability(): Promise<ReviewRunCapability> {
    this.capabilityResult ??= this.detectCapability();
    return this.capabilityResult;
  }

  // inspect required CLI flags
  private async detectCapability(): Promise<ReviewRunCapability> {
    // require a configured, absolute executable
    if (!this.binary.startsWith('/')) return { available: false, reason: 'configuration_invalid' };
    const executable = await access(this.binary, constants.X_OK).then(() => true).catch(() => false);
    // report missing CLIs cleanly
    if (!executable) return { available: false, reason: 'generator_unavailable' };
    const help = await run(this.binary, ['--help'], undefined, 5_000).catch(() => undefined);
    // require every isolation/output flag
    if (help === undefined || help.code !== 0 || !requiredFlags.every(flag => help.stdout.includes(flag))) return { available: false, reason: 'unsupported_cli' };
    return { available: true };
  }

  // run one print-mode structured generation and return its structured output
  async run(request: ReviewRunRequest, signal: AbortSignal): Promise<unknown> {
    const refused = unavailable(await this.capability());
    // fail closed when startup checks fail
    if (refused !== undefined) throw refused;
    const outputBytes = request.maxOutputBytes ?? MAX_REVIEW_GENERATED_BYTES;
    const result = await runReviewProcess({ binary: this.binary, args: claudePrintArgs(request), cwd: request.workspace, stdin: request.prompt, timeoutMs: request.timeoutMs, maxStdoutBytes: envelopeBytes(outputBytes) }, signal);
    const envelope = result.overflowed ? undefined : resultEnvelope(result.stdout);
    // a non-zero exit or an error result is a failed run, classified from its text
    if (result.code !== 0 || envelope?.is_error === true) throw processFailure(result.diagnostics, envelope);
    const output = envelope?.structured_output;
    // require a bounded structured result
    if (output === undefined || output === null || Buffer.byteLength(JSON.stringify(output)) > outputBytes) throw new ReviewRunError('malformed_result', true);
    return output;
  }
}
