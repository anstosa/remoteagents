#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultLifetimeMs = 4 * 60 * 60_000;
const maximumLifetimeMs = 7 * 24 * 60 * 60_000;

// print usage and stop
const usage = (code = 0) => {
  process.stderr.write('Usage: share-preview.mjs <port> [--ttl 30m|4h|1d] [--config path] [--origin https://host] [--json]\n');
  process.exit(code);
};

// parse one bounded duration
const lifetime = (value) => {
  const matched = /^(\d+)(m|h|d)$/u.exec(value);
  // reject malformed durations
  if (matched === null) return undefined;
  const amount = Number(matched[1]);
  const units = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  const unit = units[matched[2]];
  const duration = amount * unit;
  return Number.isSafeInteger(duration) && duration > 0 && duration <= maximumLifetimeMs ? duration : undefined;
};

// parse the helper command line
const argumentsFrom = (values) => {
  let port;
  let ttl = defaultLifetimeMs;
  let config;
  let origin;
  let json = false;
  // consume every positional and named option
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    // print help immediately
    if (value === '--help' || value === '-h') usage();
    // select machine-readable output
    if (value === '--json') { json = true; continue; }
    // read the next named value
    if (value === '--ttl' || value === '--config' || value === '--origin') {
      const next = values[index + 1];
      // reject missing option values
      if (next === undefined) usage(2);
      index += 1;
      // parse each supported option
      if (value === '--ttl') {
        const parsed = lifetime(next);
        // reject unsafe lifetimes
        if (parsed === undefined) usage(2);
        ttl = parsed;
      } else if (value === '--config') config = next;
      else origin = next;
      continue;
    }
    // accept one positional port
    if (port === undefined && /^\d+$/u.test(value)) { port = Number(value); continue; }
    usage(2);
  }
  // require one unprivileged port
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) usage(2);
  return { port, ttl, config, origin, json };
};

// require one live loopback listener
const listenerAvailable = (port) => new Promise((resolveListener) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  let settled = false;
  // finish only once
  const finish = (available) => {
    // ignore repeated socket events
    if (settled) return;
    settled = true;
    socket.destroy();
    resolveListener(available);
  };
  socket.setTimeout(1_500, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

// normalize one browser-accessible HTTP origin
const canonicalOrigin = (value) => {
  const parsed = new URL(value);
  // reject origins the preview route cannot serve
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('The RAC public origin must use HTTP or HTTPS.');
  return parsed.origin;
};

// read one canonical public origin
const publicOrigin = async (options) => {
  const direct = options.origin ?? process.env.RAC_TEMP_PREVIEW_ORIGIN;
  // prefer an explicit origin
  if (direct !== undefined) return canonicalOrigin(direct);
  const candidates = [options.config, process.env.RAC_CONFIG, join(repository, 'config', 'remote-agent-console.docker.json'), join(process.env.HOME ?? '', 'remote-agent-console.json')].filter(Boolean);
  // use the first readable RAC config
  for (const candidate of candidates) {
    let parsed;
    // skip unavailable configuration paths
    try { parsed = JSON.parse(await readFile(candidate, 'utf8')); }
    catch { continue; }
    // accept one canonical configured origin
    if (typeof parsed.publicOrigin === 'string') return canonicalOrigin(parsed.publicOrigin);
  }
  throw new Error('No RAC publicOrigin found; pass --config or --origin.');
};

// persist one collision-resistant registration
const register = async (directory, registration) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // retry the negligible token collision case
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = randomBytes(24).toString('base64url');
    const file = join(directory, `${token}.json`);
    // reserve a new token without replacing another preview
    try {
      await writeFile(file, JSON.stringify(registration), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return token;
    } catch (error) {
      // retry collisions only
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('Could not allocate a temporary preview token.');
};

// run the registration workflow
const main = async () => {
  const options = argumentsFrom(process.argv.slice(2));
  // refuse dead or non-loopback services
  if (!await listenerAvailable(options.port)) throw new Error(`Nothing is listening on 127.0.0.1:${options.port}.`);
  const origin = await publicOrigin(options);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + options.ttl);
  const registration = { version: 1, port: options.port, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() };
  const directory = process.env.RAC_TEMP_PREVIEWS_DIR ?? join(repository, '.data', 'temp-previews');
  const token = await register(directory, registration);
  const result = { url: `${origin}/preview/${token}/`, token, port: options.port, expiresAt: registration.expiresAt };
  // print the selected output format
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`Temporary preview: ${result.url}\nExpires: ${result.expiresAt}\n`);
};

// surface one actionable helper failure
main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
