import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, safeEnv } from '../tmux/command.js';
import { generatedReviewTourJsonSchema, MAX_REVIEW_GENERATED_BYTES, parseGeneratedReviewTourResult, REVIEW_GENERATION_TIMEOUT_MS, ReviewTourError, type GeneratedReviewTour, type ReviewSnapshot, type ReviewTourCapability } from './contracts.js';

export interface ReviewTourGenerator {
  capability(): Promise<ReviewTourCapability>;
  generate(snapshot: ReviewSnapshot, signal: AbortSignal): Promise<GeneratedReviewTour>;
}

// terminate the full generation tree
async function terminate(child: ChildProcess): Promise<void> {
  // stop an active process group
  if (child.pid !== undefined && child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await new Promise(resolve => setTimeout(resolve, 1_000));
    // force remaining descendants down
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }
}

// build explanation-only instructions
function generationPrompt(snapshot: ReviewSnapshot): string {
  const changes = snapshot.changes.map(change => ({ id: change.id, file: change.file, originalFile: change.originalFile, category: change.category, kind: change.kind, patch: change.patch }));
  return [
    'Create a narrated implementation-change tour for a human reviewer.',
    'Explain mechanism, intent, dependencies, and the order in which the implementation fits together.',
    'Group related change IDs across files into logical steps. Assign every change ID exactly once.',
    'Do not perform code review. Do not produce findings, warnings, issues, recommendations, severity, verdicts, approval, rejection, patches, fixes, or commands.',
    'Use only the provided change IDs in changeIds. Return JSON matching the supplied schema.',
    `Scope: ${snapshot.scope}; base: ${snapshot.base}; tests included: ${snapshot.includeTests}; docs included: ${snapshot.includeDocs}.`,
    JSON.stringify({ changes })
  ].join('\n\n');
}

export class CodexExecReviewTourGenerator implements ReviewTourGenerator {
  private capabilityResult?: Promise<ReviewTourCapability>;

  constructor(private readonly binary = process.env.RAC_CODEX_BIN ?? '/usr/local/bin/codex') {}

  // verify the configured CLI surface once
  capability(): Promise<ReviewTourCapability> {
    this.capabilityResult ??= this.detectCapability();
    return this.capabilityResult;
  }

  // inspect required CLI flags
  private async detectCapability(): Promise<ReviewTourCapability> {
    // require an absolute executable
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

  // run one ephemeral structured generation
  async generate(snapshot: ReviewSnapshot, signal: AbortSignal): Promise<GeneratedReviewTour> {
    const capability = await this.capability();
    // fail closed when startup checks fail
    if (!capability.available) throw new ReviewTourError('capability_unavailable', capability.reason === 'generator_unavailable');
    const root = await mkdtemp(join(tmpdir(), `rac-review-${randomBytes(4).toString('hex')}-`));
    await chmod(root, 0o700);
    const schemaPath = join(root, 'schema.json');
    const outputPath = join(root, 'result.json');
    await writeFile(schemaPath, JSON.stringify(generatedReviewTourJsonSchema), { mode: 0o600 });
    const args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--output-schema', schemaPath, '--output-last-message', outputPath, '--color', 'never', '-C', snapshot.workspace, '-'];
    const child = spawn(this.binary, args, { shell: false, detached: true, env: safeEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
    // drain diagnostics without retaining content
    child.stderr.resume();
    const timedOut = new AbortController();
    const timer = setTimeout(() => timedOut.abort(), REVIEW_GENERATION_TIMEOUT_MS);
    let abortedByTimeout = false;
    // stop on server timeout
    const timeoutAbort = () => { abortedByTimeout = true; void terminate(child); };
    // stop on caller cancellation
    const requestAbort = () => { void terminate(child); };
    timedOut.signal.addEventListener('abort', timeoutAbort, { once: true });
    signal.addEventListener('abort', requestAbort, { once: true });
    try {
      // reject already-cancelled requests
      if (signal.aborted) throw new ReviewTourError('cancelled', true);
      child.stdin.end(generationPrompt(snapshot));
      const code = await new Promise<number>((resolve, reject) => {
        // surface spawn failures
        child.once('error', reject);
        child.once('close', value => resolve(value ?? -1));
      }).catch(() => -1);
      // preserve cancellation distinctions
      if (signal.aborted) throw new ReviewTourError('cancelled', true);
      // report timeout distinctly
      if (abortedByTimeout) throw new ReviewTourError('timed_out', true);
      // reject failed processes
      if (code !== 0) throw new ReviewTourError('generation_failed', true);
      const raw = await readFile(outputPath);
      // reject oversized output
      if (raw.length > MAX_REVIEW_GENERATED_BYTES) throw new ReviewTourError('malformed_result', true);
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      const result = parseGeneratedReviewTourResult(parsed, snapshot.changes);
      // reject invalid assignments or narration
      if (!result.ok) throw new ReviewTourError(result.code, true);
      return result.tour;
    } catch (error) {
      // preserve typed failures
      if (error instanceof ReviewTourError) throw error;
      throw new ReviewTourError('malformed_result', true);
    } finally {
      clearTimeout(timer);
      timedOut.signal.removeEventListener('abort', timeoutAbort);
      signal.removeEventListener('abort', requestAbort);
      await terminate(child);
      await rm(root, { recursive: true, force: true });
    }
  }
}
