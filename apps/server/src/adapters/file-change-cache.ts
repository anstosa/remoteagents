import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

type Entry<T> = { version: string; value: T; bytes: number };
type Limits<T> = { maxEntries?: number; maxBytes?: number; sizeOf?: (value: T) => number };

// follow file targets and detect replacements, appends and same-size rewrites
async function version(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

// retain parsed results only while a fresh filesystem observation still matches
export class FileChangeCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly pending = new Map<string, Promise<T>>();
  private bytes = 0;

  // bound retained results independently of each reader's input window
  constructor(private readonly load: (path: string) => Promise<T>, private readonly limits: Limits<T> = {}) {}

  // share concurrent metadata checks and reads for the same absolute path
  get(path: string): Promise<T> {
    const key = resolve(path);
    const running = this.pending.get(key);
    // callers observe one stable read rather than racing cache publication
    if (running !== undefined) return running;
    const read = this.read(key).finally(() => { this.pending.delete(key); });
    this.pending.set(key, read);
    return read;
  }

  // remove both the entry and its retained-byte charge
  private remove(path: string): void {
    const entry = this.entries.get(path);
    // absent paths have no charge to release
    if (entry === undefined) return;
    this.bytes -= entry.bytes;
    this.entries.delete(path);
  }

  // never publish unstable reads or retain filesystem failures
  private async read(path: string): Promise<T> {
    try {
      const before = await version(path);
      const cached = this.entries.get(path);
      // refresh least-recently-used order without reading the contents
      if (cached?.version === before) {
        this.entries.delete(path);
        this.entries.set(path, cached);
        return cached.value;
      }
      this.remove(path);
      const value = await this.load(path);
      // concurrent appends or replacements retry on the next caller
      if (await version(path) !== before) throw new Error('file changed while reading');
      const bytes = this.limits.sizeOf?.(value) ?? Buffer.byteLength(JSON.stringify(value ?? null));
      const maxBytes = this.limits.maxBytes ?? 8 * 1024 * 1024;
      const maxEntries = this.limits.maxEntries ?? 256;
      // oversized results remain usable without occupying the cache
      if (bytes <= maxBytes && maxEntries > 0) {
        this.entries.set(path, { version: before, value, bytes });
        this.bytes += bytes;
        // evict oldest results until both retention bounds hold
        while (this.entries.size > maxEntries || this.bytes > maxBytes) this.remove(this.entries.keys().next().value!);
      }
      return value;
    } catch (error) {
      this.remove(path);
      throw error;
    }
  }
}
