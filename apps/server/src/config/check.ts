import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { validateConfig } from './schema.js';

const execute = promisify(execFile);
type ComposeMount = { source?: string; target?: string };

const envFile = new URL('../../../../.env', import.meta.url);
// load the repository environment when available
if (existsSync(envFile)) process.loadEnvFile(envFile);

// resolve container worktree paths through active Compose mounts
async function composeMounts(directory: string): Promise<ComposeMount[]> {
  const { stdout } = await execute('docker', ['compose', 'config', '--format', 'json'], { cwd: directory, maxBuffer: 8 * 1024 * 1024 });
  const compose = JSON.parse(stdout) as { services?: Record<string, { volumes?: ComposeMount[] }> };
  return compose.services?.['remote-agent-console']?.volumes ?? [];
}

// map one container path to the corresponding host source
function mountedPath(path: string, mounts: ComposeMount[]): string {
  const matching = mounts
    .filter((mount): mount is Required<ComposeMount> => typeof mount.source === 'string' && typeof mount.target === 'string' && (path === mount.target || path.startsWith(`${mount.target}/`)))
    .sort((left, right) => right.target.length - left.target.length)[0];
  // preserve unmapped paths for the normal validation error
  if (matching === undefined) return path;
  return resolve(matching.source, path.slice(matching.target.length).replace(/^\/+/, ''));
}

// substitute only filesystem paths inspected on the host
function hostValidationInput(input: unknown, mounts: ComposeMount[]): unknown {
  // preserve malformed top-level values for schema validation
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  // preserve omitted or malformed worktree lists for schema validation
  if (!Array.isArray(record.worktrees)) return input;
  return {
    ...record,
    worktrees: record.worktrees.map(worktree => {
      // preserve malformed entries for schema validation
      if (worktree === null || typeof worktree !== 'object' || Array.isArray(worktree)) return worktree;
      const entry = worktree as Record<string, unknown>;
      return typeof entry.path === 'string' ? { ...entry, path: mountedPath(entry.path, mounts) } : entry;
    })
  };
}

// validate one configuration without starting the server
async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const composeMode = arguments_.includes('--compose');
  const argument = arguments_.find(value => value !== '--' && !value.startsWith('--'));
  const configuredPath = argument ?? process.env.RAC_CONFIG;
  // require one explicit or environment-backed path
  if (!configuredPath) throw new Error('Pass a configuration path or set RAC_CONFIG.');
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const path = resolve(invocationDirectory, configuredPath);
  const rawInput = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const input = composeMode ? hostValidationInput(rawInput, await composeMounts(invocationDirectory)) : rawInput;
  // a compose config names container program paths the host cannot stat, so skip the probe there
  const warnings: string[] = [];
  const config = await validateConfig(input, { warn: message => warnings.push(message), checkExecutables: !composeMode });
  const mode = config.worktrees.length === 0 ? 'scratch-only' : `${config.worktrees.length} worktree${config.worktrees.length === 1 ? '' : 's'}`;
  const configured = config.adapters === undefined ? undefined : Object.keys(config.adapters);
  const adapters = configured === undefined ? 'legacy (no adapters block)' : configured.length === 0 ? 'observe-only (no adapters configured)' : configured.join(', ');
  process.stdout.write(`Configuration valid: ${path}\nOrigin: ${config.publicOrigin.origin}\nMode: ${mode}\nAdapters: ${adapters}${composeMode ? ' (Compose mounts verified)' : ''}\n`);
  // non-executable programs and ignored legacy keys warn without failing the check
  for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
}

// return one actionable validation failure
await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Configuration invalid: ${message}\n`);
  process.exitCode = 1;
});
