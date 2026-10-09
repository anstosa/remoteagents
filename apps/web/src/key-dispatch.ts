import { isTableBinding, keyActions, lookupKeyBinding, type KeyBinding, type ResolvedKeyTables } from '../../server/src/config/keys.js';

// how long a table switch waits for its key, and how long a repeatable binding stays live
export const keyTableTimeoutMs = 10_000;
export const keyRepeatMs = 500;

// What is waiting for the next key: a table entered by `chord` (live for repeatable bindings only
// while `repeat`), or a y/n question. Undefined while only `root` is active.
export type KeyDispatchState =
  | { table: string; chord: string; repeat: boolean; expiresAt: number; confirm?: undefined }
  | { confirm: string; onYes: () => void; expiresAt: number; table?: undefined };

// `run` returns false when its action does not apply right now, so the key passes through.
type KeyDispatcherOptions<Context> = {
  tables: () => ResolvedKeyTables;
  run: (binding: KeyBinding, context: { table: string; chord: string; event: Context }) => boolean;
};

// The tmux-style state machine behind the one keydown listener. `handle` takes the chord a key
// makes (undefined for a bare modifier) and says whether the listener should swallow the key.
export function createKeyDispatcher<Context>({ tables, run }: KeyDispatcherOptions<Context>) {
  let state: KeyDispatchState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: KeyDispatchState | undefined) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = next === undefined ? undefined : setTimeout(() => set(undefined), next.expiresAt - Date.now());
    state = next;
    listeners.forEach(listener => listener());
  };
  const repeatable = (binding: KeyBinding | undefined) => typeof binding === 'string' && keyActions[binding]?.repeat === true;

  const handleRoot = (chord: string, event: Context): 'pass' | 'handled' => {
    const binding = lookupKeyBinding(tables(), 'root', chord);
    if (binding === undefined) return 'pass';
    if (isTableBinding(binding)) {
      set({ table: binding.table, chord, repeat: false, expiresAt: Date.now() + keyTableTimeoutMs });
      return 'handled';
    }
    return run(binding, { table: 'root', chord, event }) ? 'handled' : 'pass';
  };

  const handle = (chord: string | undefined, event: Context): 'pass' | 'handled' => {
    // a bare modifier is on its way to a chord, so it neither matches nor ends a table
    if (chord === undefined) return 'pass';
    const current = state;
    if (current === undefined) return handleRoot(chord, event);
    if (current.confirm !== undefined) {
      set(undefined);
      if (chord === 'y') current.onYes();
      return 'handled';
    }
    const binding = lookupKeyBinding(tables(), current.table, chord);
    if (current.repeat) {
      // only another repeatable key continues a repeat; anything else is an ordinary root key
      if (!repeatable(binding)) { set(undefined); return handleRoot(chord, event); }
      set({ ...current, expiresAt: Date.now() + keyRepeatMs });
      run(binding!, { table: current.table, chord, event });
      return 'handled';
    }
    if (binding === undefined) {
      set(undefined);
      // the key that entered the table, pressed again, goes to the focused control (send-prefix)
      return chord === current.chord ? 'pass' : 'handled';
    }
    if (isTableBinding(binding)) {
      set({ table: binding.table, chord, repeat: false, expiresAt: Date.now() + keyTableTimeoutMs });
      return 'handled';
    }
    set(repeatable(binding) ? { table: current.table, chord: current.chord, repeat: true, expiresAt: Date.now() + keyRepeatMs } : undefined);
    run(binding, { table: current.table, chord, event });
    return 'handled';
  };

  return {
    handle,
    state: () => state,
    // ask a y/n question; the next key answers it, and only `y` runs `onYes`
    confirm: (message: string, onYes: () => void) => set({ confirm: message, onYes, expiresAt: Date.now() + keyTableTimeoutMs }),
    reset: () => { if (state !== undefined) set(undefined); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
}
