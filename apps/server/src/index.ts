import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { validateConfig } from './config/schema.js';
import { buildApp } from './app.js';
import { DiscoveryService } from './discovery/service.js';
import { TmuxAdapter } from './tmux/adapter.js';
import { PushService } from './push-service.js';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const file = process.env.RAC_CONFIG; if (!file) throw new Error('RAC_CONFIG must point to a server-local configuration file');
const config = await validateConfig(JSON.parse(await readFile(file, 'utf8'))); const tmux = new TmuxAdapter(); const discovery = new DiscoveryService(undefined, tmux); const push = new PushService(); const app = await buildApp(config, { tmux, discovery, push }); await app.listen(config.listen);
const states = new Map<string, boolean>();
setInterval(() => void discovery.dashboard(config.worktrees).then(async ({ agents }) => { for (const agent of agents) { const working = /^[\u2800-\u28ff]/u.test(agent.title); if (states.get(agent.id) && !working) await push.notify('Agent finished', `${agent.worktreeLabel ?? agent.title} is ready for another prompt.`, `agent-finished-${agent.id}`); states.set(agent.id, working); } }).catch(() => {}), Math.max(1_000, config.pollIntervalMs));
