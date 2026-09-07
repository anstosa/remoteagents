import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../../scripts/share-preview.mjs', import.meta.url));
const servers: Server[] = [];
const directories: string[] = [];

// listen on one ephemeral loopback port
const listen = async (server: Server) => await new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    // require a TCP listener
    if (address === null || typeof address === 'string') { reject(new Error('missing listener')); return; }
    resolve(address.port);
  });
});

// close every preview origin
afterEach(async () => {
  // close each temporary listener
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  // remove helper output
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('share-preview helper', () => {
  // register one live server and print its public URL
  it('writes a private expiring registration for a listening port', async () => {
    const upstream = createServer((_request, response) => response.end('preview'));
    servers.push(upstream);
    const port = await listen(upstream);
    const directory = await mkdtemp(join(tmpdir(), 'rac-share-preview-'));
    directories.push(directory);
    const registrations = join(directory, 'registrations');
    const config = join(directory, 'config.json');
    await writeFile(config, JSON.stringify({ publicOrigin: 'https://agents.example.com' }));

    const result = await run(process.execPath, [script, String(port), '--ttl', '30m', '--config', config, '--json'], { env: { ...process.env, RAC_TEMP_PREVIEWS_DIR: registrations } });
    const shared = JSON.parse(result.stdout) as { expiresAt: string; port: number; token: string; url: string };
    expect(shared.port).toBe(port);
    expect(shared.token).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(shared.url).toBe(`https://agents.example.com/preview/${shared.token}/`);
    expect(Date.parse(shared.expiresAt)).toBeGreaterThan(Date.now() + 29 * 60_000);
    const stored = JSON.parse(await readFile(join(registrations, `${shared.token}.json`), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ version: 1, port, expiresAt: shared.expiresAt });
    expect((await stat(join(registrations, `${shared.token}.json`))).mode & 0o777).toBe(0o600);
    await expect(run(process.execPath, [script, String(port), '--origin', 'file:///tmp/preview', '--json'], { env: { ...process.env, RAC_TEMP_PREVIEWS_DIR: registrations } })).rejects.toBeDefined();
  });
});
