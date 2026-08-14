import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntegrationAuditService } from '../src/integrations/audit/service.js';
import { digest, IntegrationPolicyService } from '../src/integrations/policy/service.js';

describe('IntegrationPolicyService', () => {
  it('replays completed idempotent outcomes and rejects changed arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const service = new IntegrationPolicyService(join(root, 'policy.json'));
    const claimed = await service.claim('principal', 'queue_prompt', 'request-1', digest('first'));
    expect(claimed.kind).toBe('claimed');
    // narrow the successful claim
    if (claimed.kind !== 'claimed') throw new Error('claim unavailable');
    await service.finish(claimed.recordId, 'completed', { queued: true });

    await expect(service.claim('principal', 'queue_prompt', 'request-1', digest('first'))).resolves.toMatchObject({ kind: 'replay', state: 'completed', result: { queued: true } });
    await expect(service.claim('principal', 'queue_prompt', 'request-1', digest('second'))).resolves.toEqual({ kind: 'conflict' });
  });

  it('recovers interrupted claims as unknown outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const file = join(root, 'policy.json');
    const service = new IntegrationPolicyService(file);
    await service.claim('principal', 'run_stack_action', 'request-2', digest('restart'));
    await service.recoverUnknownOutcomes();

    await expect(new IntegrationPolicyService(file).claim('principal', 'run_stack_action', 'request-2', digest('restart'))).resolves.toMatchObject({ kind: 'replay', state: 'unknown_outcome' });
  });

  it('enforces capacity after appending records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const file = join(root, 'policy.json');
    const service = new IntegrationPolicyService(file, 2);
    await service.claim('principal', 'queue_prompt', 'request-1', digest('one'));
    await service.claim('principal', 'queue_prompt', 'request-2', digest('two'));
    await service.claim('principal', 'queue_prompt', 'request-3', digest('three'));

    const stored = JSON.parse(await readFile(file, 'utf8')) as { idempotency: unknown[] };
    expect(stored.idempotency).toHaveLength(2);
    await expect(new IntegrationPolicyService(file, 2).recoverUnknownOutcomes()).resolves.toBeUndefined();
  });

  it('migrates legacy confirmation state without retaining it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const file = join(root, 'policy.json');
    await writeFile(file, JSON.stringify({ version: 1, confirmations: [{ tokenHash: 'unsafe' }], idempotency: [] }));
    const service = new IntegrationPolicyService(file);

    await service.recoverUnknownOutcomes();
    const stored = JSON.parse(await readFile(file, 'utf8')) as { version: number; confirmations?: unknown[] };
    expect(stored).toMatchObject({ version: 3 });
    expect(stored.confirmations).toBeUndefined();
  });
});

describe('IntegrationAuditService', () => {
  it('writes bounded redacted audit events without tool payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-audit-'));
    const file = join(root, 'audit.jsonl');
    const service = new IntegrationAuditService(file);
    await service.record({ phase: 'outcome', timestamp: new Date().toISOString(), durationMs: 25, correlationId: 'correlation', requestId: 'request', principalHash: 'principal-hash', clientId: 'chatgpt', tool: 'queue_prompt', scopes: ['prompts:write'], risk: 'write', argumentsDigest: digest('secret prompt'), targetSummary: 'agent-1', result: 'success' });

    const stored = JSON.parse((await readFile(file, 'utf8')).trim());
    expect(stored).toMatchObject({ correlationId: 'correlation', tool: 'queue_prompt', result: 'success' });
    expect(JSON.stringify(stored)).not.toContain('secret prompt');
  });
});
