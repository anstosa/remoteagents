import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { validateConfig } from './schema.js';
import { formatReport } from '../migrations/boot.js';
import { dryRunMigration, isLegacyConfig } from '../migrations/runner.js';
import { runCli, type CliContext } from './cli.js';

const execute = promisify(execFile);
type ComposeMount = { source?: string; target?: string };

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
  // preserve omitted or malformed project lists for schema validation
  if (!Array.isArray(record.projects)) return input;
  return {
    ...record,
    projects: record.projects.map(project => {
      // preserve malformed entries for schema validation
      if (project === null || typeof project !== 'object' || Array.isArray(project)) return project;
      const entry = project as Record<string, unknown>;
      const projectPath = entry.path;
      // preserve invalid project paths for schema validation
      if (typeof projectPath !== 'string') return entry;
      // resolve selectors in the container namespace before mapping separate mounts
      const worktreeOverrides = Array.isArray(entry.worktreeOverrides) ? entry.worktreeOverrides.map(override => {
        // preserve invalid override shapes for schema validation
        if (override === null || typeof override !== 'object' || Array.isArray(override)) return override;
        const settings = override as Record<string, unknown>;
        const path = settings.path;
        // normalization must not conceal invalid raw selectors
        if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || path.includes('\0')) return override;
        return { ...settings, path: mountedPath(resolve(projectPath, path), mounts) };
      }) : entry.worktreeOverrides;
      return { ...entry, path: mountedPath(projectPath, mounts), ...(worktreeOverrides === undefined ? {} : { worktreeOverrides }) };
    })
  };
}

/**
 * Validate one configuration without starting the server, or — for a legacy config —
 * dry-run the migration and print the plan it would apply at boot. Returns the exit code.
 */
export async function checkMain({ args, env, cwd, out, err }: CliContext): Promise<number> {
  const composeMode = args.includes('--compose');
  const argument = args.find(value => value !== '--' && !value.startsWith('--'));
  const configuredPath = argument ?? env.RAC_CONFIG;
  // require one explicit or environment-backed path
  if (!configuredPath) { err('Configuration invalid: Pass a configuration path or set RAC_CONFIG.\n'); return 1; }
  const path = resolve(cwd, configuredPath);
  try {
    const rawInput = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const input = composeMode ? hostValidationInput(rawInput, await composeMounts(cwd)) : rawInput;
    // a legacy config is not validated as-is — it is dry-run through the migration instead,
    // showing the plan the console would apply at boot (bare names deferred under --compose)
    if (isLegacyConfig(input)) {
      const { report, errors } = await dryRunMigration({ configPath: path, raw: input, bridge: env.RAC_HOST_TMUX_DIR !== undefined, compose: composeMode, env });
      out(`Configuration migration plan: ${path}${composeMode ? ' (Compose paths mapped; bare program names resolved at boot inside the container)' : ''}\n`);
      for (const line of formatReport(report)) out(`  ${line}\n`);
      // content errors fail the check; warnings alone pass
      if (errors.length > 0) { for (const error of errors) err(`Configuration invalid: ${error}\n`); return 1; }
      return 0;
    }
    // a compose config names container program paths the host cannot stat, so skip the probe there
    const warnings: string[] = [];
    const config = await validateConfig(input, { warn: message => warnings.push(message), checkExecutables: !composeMode });
    const mode = config.projects.length === 0 ? 'scratch-only' : `${config.projects.length} project${config.projects.length === 1 ? '' : 's'}`;
    const configured = Object.keys(config.adapters);
    const adapters = configured.length === 0 ? 'observe-only (no adapters configured)' : configured.join(', ');
    out(`Configuration valid: ${path}\nOrigin: ${config.publicOrigin.origin}\nMode: ${mode}\nAdapters: ${adapters}${composeMode ? ' (Compose mounts verified)' : ''}\n`);
    // non-executable or crossed programs warn without failing the check
    for (const warning of warnings) err(`Warning: ${warning}\n`);
    return 0;
  } catch (error) {
    // return one actionable validation failure
    err(`Configuration invalid: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

await runCli(import.meta.url, checkMain);
