import { afterEach, expect, it, vi } from 'vitest';
import { createCodexProtocolClient } from '../src/accounts/protocol.js';

// restore the parent environment after each isolated child
afterEach(() => { vi.unstubAllEnvs(); });

// keep privileged billing credentials out of account and skill subprocesses
it('removes billing credentials even from explicit protocol environment overrides', async () => {
  vi.stubEnv('RAC_OPENAI_ADMIN_KEY', 'synthetic-parent-secret');
  vi.stubEnv('RAC_OPENAI_API_KEY_IDS', '{"account-1":"key_test"}');
  const script = `
    import { createInterface } from 'node:readline';
    // report only credential presence through the fixture protocol
    createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: request.id, result: {
        adminKeyPresent: 'RAC_OPENAI_ADMIN_KEY' in process.env,
        billingMapPresent: 'RAC_OPENAI_API_KEY_IDS' in process.env,
        codexHome: process.env.CODEX_HOME,
        preserved: process.env.RAC_TEST_PRESERVED
      } }) + '\\n');
    });
  `;
  const client = await createCodexProtocolClient('/tmp/synthetic-codex-home', {
    command: process.execPath,
    args: ['--input-type=module', '-e', script],
    env: { RAC_OPENAI_ADMIN_KEY: 'synthetic-override-secret', RAC_TEST_PRESERVED: 'yes' }
  });
  try {
    expect(await client.request('environment')).toEqual({ adminKeyPresent: false, billingMapPresent: false, codexHome: '/tmp/synthetic-codex-home', preserved: 'yes' });
  } finally {
    await client.close();
  }
});
