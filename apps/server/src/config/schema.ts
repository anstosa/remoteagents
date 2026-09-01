import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { StackCommands, Worktree } from '../domain/models.js';
import { adapterFor } from '../adapters/registry.js';
import { hostVisibleRepoRoot } from '../adapters/files.js';
import { agentKinds, type AdapterConfigs, type AdapterLaunchConfig } from '../adapters/types.js';
import { instanceIconNames, type InstanceIcon } from '../instance-icon.js';
import { isIP } from 'node:net';

const loopback = new Set(['127.0.0.1', '::1']);
// wildcard binds expose every interface; require an explicit address instead
const wildcard = new Set(['0.0.0.0', '::']);
const command = z.string().min(1).max(32_000).refine((v) => !v.includes('\0'), 'NUL is forbidden');
const stackCommands = z.object({ start: command.optional(), stop: command.optional(), build: command.optional(), restart: command.optional(), migrate: command.optional(), status: command.optional() }).strict();
const pushAction = z.object({ label: z.string().trim().min(1).max(80), prompt: command }).strict().default({ label: 'Commit/Push', prompt: 'review, commit, and push' });
const serverName = z.string().trim().min(1).max(80).refine(value => !value.includes('\0'), 'NUL is forbidden');
// One configured agent CLI. `program` is an absolute, real executable (not a
// version-manager shim that needs a shell); `args` and `env` are the operator's
// additions the console appends/merges. Values are never shell-expanded (the
// console shell-quotes them), so placeholders are literal; env is not for secrets.
const adapterProgram = z.string().min(1).max(4096).startsWith('/', 'adapter program must be an absolute path').refine(value => !value.includes('\0'), 'NUL is forbidden');
const adapterArgument = z.string().max(4096).refine(value => !value.includes('\0'), 'NUL is forbidden');
const adapterEnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'invalid environment variable name');
const adapterEntry = z.object({ program: adapterProgram, args: z.array(adapterArgument).max(64).optional(), env: z.record(adapterEnvName, adapterArgument).optional() }).strict();
// keyed by kind, one strict entry each; an omitted block is the legacy configuration
const adaptersSchema = z.object({ codex: adapterEntry.optional(), claude: adapterEntry.optional(), pi: adapterEntry.optional(), opencode: adapterEntry.optional() }).strict();
// constrain icons to bundled artwork
const instanceIcon = z.enum(instanceIconNames);
const remoteServer = z.object({ url: z.string(), name: serverName.optional(), icon: instanceIcon.optional() }).strict();
// default every remote surface off
const integrationFeatures = z.object({
  enabled: z.boolean().default(false),
  mcp: z.object({ readEnabled: z.boolean().default(true), writeEnabled: z.boolean().default(false), dangerousEnabled: z.boolean().default(false) }).strict().default({}),
  realtime: z.object({ enabled: z.boolean().default(false), writeToolsEnabled: z.boolean().default(false) }).strict().default({}),
  multiInstance: z.object({ enabled: z.boolean().default(false) }).strict().default({})
}).strict().default({});
const sourceSchema = z.object({
  listen: z.object({ host: z.string(), port: z.number().int().min(1).max(65535) }).strict().default({ host: '127.0.0.1', port: 8787 }),
  name: serverName.default('Remote Agents'),
  icon: instanceIcon.optional(),
  publicOrigin: z.string(),
  remoteServers: z.array(remoteServer).max(20).default([]),
  proxy: z.object({ trustedSourceIps: z.array(z.string()).default(['127.0.0.1', '::1']) }).strict().default({}),
  tmux: z.object({ pollIntervalMs: z.number().int().min(250).max(10000).default(500) }).strict().default({}),
  newAgentCommand: command.default('codex'),
  adapters: adaptersSchema.optional(),
  integrations: integrationFeatures,
  // allow a scratch-only first run
  worktrees: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), label: z.string().max(120).optional(), path: z.string().min(1), hostPath: z.string().startsWith('/').optional(), saveKey: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(), pinned: z.boolean().default(false), port: z.number().int().min(1).max(65535).optional(), hostname: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/).optional(), command: command.optional(), resumeCommand: command.optional(), commands: stackCommands.optional(), newTask: command.optional(), push: pushAction }).strict()).max(100).default([])
}).strict();
export type ConfigInput = z.input<typeof sourceSchema>;
export type RemoteServer = { url: URL };
export type IntegrationConfig = z.output<typeof integrationFeatures>;
export type ValidatedConfig = { listen: { host: string; port: number }; name: string; icon?: InstanceIcon; publicOrigin: URL; remoteServers: RemoteServer[]; trustedProxyIps: Set<string>; pollIntervalMs: number; newAgentCommand: string; adapters?: AdapterConfigs; integrations?: IntegrationConfig; worktrees: Worktree[] };
// how validation surfaces non-fatal facts: `warn` collects boot warnings (ignored
// legacy keys, non-executable programs); `checkExecutables` runs the boot X_OK probe
// and is skipped under the host bridge, where `program` is a host path the container
// cannot stat. Defaults: no-op warnings, probe on unless the host bridge is configured.
export type ValidateConfigOptions = { warn?: (message: string) => void; checkExecutables?: boolean };
// support legacy test fixtures
export const defaultIntegrationConfig: IntegrationConfig = integrationFeatures.parse(undefined);

