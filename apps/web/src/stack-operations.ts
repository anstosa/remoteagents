export type StackAction = 'start'|'stop'|'build'|'restart'|'migrate';
// the discovered Worktree a Process notice names, with the process it names there and that
// process's state when the Worktree declares it
export type ProcessNoticeTarget = { worktreeId: string; label: string; process?: string; state?: 'exited'|'stopped' };
// a notice target whose declared process is not running, which a notice's Start starts; the
// console hides a notice while the process it names runs, which is what ends that Start's progress
export type StartableNoticeTarget = ProcessNoticeTarget & { process: string };
// a message a Stack process reported about its own run, and the Worktree it names
export type ProcessNotice = { level: 'warning'|'info'; message: string; target?: ProcessNoticeTarget };
// a Worktree's Stack process as its pane shows it; `exitCode` is absent after a signal,
// `operation` is an action on this process alone in flight, and `notices` its Process notices
// that are showing
export type StackProcessState = { name: string; state: 'running'|'exited'|'stopped'; exitCode?: number; operation?: StackAction; notices?: ProcessNotice[] };
// what "Show <name> output" reads: the process's state and its pane's recent output, and while
// it runs the pane's id, which "Open as Terminal" opens
export type StackProcessOutput = StackProcessState & { paneId?: string; output: string };
// the actions a Stack process derives; any other action is a one-shot command (mirrors the
// server's list in worktree-commands/service.ts)
export const processActions = ['start', 'stop', 'restart'] as const satisfies readonly StackAction[];
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

// a Stack process's own actions, named for the one process they act on
const processActionLabels: Record<'start'|'stop'|'restart', string> = { start: 'Start', stop: 'Stop', restart: 'Restart' };

export const stackActionLabel = (action: StackAction) => actionLabels[action];
export const processActionLabel = (action: 'start'|'stop'|'restart') => processActionLabels[action];
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
