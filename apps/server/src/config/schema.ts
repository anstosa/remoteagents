import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { Project, StackCommands } from '../domain/models.js';
import { gitCommonDir, listWorktrees } from '../git/worktrees.js';
import { adapterFor } from '../adapters/registry.js';
import { codexProgramName, omxProgramName } from '../adapters/program-names.js';
import { hostVisibleRepoRoot } from '../adapters/files.js';
import { agentKinds, type AdapterConfigs, type AdapterLaunchConfig, type AgentKind } from '../adapters/types.js';
import { instanceIconNames, type InstanceIcon } from '../instance-icon.js';
import { isIP } from 'node:net';
import { defaultDavoContext, defaultDavoName } from '../integrations/realtime/settings.js';

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
// version inspection and update commands are one all-or-nothing trusted shell contract
const adapterUpdates = z.object({ current: command, latest: command, run: command }).strict();
// `setup`/`teardown` are operator-trust lifecycle commands (shell-interpreted, like a
// Project's stack commands): `setup` runs in the launched pane before the program and
// aborts the launch on failure; `teardown` runs best-effort after the console stops an
// agent of this kind, in the stopped agent's workspace.
const adapterEntry = z.object({ program: adapterProgram, args: z.array(adapterArgument).max(64).optional(), env: z.record(adapterEnvName, adapterArgument).optional(), setup: command.optional(), teardown: command.optional(), updates: adapterUpdates.optional() }).strict();
// keyed by kind, one strict entry each; an omitted block is observe-only (nothing launches)
const adaptersSchema = z.object({ codex: adapterEntry.optional(), omx: adapterEntry.optional(), claude: adapterEntry.optional(), pi: adapterEntry.optional(), opencode: adapterEntry.optional() }).strict();
// constrain icons to bundled artwork
const instanceIcon = z.enum(instanceIconNames);
const remoteServer = z.object({ url: z.string(), name: serverName.optional(), icon: instanceIcon.optional() }).strict();
const davoName = z.string().trim().min(1).max(80).refine(value => !value.includes('\0'), 'NUL is forbidden');
const davoContext = z.string().trim().max(16_000).refine(value => !value.includes('\0'), 'NUL is forbidden');
const davoSettingsSchema = z.object({ enabled: z.boolean(), name: davoName, context: davoContext }).strict();
// default every remote surface off
const integrationFeatures = z.object({
  enabled: z.boolean().default(false),
  mcp: z.object({ readEnabled: z.boolean().default(true), writeEnabled: z.boolean().default(false), dangerousEnabled: z.boolean().default(false) }).strict().default({}),
  realtime: z.object({ enabled: z.boolean().default(false), name: davoName.default(defaultDavoName), context: davoContext.default(defaultDavoContext), writeToolsEnabled: z.boolean().default(false) }).strict().default({}),
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
  defaultAgent: z.enum(agentKinds).optional(),
  // where a Scratch (home) agent launches. An absolute path; defaults to the launch
  // account home (`$HOME`, or the host account home derived under the Docker bridge).
  // The account home the shell exports stays independent of it (launch/service.ts
  // agentHome), so this only moves the working directory, not HOME.
  scratchDirectory: z.string().min(1).max(4096).startsWith('/', 'scratchDirectory must be an absolute path').refine(value => !value.includes('\0'), 'NUL is forbidden').optional(),
  adapters: adaptersSchema.default({}),
  integrations: integrationFeatures,
  // a repository the console manages; its checkouts are discovered from git, never
  // declared. `path` is any checkout (a bare repository included); `hostPath` maps the
  // Main worktree's container path to the host under Docker; `worktreesDirectory` is
  // where Add creates new checkouts (default `../<basename>-worktrees`, resolved
  // against the Main worktree). Scratch-only first runs omit `projects`.
  projects: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(value => value !== 'agent' && value !== 'scratch', 'project id `agent` and `scratch` are reserved'), label: z.string().max(120).optional(), path: z.string().min(1), hostPath: z.string().startsWith('/').optional(), worktreesDirectory: z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'NUL is forbidden').optional(), port: z.number().int().min(1).max(65535).optional(), hostname: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/).optional(), commands: stackCommands.optional(), newTask: command.optional(), push: pushAction }).strict()).max(100).default([])
}).strict();
export type ConfigInput = z.input<typeof sourceSchema>;
export type RemoteServer = { url: URL };
export type IntegrationConfig = z.output<typeof integrationFeatures>;
export type DavoSettings = z.output<typeof davoSettingsSchema>;
export type ValidatedConfig = { listen: { host: string; port: number }; name: string; icon?: InstanceIcon; publicOrigin: URL; remoteServers: RemoteServer[]; trustedProxyIps: Set<string>; pollIntervalMs: number; defaultAgent?: AgentKind; scratchDirectory?: string; adapters: AdapterConfigs; integrations?: IntegrationConfig; projects: Project[] };
// how validation surfaces non-fatal facts: `warn` collects boot warnings (non-executable
// programs, a crossed OMX/Codex program); `checkExecutables` runs the boot X_OK probe
// and is skipped under the host bridge, where `program` is a host path the container
// cannot stat. Defaults: no-op warnings, probe on unless the host bridge is configured.
export type ValidateConfigOptions = { warn?: (message: string) => void; checkExecutables?: boolean };
// support legacy test fixtures
export const defaultIntegrationConfig: IntegrationConfig = integrationFeatures.parse(undefined);

