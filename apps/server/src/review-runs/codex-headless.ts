import { randomBytes } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../tmux/command.js';
import { MAX_REVIEW_GENERATED_BYTES } from '../review-tour/contracts.js';
import { runReviewProcess } from './process.js';
import { ReviewRunError, unavailable, type KindReviewRunner, type ReviewRunCapability, type ReviewRunRequest } from './runner.js';

const authenticationDiagnostic = /(?:^|\n)(?:\d{4}-\d{2}-\d{2}T\S+\s+)?ERROR(?:\s+codex_login::auth::manager)?:\s*(?:Failed to refresh token|Your access token could not be refreshed|Provided authentication token is expired)\b/imu;

// classify actionable Codex process failures
function processFailure(diagnostics: string): ReviewRunError {
  // distinguish an expired server login from model generation failures
  if (authenticationDiagnostic.test(diagnostics)) return new ReviewRunError('authentication_required', false);
  return new ReviewRunError('generation_failed', true);
}

// the `codex exec` arguments of one isolated, read-only, schema-constrained run
export function codexExecArgs(request: Pick<ReviewRunRequest, 'workspace' | 'model' | 'effort'>, schemaPath: string, outputPath: string): string[] {
  const model = request.model === undefined ? [] : ['-m', request.model];
  const effort = request.effort === undefined ? [] : ['-c', `model_reasoning_effort=${request.effort}`];
  return ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', ...model, ...effort, '--output-schema', schemaPath, '--output-last-message', outputPath, '--color', 'never', '-C', request.workspace, '-'];
}

export class CodexHeadlessReviewRunner implements KindReviewRunner {
  private capabilityResult?: Promise<ReviewRunCapability>;

  // the Codex binary: an explicit override, else the configured adapters.codex program;
  // an empty string (nothing configured) reports unavailable rather than spawning a bare name
  constructor(private readonly binary = process.env.RAC_CODEX_BIN ?? '') {}

  // verify the configured CLI surface once
  capability(): Promise<ReviewRunCapability> {
    this.capabilityResult ??= this.detectCapability();
    return this.capabilityResult;
  }

  // inspect required CLI flags
  private async detectCapability(): Promise<ReviewRunCapability> {
    // require a configured, absolute executable
    if (!this.binary.startsWith('/')) return { available: false, reason: 'configuration_invalid' };
    const executable = await access(this.binary, constants.X_OK).then(() => true).catch(() => false);
    // report missing generators cleanly
    if (!executable) return { available: false, reason: 'generator_unavailable' };
    const help = await run(this.binary, ['exec', '--help'], undefined, 5_000).catch(() => undefined);
    // require every isolation/output flag
    if (help === undefined || help.code !== 0 || !['--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', '--output-schema', '--output-last-message'].every(flag => help.stdout.includes(flag))) return { available: false, reason: 'unsupported_cli' };
    const login = await run(this.binary, ['login', 'status'], undefined, 5_000).catch(() => undefined);
    // require persisted provider authentication
    if (login === undefined || login.code !== 0) return { available: false, reason: 'authentication_required' };
    return { available: true };
  }

  // run one ephemeral structured generation and parse its last message
  async run(request: ReviewRunRequest, signal: AbortSignal): Promise<unknown> {
    const refused = unavailable(await this.capability());
    // fail closed when startup checks fail
    if (refused !== undefined) throw refused;
    const root = await mkdtemp(join(tmpdir(), `rac-review-${randomBytes(4).toString('hex')}-`));
    try {
      await chmod(root, 0o700);
      const schemaPath = join(root, 'schema.json');
      const outputPath = join(root, 'result.json');
      await writeFile(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });
      const result = await runReviewProcess({ binary: this.binary, args: codexExecArgs(request, schemaPath, outputPath), stdin: request.prompt, timeoutMs: request.timeoutMs }, signal);
      // classify a failed process from its bounded diagnostic tail
      if (result.code !== 0) throw processFailure(result.diagnostics);
      const raw = await readFile(outputPath);
      // reject oversized output
      if (raw.length > (request.maxOutputBytes ?? MAX_REVIEW_GENERATED_BYTES)) throw new ReviewRunError('malformed_result', true);
      return JSON.parse(raw.toString('utf8')) as unknown;
    } catch (error) {
      // preserve typed failures
      if (error instanceof ReviewRunError) throw error;
      throw new ReviewRunError('malformed_result', true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
