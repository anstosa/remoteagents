import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const maxAuditBytes = 10 * 1_024 * 1_024;
const maxFieldLength = 256;

export type AuditEvent = {
  phase: 'intent' | 'outcome';
  timestamp: string;
  durationMs: number;
  correlationId: string;
  requestId?: string;
  principalHash: string;
  clientId: string;
  tool: string;
  scopes: string[];
  risk: 'read' | 'write' | 'operational' | 'dangerous';
  argumentsDigest: string;
  targetSummary?: string;
  idempotencyId?: string;
  result: 'pending' | 'success' | 'error';
  errorCode?: string;
};

// append redacted integration audit events
export class IntegrationAuditService {
  private writing = Promise.resolve();

  // retain one private append-only log
  constructor(private readonly file = process.env.RAC_INTEGRATION_AUDIT_FILE ?? '.data/integration-audit.jsonl') {}

  // serialize one bounded event
  async record(event: AuditEvent): Promise<void> {
    const safe = sanitize(event);
    const task = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const size = await stat(this.file).then(info => info.size).catch(() => 0);
      // rotate one bounded generation
      if (size >= maxAuditBytes) await rename(this.file, `${this.file}.1`).catch(() => undefined);
      await appendFile(this.file, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
      await chmod(this.file, 0o600);
    });
    this.writing = task.then(() => undefined, () => undefined);
    await task;
  }
}

// bound every model-independent audit field
function sanitize(event: AuditEvent): AuditEvent {
  return {
    phase: event.phase,
    timestamp: validTimestamp(event.timestamp) ? event.timestamp : new Date().toISOString(),
    durationMs: Math.max(0, Math.min(Math.round(event.durationMs), 24 * 60 * 60_000)),
    correlationId: bounded(event.correlationId),
    ...(event.requestId === undefined ? {} : { requestId: bounded(event.requestId) }),
    principalHash: bounded(event.principalHash),
    clientId: bounded(event.clientId),
    tool: bounded(event.tool),
    scopes: event.scopes.slice(0, 16).map(bounded),
    risk: event.risk,
    argumentsDigest: bounded(event.argumentsDigest),
    ...(event.targetSummary === undefined ? {} : { targetSummary: bounded(event.targetSummary) }),
    ...(event.idempotencyId === undefined ? {} : { idempotencyId: bounded(event.idempotencyId) }),
    result: event.result,
    ...(event.errorCode === undefined ? {} : { errorCode: bounded(event.errorCode) })
  };
}

// cap one audit string
function bounded(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, maxFieldLength);
}

// accept only canonical timestamps
function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
