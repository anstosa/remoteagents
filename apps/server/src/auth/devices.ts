import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type StoredDevices = Record<string, string>;

const maxDevices = 500;
const validSessionId = (value: string) => /^[A-Za-z0-9_-]{32,64}$/u.test(value);
const normalizeName = (value: string) => value.trim();
const validName = (value: string) => {
  const name = normalizeName(value);
  return name.length > 0 && name.length <= 64 && !/[\p{Cc}\p{Cf}]/u.test(name);
};

export class DeviceService {
  private mutation = Promise.resolve();

  constructor(private readonly file = process.env.RAC_DEVICE_NAMES_FILE ?? '.data/device-names.json') {}

  async get(sessionId: string): Promise<string | undefined> {
    if (!validSessionId(sessionId)) return undefined;
    await this.mutation;
    return (await this.read())[sessionId];
  }

  async set(sessionId: string, value: string): Promise<string | undefined> {
    if (!validSessionId(sessionId) || !validName(value)) return undefined;
    const name = normalizeName(value);
    return await this.mutate(stored => {
      if (stored[sessionId] === undefined && Object.keys(stored).length >= maxDevices) delete stored[Object.keys(stored)[0]!];
      stored[sessionId] = name;
      return name;
    });
  }

  private async mutate<T>(change: (stored: StoredDevices) => T): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      const result = change(stored);
      await this.write(stored);
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  private async read(): Promise<StoredDevices> {
    const raw = await readFile(this.file, 'utf8').then(value => JSON.parse(value) as unknown).catch(() => ({}));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).flatMap(([sessionId, name]) => (
      validSessionId(sessionId) && typeof name === 'string' && validName(name) ? [[sessionId, normalizeName(name)]] : []
    )).slice(-maxDevices));
  }

  private async write(value: StoredDevices): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