// parse one exact voice setting update
export function parseDavoSettings(value: unknown): DavoSettings | undefined {
  const parsed = davoSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// the Codex binary container-local or direct out-of-band services spawn: an explicit
// RAC_CODEX_BIN override, else the configured adapters.codex program
export function resolveCodexProgram(config: Pick<ValidatedConfig, 'adapters'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.RAC_CODEX_BIN ?? config.adapters.codex?.program;
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
type ParsedProject = z.output<typeof sourceSchema>['projects'][number];
// where Add creates new Worktrees: an absolute `worktreesDirectory` as given, a relative
// one against the Main worktree (the bare repository's parent when there is none), and
// the default a `<basename>-worktrees` sibling of the Main worktree (ADR 0003).
function resolveWorktreesDirectory(configured: string | undefined, mainWorktree: string | undefined, identity: string): string {
  const relativeBase = mainWorktree ?? dirname(identity);
  if (configured !== undefined) return isAbsolute(configured) ? resolve(configured) : resolve(relativeBase, configured);
  const anchor = mainWorktree ?? identity;
  return resolve(dirname(anchor), `${basename(anchor)}-worktrees`);
}
// resolve one configured Project: canonicalise the checkout, derive its identity from
// the common git directory, resolve the Worktrees directory, and — when the path is
// missing or not a git checkout — load it unavailable with a reason rather than failing
// the whole boot (ADR 0003).
async function resolveProject(raw: ParsedProject): Promise<Project> {
  if (raw.newTask !== undefined) validateNewTask(raw.newTask);
  if ((raw.port === undefined) !== (raw.hostname === undefined)) throw new Error(`project ${raw.id} must define both port and hostname`);
  const label = raw.label ?? raw.id;
  const optional = {
    ...(raw.commands === undefined ? {} : { commands: raw.commands as StackCommands }),
    ...(raw.newTask === undefined ? {} : { newTask: raw.newTask }),
    ...(raw.hostPath === undefined ? {} : { hostPath: resolve(raw.hostPath) }),
    ...(raw.hostname === undefined ? {} : { projectUrl: `https://${raw.hostname}`, projectPort: raw.port })
  };
  const canonical = await realpath(raw.path).catch(() => undefined);
  const identity = canonical === undefined ? undefined : await gitCommonDir(canonical);
  if (canonical === undefined || identity === undefined) {
    const base = canonical ?? resolve(raw.path);
    const reason = canonical === undefined ? `path ${raw.path} was not found` : `path ${raw.path} is not a git repository`;
    return { id: raw.id, label, path: base, identity: base, available: false, unavailableReason: reason, worktreesDirectory: resolveWorktreesDirectory(raw.worktreesDirectory, undefined, base), push: raw.push, ...optional };
  }
  // git lists the Main worktree first; a bare repository has none
  const entries = await listWorktrees(canonical);
  const mainEntry = entries?.find(entry => !entry.bare);
  const mainWorktree = mainEntry === undefined ? undefined : await realpath(mainEntry.path).catch(() => mainEntry.path);
  return { id: raw.id, label, path: canonical, identity, available: true, worktreesDirectory: resolveWorktreesDirectory(raw.worktreesDirectory, mainWorktree, identity), push: raw.push, ...optional };
}
// the console now declares repositories as `projects[]`; a config that still carries the
// retired `worktrees[]` key is refused with a pointer to the migration rather than a bare
// "unrecognized key" from the strict schema.
function refuseLegacyWorktrees(input: unknown): void {
  if (input !== null && typeof input === 'object' && !Array.isArray(input) && 'worktrees' in (input as Record<string, unknown>)) {
    throw new Error('configuration declares the retired `worktrees[]` key; the console now declares `projects[]` (a repository whose Worktrees are discovered from git). The automatic config-and-data migration converts it — see the Projects migration in docs/setup.md');
  }
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
    const config: AdapterLaunchConfig = { program: entry.program, args: entry.args ?? [], env: entry.env ?? {}, launchable: true, ...(entry.setup === undefined ? {} : { setup: entry.setup }), ...(entry.teardown === undefined ? {} : { teardown: entry.teardown }), ...(entry.updates === undefined ? {} : { updates: entry.updates }) };
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
  warnCrossedPrograms(parsed, warn);
  return configs;
}
// OMX was once launched through `adapters.codex` (one kind recognised both). Now that
// OMX is its own kind (ADR 0005), a Codex entry whose program is OMX — or an OMX entry
// whose program is plain Codex — still launches, but is recognised, badged and torn
// down as the wrong kind; say so at boot rather than leaving the mismatch to the UI.
function warnCrossedPrograms(parsed: ParsedAdapters, warn: (message: string) => void): void {
  if (parsed.codex !== undefined && omxProgramName.test(basename(parsed.codex.program))) warn('adapters.codex.program looks like OMX; configure it under adapters.omx so it is recognised, badged and torn down as OMX');
  if (parsed.omx !== undefined && codexProgramName.test(basename(parsed.omx.program))) warn('adapters.omx.program looks like plain Codex; configure it under adapters.codex so it is recognised, badged and torn down as Codex');
}
// validate and canonicalize console configuration
export async function validateConfig(input: unknown, options: ValidateConfigOptions = {}): Promise<ValidatedConfig> {
  refuseLegacyWorktrees(input);
  const parsed = sourceSchema.parse(input);
  const warn = options.warn ?? (() => {});
  // the host bridge cannot stat host program paths from inside the container
  const checkExecutables = options.checkExecutables ?? process.env.RAC_HOST_TMUX_DIR === undefined;
  const adapters = await resolveAdapters(parsed.adapters, checkExecutables, warn);
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
  const projects: Project[] = []; const ids = new Set<string>(); const identities = new Set<string>();
  for (const raw of parsed.projects) {
    if (ids.has(raw.id)) throw new Error('duplicate project id'); ids.add(raw.id);
    const project = await resolveProject(raw);
    // a missing or non-git checkout loads unavailable with a boot warning, never a crash
    if (!project.available) warn(`projects.${project.id}: ${project.unavailableReason}`);
    // two Projects that resolve to the same repository split state between them; refuse it.
    // Only available Projects have a real identity — an unmounted one never collides
    else { if (identities.has(project.identity)) throw new Error('duplicate project identity'); identities.add(project.identity); }
    projects.push(project);
  }
  return { listen: { host: parsed.listen.host, port: parsed.listen.port }, name: parsed.name, ...(parsed.icon === undefined ? {} : { icon: parsed.icon }), publicOrigin, remoteServers, trustedProxyIps: new Set(parsed.proxy.trustedSourceIps), pollIntervalMs: parsed.tmux.pollIntervalMs, ...(parsed.defaultAgent === undefined ? {} : { defaultAgent: parsed.defaultAgent }), ...(parsed.scratchDirectory === undefined ? {} : { scratchDirectory: resolve(parsed.scratchDirectory) }), adapters, integrations: parsed.integrations, projects };
}
