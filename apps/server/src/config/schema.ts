import { access, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { constants } from 'node:fs';
import { z } from 'zod';
import type { LaunchTemplate, Worktree } from '../domain/models.js';

const loopback = new Set(['127.0.0.1', '::1']);
const arg = z.string().max(4096).refine((v) => !v.includes('\0'), 'NUL is forbidden');
const command = z.string().min(1).max(32_000).refine((v) => !v.includes('\0'), 'NUL is forbidden');
const launchSchema = z.object({ program: z.string().max(4096), args: z.array(arg).max(64) }).strict();
const sourceSchema = z.object({
  listen: z.object({ host: z.string(), port: z.number().int().min(1).max(65535) }).strict().default({ host: '127.0.0.1', port: 8787 }),
  publicOrigin: z.string(), proxy: z.object({ trustedSourceIps: z.array(z.string()).default(['127.0.0.1', '::1']) }).strict().default({}),
  tmux: z.object({ pollIntervalMs: z.number().int().min(250).max(10000).default(500) }).strict().default({}),
  launch: launchSchema.optional(),
  worktrees: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), label: z.string().max(120).optional(), path: z.string().min(1), hostPath: z.string().startsWith('/').optional(), port: z.number().int().min(1).max(65535).optional(), hostname: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/).optional(), command: command.optional(), launch: launchSchema.optional() }).strict()).min(1).max(100)
}).strict();
export type ConfigInput = z.input<typeof sourceSchema>;
export type ValidatedConfig = { listen: { host: '127.0.0.1'|'::1'; port: number }; publicOrigin: URL; trustedProxyIps: Set<string>; pollIntervalMs: number; worktrees: Worktree[] };

function canonicalOrigin(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('publicOrigin must be an absolute HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('publicOrigin must be canonical HTTPS origin only');
  return url;
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
export async function validateConfig(input: unknown): Promise<ValidatedConfig> {
  const parsed = sourceSchema.parse(input);
  if (!loopback.has(parsed.listen.host)) throw new Error('listener must bind to loopback');
  if (parsed.proxy.trustedSourceIps.some((ip) => !loopback.has(ip))) throw new Error('only loopback proxy sources are permitted');
  const publicOrigin = canonicalOrigin(parsed.publicOrigin); const worktrees: Worktree[] = []; const ids = new Set<string>(); const identities = new Set<string>();
  for (const raw of parsed.worktrees) {
    if (ids.has(raw.id)) throw new Error('duplicate worktree id'); ids.add(raw.id);
    const path = await realpath(raw.path); const info = await stat(path); if (!info.isDirectory()) throw new Error(`worktree ${raw.id} is not a directory`);
    if (raw.command !== undefined && raw.launch !== undefined) throw new Error(`worktree ${raw.id} cannot define both command and launch`);
    const launch = raw.command === undefined ? raw.launch ?? parsed.launch : undefined;
    if (raw.command === undefined) { if (!launch) throw new Error(`worktree ${raw.id} must define command or launch`); validateTemplate(launch); await access(launch.program, constants.X_OK); }
    const identity = await gitRoot(path); if (identities.has(identity)) throw new Error('duplicate worktree identity'); identities.add(identity);
    if ((raw.port === undefined) !== (raw.hostname === undefined)) throw new Error(`worktree ${raw.id} must define both port and hostname`);
    const projectUrl = raw.hostname === undefined ? undefined : `https://${raw.hostname}`;
    worktrees.push({ id: raw.id, label: raw.label ?? raw.id, path, identity, hostPath: raw.hostPath === undefined ? undefined : resolve(raw.hostPath), available: true, command: raw.command, launch, projectUrl });
  }
  return { listen: { host: parsed.listen.host as '127.0.0.1'|'::1', port: parsed.listen.port }, publicOrigin, trustedProxyIps: new Set(parsed.proxy.trustedSourceIps), pollIntervalMs: parsed.tmux.pollIntervalMs, worktrees };
}
export function expandLaunch(template: LaunchTemplate, worktree: Worktree): string[] { return template.args.map((arg) => arg.replaceAll('{worktreePath}', worktree.identity).replaceAll('{worktreeId}', worktree.id)); }
