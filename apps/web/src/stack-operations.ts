export type StackAction = 'start'|'stop'|'build'|'restart'|'migrate';
// a Worktree's Stack process as its pane shows it; `exitCode` is absent after a signal
export type StackProcessState = { name: string; state: 'running'|'exited'|'stopped'; exitCode?: number };
// what "Show <name> output" reads: the process's state and its pane's recent output, and while
// it runs the pane's id, which "Open as Terminal" opens
export type StackProcessOutput = StackProcessState & { paneId?: string; output: string };
// the actions a Stack process derives; any other action is a one-shot command (mirrors the
// server's list in worktree-commands/service.ts)
export const processActions: readonly StackAction[] = ['start', 'stop', 'restart'];
export type StackOperationLog = { action: StackAction; active: boolean; startedAt: string; completedAt?: string; output: string };

const actionLabels: Record<StackAction, string> = {
  start: 'Start stack',
  stop: 'Stop stack',
  build: 'Build stack',
  restart: 'Restart stack',
  migrate: 'Migrate stack'
};

const operationLabels: Record<StackAction, string> = {
  start: 'Starting',
  stop: 'Stopping',
  build: 'Building',
  restart: 'Restarting',
  migrate: 'Migrating'
};

export const stackActionLabel = (action: StackAction) => actionLabels[action];
export const stackOperationLabel = (action: StackAction) => operationLabels[action];

// validate stack log responses
export const isStackOperationLog = (value: unknown): value is StackOperationLog => {
  // require the response object
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<StackOperationLog>;
  return typeof candidate.action === 'string'
    && candidate.action in actionLabels
    && typeof candidate.active === 'boolean'
    && typeof candidate.startedAt === 'string'
    && (candidate.completedAt === undefined || typeof candidate.completedAt === 'string')
    && typeof candidate.output === 'string';
};

// validate Stack process output responses
export const isStackProcessOutput = (value: unknown): value is StackProcessOutput => {
  // require the response object
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<StackProcessOutput>;
  return typeof candidate.name === 'string'
    && (candidate.state === 'running' || candidate.state === 'exited' || candidate.state === 'stopped')
    && (candidate.exitCode === undefined || typeof candidate.exitCode === 'number')
    && (candidate.paneId === undefined || (typeof candidate.paneId === 'string' && /^%\d+$/u.test(candidate.paneId)))
    && typeof candidate.output === 'string';
};
