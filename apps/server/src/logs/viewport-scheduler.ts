export type ViewportRequest = { cols: number; rows: number; history: number; onFailure?: () => void };
export type PaneViewport = { cols: number; rows: number };
// clientLimit: the largest pane size every tmux client attached to the pane's
// session can display; absent when nothing is attached
export type PaneGeometry = PaneViewport & { clientLimit?: PaneViewport };

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
  read: () => Promise<PaneGeometry | undefined>;
  apply: (cols: number, rows: number) => Promise<boolean>;
  unpin: () => Promise<boolean>;
  restore?: PaneViewport;
};

export type PaneViewportLease = {
  resize: (cols: number, rows: number) => Promise<boolean>;
  ensure: (cols: number, rows: number) => Promise<{ ok: boolean; resized: boolean }>;
  release: () => Promise<void>;
};

// Never ask for more than an attached terminal can show, so a browser and a
// terminal sharing a pane get tmux's own smallest-client behaviour.
const within = (requested: PaneViewport, limit: PaneViewport | undefined): PaneViewport =>
  limit === undefined ? requested : { cols: Math.min(requested.cols, limit.cols), rows: Math.min(requested.rows, limit.rows) };

export class PaneViewportCoordinator {
  private readonly entries = new Map<string, PaneViewportEntry>();

  acquire(
    key: string,
    read: () => Promise<PaneGeometry | undefined>,
    apply: (cols: number, rows: number) => Promise<boolean>,
    unpin: () => Promise<boolean>
  ): PaneViewportLease {
    const owner = Symbol(key);
    const existing = this.entries.get(key);
    const entry = existing ?? { owner, queue: Promise.resolve(), read, apply, unpin };
    entry.owner = owner;
    entry.read = read;
    entry.apply = apply;
    entry.unpin = unpin;
    this.entries.set(key, entry);
    return {
      resize: (cols, rows) => this.resize(key, entry, owner, cols, rows),
      ensure: (cols, rows) => this.ensure(key, entry, owner, cols, rows),
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
      const geometry = await entry.read().catch(() => undefined);
      if (geometry === undefined || entry.owner !== owner) return false;
      const baseline = entry.restore ?? geometry;
      entry.restore = { cols: Math.max(baseline.cols, cols), rows: Math.max(baseline.rows, rows) };
      const target = within({ cols, rows }, geometry.clientLimit);
      return await entry.apply(target.cols, target.rows).catch(() => false);
    });
  }

  private ensure(key: string, entry: PaneViewportEntry, owner: symbol, cols: number, rows: number): Promise<{ ok: boolean; resized: boolean }> {
    return this.enqueue(entry, async () => {
      if (this.entries.get(key) !== entry || entry.owner !== owner) return { ok: false, resized: false };
      const geometry = await entry.read().catch(() => undefined);
      if (geometry === undefined || entry.owner !== owner) return { ok: false, resized: false };
      // the limit is re-read every tick: a terminal attaching, detaching or
      // resizing moves the target just as an external layout change does
      const target = within({ cols, rows }, geometry.clientLimit);
      if (geometry.cols === target.cols && geometry.rows === target.rows) return { ok: true, resized: false };
      const resized = await entry.apply(target.cols, target.rows).catch(() => false);
      return { ok: resized, resized };
    });
  }

  private release(key: string, entry: PaneViewportEntry, owner: symbol): Promise<void> {
    if (this.entries.get(key) !== entry || entry.owner !== owner) return Promise.resolve();
    const releasing = Symbol(key);
    entry.owner = releasing;
    return this.enqueue(entry, async () => {
      if (this.entries.get(key) !== entry || entry.owner !== releasing) return;
      if (entry.restore !== undefined) {
        const geometry = await entry.read().catch(() => undefined);
        const target = within(entry.restore, geometry?.clientLimit);
        await entry.apply(target.cols, target.rows).catch(() => false);
        // leave the window to tmux so a terminal attached later is sized normally
        try { await entry.unpin(); } catch { /* best effort, like the restore */ }
      }
      if (this.entries.get(key) === entry && entry.owner === releasing) this.entries.delete(key);
    });
  }
}
