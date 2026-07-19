import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { validateConfig } from './config/schema.js';
import { buildApp } from './app.js';

const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const file = process.env.RAC_CONFIG; if (!file) throw new Error('RAC_CONFIG must point to a server-local configuration file');
const config = await validateConfig(JSON.parse(await readFile(file, 'utf8'))); const app = await buildApp(config); await app.listen(config.listen);
