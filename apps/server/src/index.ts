import { readFile } from 'node:fs/promises';
import { validateConfig } from './config/schema.js';
import { buildApp } from './app.js';
const file = process.env.RAC_CONFIG; if (!file) throw new Error('RAC_CONFIG must point to a server-local configuration file');
const config = await validateConfig(JSON.parse(await readFile(file, 'utf8'))); const app = await buildApp(config); await app.listen(config.listen);
