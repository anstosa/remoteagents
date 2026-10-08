import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectOpen } from '../src/project-open.js';
import { StackPanel } from '../src/stack-panel.js';
import { isStackProcessOutput, type ProcessUse, type StackAction, type StackProcessOutput, type StackProcessState, type StackSelection } from '../src/stack-operations.js';

// What the Stack panel and its menu asked for, for a spec to read back: the actions on this
// Worktree's processes and on the stack, the used processes' Starts and Stops, the Worktrees
// opened, the Terminals opened, every output read and clear (by Worktree and process) and whether it closed.
// `failNextUse` makes the next used process's action fail with that reason, as a busy Worktree would.
type Record_ = { actions?: string[]; useActions?: string[]; openedWorktrees?: string[]; openedTerminals?: { paneId: string; name: string }[]; outputReads?: string[]; outputClears?: string[]; panelClosed?: boolean; failNextUse?: string };
const record = () => window as unknown as Record_;
const push = (key: 'actions'|'useActions'|'openedWorktrees'|'outputReads'|'outputClears', value: string) => { record()[key] = [...record()[key] ?? [], value]; };

// The Worktree "Obsidian / testing": `sync` runs, `api` runs and needs `sync`, `web` needs `api`
// and has exited, `docs` is stopped and stands alone. `api` uses Static's `static` (stopped) and a
// `preview` the console could not place. Each output read grows by a line, so polling shows; a
// running process here gives its pane, `%17`. Every action is held briefly, then lands. A clear
// drops everything read so far, as an emptied pane would.
const Workbench = () => {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<StackSelection>();
  const [processes, setProcesses] = useState<StackProcessState[]>([
    { name: 'sync', state: 'running' },
    { name: 'api', state: 'running', dependsOn: ['sync'] },
    { name: 'web', state: 'exited', exitCode: 1, dependsOn: ['api'] },
    { name: 'docs', state: 'stopped' }
  ]);
  const [staticState, setStaticState] = useState<'running'|'stopped'>('stopped');
  const [reads] = useState(() => new Map<string, number>());
  const [cleared] = useState(() => new Map<string, number>());
  const uses: ProcessUse[] = [{ worktreeId: 'site:/code/static', label: 'Static Site / Main', process: 'static', state: staticState }, { label: '/code/elsewhere', process: 'preview' }];
  const shown = processes.map(process => process.name === 'api' ? { ...process, uses } : process);
  const stack = { actions: ['start', 'stop', 'restart'] as StackAction[], processes: shown };
  const hold = () => new Promise(resolve => window.setTimeout(resolve, 200));
  const handlers = {
    onStackAction: async (action: StackAction) => { push('actions', `stack ${action}`); await hold(); },
    onProcessAction: async (name: string, action: StackAction) => {
      push('actions', `${name} ${action}`);
      await hold();
      setProcesses(current => current.map(process => process.name === name ? { ...process, state: action === 'stop' ? 'stopped' : 'running', exitCode: undefined } : process));
    },
    onUseAction: async (worktreeId: string, process: string, action: 'start'|'stop'|'restart') => {
      push('useActions', `${action} ${worktreeId} ${process}`);
      await hold();
      const failure = record().failNextUse;
      if (failure !== undefined) { delete record().failNextUse; throw new Error(failure); }
      setStaticState(action === 'stop' ? 'stopped' : 'running');
    }
  };
  const readOutput = async (worktreeId: string, name: string): Promise<StackProcessOutput> => {
    push('outputReads', `${worktreeId} ${name}`);
    const key = `${worktreeId} ${name}`;
    const count = (reads.get(key) ?? 0) + 1;
    reads.set(key, count);
    const own = worktreeId === 'app:/code/app';
    const state = own ? shown.find(process => process.name === name)?.state ?? 'stopped' : staticState;
    const since = cleared.get(key);
    const lines = [`${key} ready`, ...Array.from({ length: 80 }, (_, index) => `compiled module ${index + 1}`), ...Array.from({ length: count }, (_, index) => `request ${index + 1}`)];
    const output = (since === undefined ? lines : lines.slice(81 + since)).join('\n');
    const payload: unknown = { name, state, ...(own && state === 'running' ? { paneId: '%17' } : {}), output };
    if (!isStackProcessOutput(payload)) throw new Error('invalid process output');
    return payload;
  };
  const clearOutput = async (worktreeId: string, name: string) => {
    push('outputClears', `${worktreeId} ${name}`);
    await hold();
    cleared.set(`${worktreeId} ${name}`, reads.get(`${worktreeId} ${name}`) ?? 0);
  };
  const openWorktree = (worktreeId: string) => push('openedWorktrees', worktreeId);
  return createElement('div', { className: 'workbench' },
    createElement('div', { className: 'workspace-toolbar-actions' }, createElement(ProjectOpen, {
      worktreeId: 'app:/code/app', title: 'testing', stack, ...handlers, onOpenWorktree: openWorktree,
      onOpenStackPanel: (next: StackSelection) => { setSelection(next); setOpen(true); }
    })),
    open && createElement('div', { className: 'workbench-panel' }, createElement(StackPanel, {
      worktreeId: 'app:/code/app', title: 'Obsidian / testing', stack, selection, onSelect: setSelection,
      onClose: () => { record().panelClosed = true; setOpen(false); },
      handlers, onOpenWorktree: openWorktree, readOutput, clearOutput,
      onOpenTerminal: (paneId: string, name: string) => { record().openedTerminals = [...record().openedTerminals ?? [], { paneId, name }]; }
    }))
  );
};

export const renderStackWorkbench = (root: HTMLElement) => {
  createRoot(root).render(createElement(Workbench));
};