// the Codex binary the out-of-band services (review tour, accounts, update advisor)
// spawn: an explicit RAC_CODEX_BIN override, else the configured adapters.codex program.
export function resolveCodexProgram(config: Pick<ValidatedConfig, 'adapters'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.RAC_CODEX_BIN ?? config.adapters?.codex?.program;
}

// require one canonical browser origin
function canonicalOrigin(value: string, label = 'publicOrigin', allowLoopbackHttp = false): URL {
  let url: URL;
  // reject malformed absolute origins
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute URL`); }
  const localHttpHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);
  const allowedLocalHttp = allowLoopbackHttp && url.protocol === 'http:' && localHttpHosts.has(url.hostname);
  // require HTTPS except for a direct loopback browser
  if (url.protocol !== 'https:' && !allowedLocalHttp) throw new Error(`${label} must use HTTPS or loopback HTTP`);
  // reject credentials and non-origin URL parts
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error(`${label} must be a canonical origin only`);
  return url;
}
function validateNewTask(template: string): void {
  if (/\{(?!taskId\})/.test(template)) throw new Error('unknown new task placeholder');
}
// require one exact thread substitution
function validateResumeCommand(template: string): void {
  const placeholders = template.match(/\{threadId\}/gu) ?? [];
  if (placeholders.length !== 1 || /\{(?!threadId\})/u.test(template)) throw new Error('resume command must contain exactly one {threadId} placeholder');
}
async function gitRoot(path: string): Promise<string> {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    const child = spawn('/usr/bin/git', ['-C', path, 'rev-parse', '--show-toplevel'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    let output = ''; child.stdout.on('data', (d) => { output += String(d); });
    child.on('close', async (code) => { if (code !== 0) return resolve(path); try { resolve(await realpath(output.trim())); } catch { resolve(path); } });
    child.on('error', () => resolve(path));
  });
}
// let RAC_LISTEN_HOST / RAC_LISTEN_PORT in the environment override the file's listen block
export function applyListenOverrides(input: unknown, env: Record<string, string | undefined>): unknown {
  const host = env.RAC_LISTEN_HOST?.trim(); const port = env.RAC_LISTEN_PORT?.trim();
  if (!host && !port) return input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const current = typeof source.listen === 'object' && source.listen !== null ? source.listen as Record<string, unknown> : {};
  const listen: Record<string, unknown> = { host: current.host ?? '127.0.0.1', port: current.port ?? 8787 };
  if (host) listen.host = host;
  if (port) { if (!/^\d{1,5}$/.test(port)) throw new Error('RAC_LISTEN_PORT must be an integer'); listen.port = Number(port); }
  return { ...source, listen };
}
type ParsedAdapters = z.output<typeof adaptersSchema>;
// resolve each configured adapter program: normalise args/env, probe executability
// (unless bridged), and warn about operator arguments the Adapter reserves.
async function resolveAdapters(parsed: ParsedAdapters, checkExecutables: boolean, warn: (message: string) => void): Promise<AdapterConfigs> {
  const configs: AdapterConfigs = {};
  for (const kind of agentKinds) {
    const entry = parsed[kind];
    if (entry === undefined) continue;
    const config: AdapterLaunchConfig = { program: entry.program, args: entry.args ?? [], env: entry.env ?? {}, launchable: true };
    // a missing program, a directory, or a non-executable file never refuses boot;
    // it disables that kind with a reason (a directory is +x, so require a real file)
    if (checkExecutables) {
      const executable = await stat(entry.program).then(info => info.isFile()).catch(() => false)
        && await access(entry.program, constants.X_OK).then(() => true).catch(() => false);
      if (!executable) {
        config.launchable = false;
        config.unavailableReason = `${entry.program} is not an executable file`;
        warn(`adapters.${kind}: ${config.unavailableReason}`);
      }
    }
    // an Adapter reserves the arguments it composes itself; a reserved operator
    // argument is dropped with a warning so it never doubles the composed launch.
    // A reserved flag takes its attached value with it (the following token, unless
    // that token is itself a flag), so a stray value never lands as a launch
    // positional. Codex reserves none.
    const reserved = adapterFor(kind)?.conflictingArgs;
    if (reserved !== undefined && reserved.length > 0) {
      const kept: string[] = [];
      const dropped: string[] = [];
      for (let index = 0; index < config.args.length; index += 1) {
        const argument = config.args[index]!;
        if (!reserved.includes(argument)) { kept.push(argument); continue; }
        dropped.push(argument);
        // consume the flag's attached value; a following flag is a separate argument
        const value = config.args[index + 1];
        if (value !== undefined && !value.startsWith('-')) index += 1;
      }
      if (dropped.length > 0) {
        config.args = kept;
        warn(`adapters.${kind}: ignoring reserved argument${dropped.length === 1 ? '' : 's'} ${dropped.join(', ')}`);
      }
    }
    // an Adapter that renders host-path files (Claude's hooks) needs a host-visible
    // checkout root; under the bridge without RAC_HOST_REPOSITORY the injected paths
    // would be wrong, so the kind cannot launch. Off the bridge the console's own
    // checkout always resolves, so this only ever fires under the bridge.
    if (config.launchable && adapterFor(kind)?.files !== undefined && hostVisibleRepoRoot() === undefined) {
      config.launchable = false;
      config.unavailableReason = 'the host bridge needs RAC_HOST_REPOSITORY set to the host checkout path';
      warn(`adapters.${kind}: ${config.unavailableReason}`);
    }
    configs[kind] = config;
  }
  return configs;
}
// warn once per legacy agent key that `adapters.codex` overrides and the console now ignores
function warnLegacyAgentKeys(input: unknown, warn: (message: string) => void): void {
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (raw.newAgentCommand !== undefined) warn('adapters.codex is configured; ignoring legacy `newAgentCommand`');
  const worktrees = Array.isArray(raw.worktrees) ? raw.worktrees : [];
  const has = (key: string) => worktrees.some(entry => entry !== null && typeof entry === 'object' && (entry as Record<string, unknown>)[key] !== undefined);
  if (has('command')) warn('adapters.codex is configured; ignoring legacy worktree `command`');
  if (has('resumeCommand')) warn('adapters.codex is configured; ignoring legacy worktree `resumeCommand`');
}
// validate and canonicalize console configuration
export async function validateConfig(input: unknown, options: ValidateConfigOptions = {}): Promise<ValidatedConfig> {
  const parsed = sourceSchema.parse(input);
  const warn = options.warn ?? (() => {});
  // the host bridge cannot stat host program paths from inside the container
  const checkExecutables = options.checkExecutables ?? process.env.RAC_HOST_TMUX_DIR === undefined;
  const adapters = parsed.adapters === undefined ? undefined : await resolveAdapters(parsed.adapters, checkExecutables, warn);
  // `adapters.codex` wins everywhere and retires the legacy agent keys
  const adaptersLaunchCodex = adapters?.codex !== undefined;
  if (adaptersLaunchCodex) warnLegacyAgentKeys(input, warn);
  if (isIP(parsed.listen.host) === 0) throw new Error('listener host must be an IP address literal');
  if (wildcard.has(parsed.listen.host)) throw new Error('listener must bind to a specific address, not a wildcard');
  if (parsed.proxy.trustedSourceIps.some((ip) => !loopback.has(ip))) throw new Error('only loopback proxy sources are permitted');
  const publicOrigin = canonicalOrigin(parsed.publicOrigin, 'publicOrigin', true);
  // retain only canonical remote origins
  const remoteServers = parsed.remoteServers.map(server => ({ url: canonicalOrigin(server.url, 'remote server') }));
  const serverUrls = new Set([publicOrigin.origin]);
  // reject duplicate server switch targets
  for (const server of remoteServers) {
    if (serverUrls.has(server.url.origin)) throw new Error('remote server URLs must be unique');
    serverUrls.add(server.url.origin);
  }
  const worktrees: Worktree[] = []; const ids = new Set<string>(); const identities = new Set<string>();
  for (const raw of parsed.worktrees) {
    if (ids.has(raw.id)) throw new Error('duplicate worktree id'); ids.add(raw.id);
    const path = await realpath(raw.path); const info = await stat(path); if (!info.isDirectory()) throw new Error(`worktree ${raw.id} is not a directory`);
    if (raw.newTask !== undefined) validateNewTask(raw.newTask);
    if (raw.resumeCommand !== undefined) validateResumeCommand(raw.resumeCommand);
    // legacy worktrees launch through their own shell command; when `adapters.codex`
    // wins the console launches by kind and the per-worktree `command` is ignored
    if (!adaptersLaunchCodex && raw.command === undefined) throw new Error(`worktree ${raw.id} must define a command`);
    const identity = await gitRoot(path); if (identities.has(identity)) throw new Error('duplicate worktree identity'); identities.add(identity);
    if ((raw.port === undefined) !== (raw.hostname === undefined)) throw new Error(`worktree ${raw.id} must define both port and hostname`);
    const projectUrl = raw.hostname === undefined ? undefined : `https://${raw.hostname}`;
    worktrees.push({ id: raw.id, label: raw.label ?? raw.id, path, identity, hostPath: raw.hostPath === undefined ? undefined : resolve(raw.hostPath), saveKey: raw.saveKey ?? raw.id, available: true, pinned: raw.pinned, command: raw.command, ...(raw.resumeCommand === undefined ? {} : { resumeCommand: raw.resumeCommand }), projectUrl, projectPort: raw.port, push: raw.push, ...(raw.commands === undefined ? {} : { commands: raw.commands as StackCommands }), ...(raw.newTask === undefined ? {} : { newTask: raw.newTask }) });
  }
  return { listen: { host: parsed.listen.host, port: parsed.listen.port }, name: parsed.name, ...(parsed.icon === undefined ? {} : { icon: parsed.icon }), publicOrigin, remoteServers, trustedProxyIps: new Set(parsed.proxy.trustedSourceIps), pollIntervalMs: parsed.tmux.pollIntervalMs, newAgentCommand: parsed.newAgentCommand, ...(adapters === undefined ? {} : { adapters }), integrations: parsed.integrations, worktrees };
}
