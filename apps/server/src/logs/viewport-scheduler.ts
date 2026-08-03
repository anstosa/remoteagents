export type ViewportRequest = { cols: number; rows: number; history: number; onFailure?: () => void };
export type PaneViewport = { cols: number; rows: number };

export class LatestViewportScheduler {
  private version = 0;
  private queue = Promise.resolve();

  constructor(
    private readonly resize: (cols: number, rows: number) => Promise<boolean>,
    private readonly show: (history: number) => void
  ) {}

  schedule(request: ViewportRequest): Promise<void> {
    const version = ++this.version;
    this.queue = this.queue.then(async () => {
      if (version !== this.version) return;
      const resized = await this.resize(request.cols, request.rows).catch(() => false);
      if (version !== this.version) return;
      if (!resized && request.onFailure !== undefined) return request.onFailure();
      this.show(request.history);
    });
    return this.queue;
  }
}

type PaneViewportEntry = {
  owner: symbol;
  queue: Promise<void>;
  read: () => Promise<PaneViewport | undefined>;
  apply: (cols: number, rows: number) => Promise<boolean>;
  restore?: PaneViewport;
};

export type PaneViewportLease = {
  resize: (cols: number, rows: number) => Promise<boolean>;
  release: () => Promise<void>;
};

export class PaneViewportCoordinator {
  private readonly entries = new Map<string, PaneViewportEntry>();

  acquire(key: string, read: () => Promise<PaneViewport | undefined>, apply: (cols: number, rows: number) => Promise<boolean>): PaneViewportLease {
    const owner = Symbol(key);
    const existing = this.entries.get(key);
    const entry = existing ?? { owner, queue: Promise.resolve(), read, apply };
    entry.owner = owner;
    entry.read = read;
    entry.apply = apply;
    this.entries.set(key, entry);
    return {
      resize: (cols, rows) => this.resize(key, entry, owner, cols, rows),
      release: () => this.release(key, entry, owner)
    };
  }

  async restoreAll(): Promise<void> {
    await Promise.all([...this.entries.entries()].map(([key, entry]) => this.release(key, entry, entry.owner)));
  }

  private enqueue<T>(entry: PaneViewportEntry, operation: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(operation, operation);
    entry.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private resize(key: string, entry: PaneViewportEntry, owner: symbol, cols: number, rows: number): Promise<boolean> {
    return this.enqueue(entry, async () => {
      if (this.entries.get(key) !== entry || entry.owner !== owner) return false;
      const current = entry.restore ?? await entry.read().catch(() => undefined);
      if (current === undefined || entry.owner !== owner) return false;
      entry.restore = { cols: Math.max(current.cols, cols), rows: Math.max(current.rows, rows) };
      return await entry.apply(cols, rows).catch(() => false);
    });
  }

  private release(key: string, entry: PaneViewportEntry, owner: symbol): Promise<void> {
    if (this.entries.get(key) !== entry || entry.owner !== owner) return Promise.resolve();
    const releasing = Symbol(key);
    entry.owner = releasing;
    return this.enqueue(entry, async () => {
      if (this.entries.get(key) !== entry || entry.owner !== releasing) return;
      if (entry.restore !== undefined) await entry.apply(entry.restore.cols, entry.restore.rows).catch(() => false);
      if (this.entries.get(key) === entry && entry.owner === releasing) this.entries.delete(key);
    });
  }
}
