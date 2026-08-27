import { access, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { constants } from 'node:fs';
import { z } from 'zod';
import type { LaunchTemplate, StackCommands, Worktree } from '../domain/models.js';
import { instanceIconNames, type InstanceIcon } from '../instance-icon.js';
import { isIP } from 'node:net';

const loopback = new Set(['127.0.0.1', '::1']);
// wildcard binds expose every interface; require an explicit address instead
const wildcard = new Set(['0.0.0.0', '::']);
const arg = z.string().max(4096).refine((v) => !v.includes('\0'), 'NUL is forbidden');
const command = z.string().min(1).max(32_000).refine((v) => !v.includes('\0'), 'NUL is forbidden');
const stackCommands = z.object({ start: command.optional(), stop: command.optional(), build: command.optional(), restart: command.optional(), migrate: command.optional(), status: command.optional() }).strict();
const pushAction = z.object({ label: z.string().trim().min(1).max(80), prompt: command }).strict().default({ label: 'Commit/Push', prompt: 'review, commit, and push' });
const launchSchema = z.object({ program: z.string().max(4096), args: z.array(arg).max(64) }).strict();
const serverName = z.string().trim().min(1).max(80).refine(value => !value.includes('\0'), 'NUL is forbidden');
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
  integrations: integrationFeatures,
  launch: launchSchema.optional(),
  // allow a scratch-only first run
  worktrees: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), label: z.string().max(120).optional(), path: z.string().min(1), hostPath: z.string().startsWith('/').optional(), saveKey: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(), pinned: z.boolean().default(false), port: z.number().int().min(1).max(65535).optional(), hostname: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/).optional(), command: command.optional(), resumeCommand: command.optional(), launch: launchSchema.optional(), commands: stackCommands.optional(), newTask: command.optional(), push: pushAction }).strict()).max(100).default([])
}).strict();
export type ConfigInput = z.input<typeof sourceSchema>;
export type RemoteServer = { url: URL };
export type IntegrationConfig = z.output<typeof integrationFeatures>;
export type ValidatedConfig = { listen: { host: string; port: number }; name: string; icon?: InstanceIcon; publicOrigin: URL; remoteServers: RemoteServer[]; trustedProxyIps: Set<string>; pollIntervalMs: number; newAgentCommand: string; integrations?: IntegrationConfig; worktrees: Worktree[] };
// support legacy test fixtures
export const defaultIntegrationConfig: IntegrationConfig = integrationFeatures.parse(undefined);

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
function validateTemplate(template: LaunchTemplate): void {
  if (!template.program.startsWith('/')) throw new Error('launch program must be absolute');
  for (const value of template.args) if (/\{(?!worktreePath\}|worktreeId\})/.test(value)) throw new Error('unknown launch placeholder');
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
// validate and canonicalize console configuration
export async function validateConfig(input: unknown): Promise<ValidatedConfig> {
  const parsed = sourceSchema.parse(input);
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
    if (raw.command !== undefined && raw.launch !== undefined) throw new Error(`worktree ${raw.id} cannot define both command and launch`);
    if (raw.newTask !== undefined) validateNewTask(raw.newTask);
    if (raw.resumeCommand !== undefined) validateResumeCommand(raw.resumeCommand);
    const launch = raw.command === undefined ? raw.launch ?? parsed.launch : undefined;
    if (raw.command === undefined) { if (!launch) throw new Error(`worktree ${raw.id} must define command or launch`); validateTemplate(launch); await access(launch.program, constants.X_OK); }
    const identity = await gitRoot(path); if (identities.has(identity)) throw new Error('duplicate worktree identity'); identities.add(identity);
    if ((raw.port === undefined) !== (raw.hostname === undefined)) throw new Error(`worktree ${raw.id} must define both port and hostname`);
    const projectUrl = raw.hostname === undefined ? undefined : `https://${raw.hostname}`;
    worktrees.push({ id: raw.id, label: raw.label ?? raw.id, path, identity, hostPath: raw.hostPath === undefined ? undefined : resolve(raw.hostPath), saveKey: raw.saveKey ?? raw.id, available: true, pinned: raw.pinned, command: raw.command, ...(raw.resumeCommand === undefined ? {} : { resumeCommand: raw.resumeCommand }), launch, projectUrl, projectPort: raw.port, push: raw.push, ...(raw.commands === undefined ? {} : { commands: raw.commands as StackCommands }), ...(raw.newTask === undefined ? {} : { newTask: raw.newTask }) });
  }
  return { listen: { host: parsed.listen.host, port: parsed.listen.port }, name: parsed.name, ...(parsed.icon === undefined ? {} : { icon: parsed.icon }), publicOrigin, remoteServers, trustedProxyIps: new Set(parsed.proxy.trustedSourceIps), pollIntervalMs: parsed.tmux.pollIntervalMs, newAgentCommand: parsed.newAgentCommand, integrations: parsed.integrations, worktrees };
}
export function expandLaunch(template: LaunchTemplate, worktree: Worktree): string[] { return template.args.map((arg) => arg.replaceAll('{worktreePath}', worktree.identity).replaceAll('{worktreeId}', worktree.id)); }
