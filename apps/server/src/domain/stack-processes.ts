import type { StackCommands } from './models.js';

// A Stack process as the console runs it: the config's string form is shorthand for
// `{ command }`, so every process has a (possibly empty) `dependsOn`.
export type StackProcess = { name: string; command: string; dependsOn: string[] };

// a Worktree's configured Stack processes in config order, which is their display order;
// empty for a daemon-style or one-shot-only stack
export const declaredProcesses = (commands: StackCommands | undefined): StackProcess[] => Object.entries(commands?.processes ?? {}).map(([name, value]) => typeof value === 'string'
  ? { name, command: value, dependsOn: [] }
  : { name, command: value.command, dependsOn: value.dependsOn ?? [] });

// The order a whole-stack Start runs in: every process after the processes it depends on,
// ties broken by config order, so a config with no `dependsOn` starts in the order written.
// A Stop and a Remove run it in reverse, so it always holds every process: validation has
// refused unknown names and cycles, but a process caught in one anyway still comes last, in
// config order, rather than being left running by a Stop that reports success.
export const startOrder = (processes: StackProcess[]): StackProcess[] => {
  const ordered: StackProcess[] = [];
  const placed = new Set<string>();
  const declared = new Set(processes.map(entry => entry.name));
  for (;;) {
    const next = processes.find(entry => !placed.has(entry.name) && entry.dependsOn.every(name => placed.has(name) || !declared.has(name)));
    if (next === undefined) return [...ordered, ...processes.filter(entry => !placed.has(entry.name))];
    ordered.push(next);
    placed.add(next.name);
  }
};

// every process `name` transitively depends on, in start order: what Starting that one
// process starts first, each one not already running
export const dependenciesOf = (processes: StackProcess[], name: string): StackProcess[] => {
  const byName = new Map(processes.map(entry => [entry.name, entry]));
  const needed = new Set<string>();
  const visit = (current: string) => {
    for (const dependency of byName.get(current)?.dependsOn ?? []) {
      if (needed.has(dependency) || dependency === name) continue;
      needed.add(dependency);
      visit(dependency);
    }
  };
  visit(name);
  return startOrder(processes).filter(entry => needed.has(entry.name));
};

// the first dependency cycle among the processes, as the names around it with the first
// repeated at the end (`web → api → sync → web`), searched in config order; undefined when
// there is none. Names not declared are skipped: validation reports those on their own.
export const dependencyCycle = (processes: StackProcess[]): string[] | undefined => {
  const byName = new Map(processes.map(entry => [entry.name, entry]));
  const finished = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): string[] | undefined => {
    const repeat = path.indexOf(name);
    if (repeat >= 0) return [...path.slice(repeat), name];
    const entry = byName.get(name);
    if (entry === undefined || finished.has(name)) return undefined;
    path.push(name);
    for (const dependency of entry.dependsOn) {
      const cycle = visit(dependency);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    finished.add(name);
    return undefined;
  };
  for (const entry of processes) {
    const cycle = visit(entry.name);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
};
