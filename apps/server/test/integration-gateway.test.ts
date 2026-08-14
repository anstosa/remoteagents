import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntegrationAuditService } from '../src/integrations/audit/service.js';
import type { AuditEvent } from '../src/integrations/audit/service.js';
import type { IntegrationPrincipal } from '../src/integrations/auth/index.js';
import { IntegrationGateway } from '../src/integrations/mcp/gateway.js';
import { IntegrationPolicyService } from '../src/integrations/policy/service.js';
import { IntegrationControlService } from '../src/integrations/control/index.js';

const principal: IntegrationPrincipal = { authentication: 'oauth', subjectId: 'user', clientId: 'chatgpt', audience: 'https://agents.example.com/mcp', scopes: ['status:read', 'prompts:write'] };
const config = { enabled: true, mcp: { readEnabled: true, writeEnabled: true, dangerousEnabled: false }, realtime: { enabled: true, writeToolsEnabled: true }, multiInstance: { enabled: true } };

// create one private policy-backed gateway fixture
async function fixture(audit?: { record: (event: AuditEvent) => Promise<void> }) {
  const root = await mkdtemp(join(tmpdir(), 'rac-gateway-'));
  let queued = 0;
  const orchestration = {
    listInstances: async () => ({ ok: true as const, version: 'v1' as const, value: [{ id: 'https://agents.example.com', name: 'Local', url: 'https://agents.example.com', local: true }] }),
    queuePrompt: async () => { queued += 1; return { ok: true as const, version: 'v1' as const, value: { accepted: true as const } }; }
  };
  const forwarded: Array<{ instanceId: string; name: string; voiceAuthorized: boolean }> = [];
  const policy = new IntegrationPolicyService(join(root, 'policy.json'));
  const control = new IntegrationControlService(() => 'browser-session');
  control.startVoice('browser-session', 'voice-session-123456789');
  const gateway = new IntegrationGateway({
    config,
    instanceId: 'https://agents.example.com',
    orchestration: orchestration as never,
    policy,
    audit: audit ?? new IntegrationAuditService(join(root, 'audit.jsonl')),
    control,
    forward: async (instanceId, _principal, name, _args, voiceAuthorized) => { forwarded.push({ instanceId, name, voiceAuthorized }); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true, remote: true } }; }
  });
  return { root, gateway, control, queued: () => queued, forwarded };
}

describe('IntegrationGateway', () => {
  it('runs mutations only during voice mode and replays idempotent results', async () => {
    const { root, gateway, control, queued } = await fixture();
    try {
      const args = { agent_id: 'agent-1', prompt: 'Review the branch', request_id: 'request-123' };
      const completed = await gateway.call(principal, 'queue_prompt', args);
      expect(completed.structuredContent).toMatchObject({ ok: true, data: { accepted: true } });
      const replayed = await gateway.call(principal, 'queue_prompt', args);
      expect(replayed.structuredContent).toMatchObject({ ok: true, replayed: true });
      expect(queued()).toBe(1);
      control.stopVoice('browser-session', 'voice-session-123456789');
      await expect(gateway.call(principal, 'queue_prompt', { ...args, request_id: 'request-voice-off' })).resolves.toMatchObject({ structuredContent: { error: { code: 'voice_mode_required' } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('forwards an explicitly selected configured instance', async () => {
    const { root, gateway, forwarded } = await fixture();
    try {
      const result = await gateway.call(principal, 'list_instances', { instance_id: 'https://peer.example.com' });
      expect(result.structuredContent).toEqual({ ok: true, remote: true });
      const mutation = await gateway.call(principal, 'queue_prompt', { instance_id: 'https://peer.example.com', agent_id: 'agent-1', prompt: 'Review', request_id: 'request-remote' });
      expect(mutation.structuredContent).toEqual({ ok: true, remote: true });
      expect(forwarded).toEqual([{ instanceId: 'https://peer.example.com', name: 'list_instances', voiceAuthorized: false }, { instanceId: 'https://peer.example.com', name: 'queue_prompt', voiceAuthorized: true }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed before mutations when audit intent cannot be stored', async () => {
    const { root, gateway, queued } = await fixture({ record: async event => {
      // fail only the pre-effect audit
      if (event.phase === 'intent') throw new Error('disk unavailable');
    } });
    try {
      const args = { agent_id: 'agent-1', prompt: 'Review the branch', request_id: 'request-456' };
      await expect(gateway.call(principal, 'queue_prompt', args)).resolves.toMatchObject({ structuredContent: { error: { code: 'audit_unavailable' } } });
      expect(queued()).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
