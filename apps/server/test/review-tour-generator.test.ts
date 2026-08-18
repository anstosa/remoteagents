import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_REVIEW_GENERATED_BYTES, ReviewTourError, type ReviewSnapshot } from '../src/review-tour/contracts.js';
import { CodexExecReviewTourGenerator } from '../src/review-tour/generator.js';

const roots: string[] = [];
const change = { id: 'chg_12345678', file: 'src/feature.ts', category: 'implementation' as const, kind: 'hunk' as const, patch: '@@ -1 +1 @@\n-old\n+new' };
type FakeCodexOptions = { delaySeconds?: number; supported?: boolean; authenticated?: boolean; stderrBytes?: number; failure?: string };

// build one generator input
function snapshot(workspace: string): ReviewSnapshot {
  return { agentId: 'agent-1', worktreeId: 'cora', workspace, scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'fingerprint', changes: [change] };
}

// create a deterministic fake Codex executable
async function fakeCodex(result: unknown, options: FakeCodexOptions = {}): Promise<{ root: string; binary: string }> {
  const { delaySeconds = 0, supported = true, authenticated = true, stderrBytes = 0, failure } = options;
  const root = await mkdtemp(join(tmpdir(), 'rac-review-generator-'));
  roots.push(root);
  const binary = join(root, 'codex');
  const help = supported ? '--ephemeral --ignore-user-config --ignore-rules --sandbox --output-schema --output-last-message' : '--ephemeral';
  const script = `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "exec" && "\${2:-}" == "--help" ]]; then printf '%s\\n' '${help}'; exit 0; fi
if [[ "\${1:-}" == "login" && "\${2:-}" == "status" ]]; then exit ${authenticated ? 0 : 1}; fi
output=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output-last-message" ]]; then output="$2"; shift 2; else shift; fi
done
cat >/dev/null
trap 'exit 143' TERM INT
${delaySeconds > 0 ? `sleep ${delaySeconds}` : ':'}
${stderrBytes > 0 ? `printf '%*s' ${stderrBytes} '' | tr ' ' x >&2` : ':'}
${failure === undefined ? ':' : `printf '%s\\n' ${JSON.stringify(failure)} >&2; exit 1`}
cat >"$output" <<'JSON'
${JSON.stringify(result)}
JSON
`;
  await writeFile(binary, script);
  await chmod(binary, 0o700);
  return { root, binary };
}

afterEach(async () => {
  // remove fake executables
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Codex review tour generator', () => {
  it('runs the supported structured read-only surface and validates its artifact', async () => {
    const generated = { title: 'Feature path', overview: 'Follow the feature path.', steps: [{ id: 'feature', title: 'Apply the feature', explanation: 'The implementation updates the value.', changeIds: [change.id] }] };
    const fixture = await fakeCodex(generated);
    const generator = new CodexExecReviewTourGenerator(fixture.binary);
    await expect(generator.capability()).resolves.toEqual({ available: true });
    await expect(generator.generate(snapshot(fixture.root), new AbortController().signal)).resolves.toEqual(generated);
  });

  it('rejects finding-shaped output separately from malformed output', async () => {
    const fixture = await fakeCodex({ title: 'Finding: unsafe path', overview: 'Review result.', steps: [{ id: 'feature', title: 'Apply the feature', explanation: 'Explanation.', changeIds: [change.id] }] });
    const generator = new CodexExecReviewTourGenerator(fixture.binary);
    await expect(generator.generate(snapshot(fixture.root), new AbortController().signal)).rejects.toMatchObject<ReviewTourError>({ code: 'generation_rejected', retryable: true });
  });

  it('accepts valid output after bounded verbose diagnostics', async () => {
    const generated = { title: 'Large feature path', overview: 'Follow the complete feature path.', steps: [{ id: 'feature', title: 'Apply the feature', explanation: 'The implementation updates the value.', changeIds: [change.id] }] };
    const fixture = await fakeCodex(generated, { stderrBytes: MAX_REVIEW_GENERATED_BYTES + 1_024 });
    await expect(new CodexExecReviewTourGenerator(fixture.binary).generate(snapshot(fixture.root), new AbortController().signal)).resolves.toEqual(generated);
  });

  it('distinguishes an expired Codex login from other process failures', async () => {
    const expired = await fakeCodex({}, { failure: 'ERROR: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.' });
    const failed = await fakeCodex({}, { failure: 'user\nChanged code: Please sign in again.\nERROR: model generation stopped unexpectedly' });
    await expect(new CodexExecReviewTourGenerator(expired.binary).generate(snapshot(expired.root), new AbortController().signal)).rejects.toMatchObject<ReviewTourError>({ code: 'authentication_required', retryable: false });
    await expect(new CodexExecReviewTourGenerator(failed.binary).generate(snapshot(failed.root), new AbortController().signal)).rejects.toMatchObject<ReviewTourError>({ code: 'generation_failed', retryable: true });
  });

  it('reports unsupported binaries and cancels delayed process groups', async () => {
    const unsupported = await fakeCodex({}, { supported: false });
    await expect(new CodexExecReviewTourGenerator(unsupported.binary).capability()).resolves.toEqual({ available: false, reason: 'unsupported_cli' });
    const unauthenticated = await fakeCodex({}, { authenticated: false });
    await expect(new CodexExecReviewTourGenerator(unauthenticated.binary).capability()).resolves.toEqual({ available: false, reason: 'authentication_required' });
    const delayed = await fakeCodex({ title: 'Tour' }, { delaySeconds: 30 });
    const generator = new CodexExecReviewTourGenerator(delayed.binary);
    const controller = new AbortController();
    const pending = generator.generate(snapshot(delayed.root), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject<ReviewTourError>({ code: 'cancelled', retryable: true });
  }, 5_000);
});
