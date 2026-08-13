export type StackAction = 'start'|'stop'|'build'|'restart'|'migrate';
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
