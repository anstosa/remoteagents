export type StackAction = 'start'|'stop'|'build'|'restart'|'migrate';

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
