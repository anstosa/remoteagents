import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { checkMain } from '../src/config/check.js';

const directories: string[] = [];

// restore the external command boundary and remove only fixture directories
afterEach(async () => {
  vi.unstubAllEnvs();
  // clean each isolated fixture
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// supply compose mount metadata without touching the live docker project
async function checkOverrides(overrides: unknown[]): Promise<number> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-compose-check-')));
  directories.push(root);
  const repository = join(root, 'main');
  const sibling = join(root, 'separate-mount', 'feature');
  const binaries = join(root, 'bin');
  await mkdir(repository);
  await mkdir(sibling, { recursive: true });
  await mkdir(binaries);
  await writeFile(join(binaries, 'compose.json'), JSON.stringify({ services: {
    'remote-agent-console': { volumes: [
      { source: repository, target: '/container/main' },
      { source: sibling, target: '/container/feature' }
    ] }
  } }));
  await writeFile(join(binaries, 'docker'), '#!/bin/sh\ncat "$(dirname "$0")/compose.json"\n', { mode: 0o700 });
  vi.stubEnv('PATH', `${binaries}${delimiter}${process.env.PATH ?? ''}`);
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ publicOrigin: 'https://agents.example.com', projects: [
    { id: 'example', path: '/container/main', worktreeOverrides: overrides }
  ] }));
  // exercise the public cli without persisting its diagnostic output
  return await checkMain({ args: [configPath, '--compose'], env: {}, cwd: root, out: () => {}, err: () => {} });
}

// compare selectors in the same namespace as container boot
describe('compose config preflight', () => {
  // absolute container aliases must resolve to the mapped project root
  it('rejects duplicate main-worktree selectors after mapping compose mounts', async () => {
    expect(await checkOverrides([{ path: '.' }, { path: '/container/main' }])).toBe(1);
  });

  // sibling mounts can have unrelated host parent directories
  it('rejects relative and absolute aliases across separate sibling mounts', async () => {
    expect(await checkOverrides([{ path: '../feature' }, { path: '/container/feature' }])).toBe(1);
  });

  // preserve distinct configured checkouts
  it('accepts independent main and sibling selectors', async () => {
    expect(await checkOverrides([{ path: '.' }, { path: '../feature' }])).toBe(0);
  });

  // mapping must not repair invalid selectors before schema validation
  it.each([
    { label: 'empty', path: '' },
    { label: 'NUL-containing', path: 'bad\0path' },
    { label: 'oversized', path: '../'.repeat(1500) }
  ])('rejects an invalid $label override path', async ({ path }) => {
    expect(await checkOverrides([{ path }])).toBe(1);
  });
});
