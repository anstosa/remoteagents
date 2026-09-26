import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectOpen } from '../src/project-open.js';
import { isStackProcessOutput } from '../src/stack-operations.js';

// render controls during an active operation
export const renderProjectOpen = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://project.example.com',
    stack: { actions: ['build', 'restart'], operation: 'build', tunnel: true },
    onBrowserToggle: () => {},
    onStackAction: () => {}
  }));
};

// render stateful managed project controls
const ManagedProjectOpenControls = () => {
  const [browserOpen, setBrowserOpen] = useState(false);
  return createElement(ProjectOpen, {
    url: 'https://project.example.com',
    stack: { actions: ['start', 'build', 'restart'], running: true, tunnel: false },
    browserOpen,
    onBrowserToggle: () => setBrowserOpen(open => !open),
    onStackAction: async () => {
      // preserve visible progress for assertions
      await new Promise(resolve => window.setTimeout(resolve, 200));
    }
  });
};

export const renderProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ManagedProjectOpenControls));
};

export const renderStoppedProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://project.example.com',
    stack: { actions: ['start', 'build'], running: false, tunnel: false },
    onBrowserToggle: () => {},
    onStackAction: () => {}
  }));
};

// render stateful direct project controls
const DirectProjectOpenControls = () => {
  const [browserOpen, setBrowserOpen] = useState(false);
  return createElement(ProjectOpen, {
    url: 'https://external-preview.example/map/',
    stack: { actions: [], tunnel: true },
    browserOpen,
    onBrowserToggle: () => setBrowserOpen(open => !open)
  });
};

// render an available direct project without stack commands
export const renderDirectProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(DirectProjectOpenControls));
};

// render a direct project with explicit failed health
export const renderUnavailableDirectProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://external-preview.example/map/',
    stack: { actions: ['start'], running: false, tunnel: false },
    onBrowserToggle: () => {},
    onStackAction: () => {}
  }));
};

export const renderStackOnlyControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    stack: { actions: ['start', 'stop', 'build', 'restart'], running: true },
    onStackAction: () => {}
  }));
};

export const renderStackOnlyStatuses = (root: HTMLElement) => {
  // keep status fixtures static
  const ignoreStackAction = () => {};
  // render each stack-only status
  createRoot(root).render(createElement('div', {},
    createElement(ProjectOpen, { stack: { actions: ['start'], running: true }, onStackAction: ignoreStackAction }),
    createElement(ProjectOpen, { stack: { actions: ['start'], running: false }, onStackAction: ignoreStackAction }),
    createElement(ProjectOpen, { stack: { actions: ['start'] }, onStackAction: ignoreStackAction })
  ));
};

// render a Stack process that is still Starting (up, but its tunnel not yet healthy)
export const renderStartingProcessControls = (root: HTMLElement) => {
  const Controls = () => {
    const [operation, setOperation] = useState<'stop'>();
    return createElement(ProjectOpen, {
      stack: { actions: ['start', 'stop', 'restart'], running: true, transition: 'starting', ...(operation === undefined ? {} : { operation }) },
      onStackAction: async () => {
        setOperation('stop');
        // preserve visible progress for assertions
        await new Promise(resolve => window.setTimeout(resolve, 200));
      }
    });
  };
  createRoot(root).render(createElement(Controls));
};

// render a Stack process that died on its own: with its exit code and a down tunnel (exited wins),
// and after a signal, when tmux keeps no exit code
export const renderExitedProcessStatuses = (root: HTMLElement) => {
  const ignoreStackAction = () => {};
  createRoot(root).render(createElement('div', {},
    createElement(ProjectOpen, { stack: { actions: ['start', 'stop', 'restart'], running: false, tunnel: false, process: { name: 'dev', state: 'exited', exitCode: 127 } }, onStackAction: ignoreStackAction }),
    createElement(ProjectOpen, { stack: { actions: ['start', 'stop', 'restart'], running: false, process: { name: 'dev', state: 'exited' } }, onStackAction: ignoreStackAction })
  ));
};

// the Terminals "Open as Terminal" asked for, for a spec to read back
type OpenedTerminals = { openedTerminals?: { paneId: string; name: string }[] };
const recordOpenedTerminal = (paneId: string, name: string) => {
  const record = window as unknown as OpenedTerminals;
  record.openedTerminals = [...record.openedTerminals ?? [], { paneId, name }];
};

// render a Stack process Worktree that also has a one-shot `build`: its process output grows a
// line on every read, so the dialog's polling shows as new lines. Its pane is `%17`, read through
// the same check the console's fetch applies.
export const renderProcessOutputControls = (root: HTMLElement) => {
  let reads = 0;
  createRoot(root).render(createElement(ProjectOpen, {
    stack: { actions: ['start', 'stop', 'build', 'restart'], running: true, process: { name: 'dev', state: 'running' } },
    onStackAction: () => {},
    onStackLog: async () => ({ action: 'build', active: false, startedAt: '2026-09-26T10:00:00.000Z', completedAt: '2026-09-26T10:01:00.000Z', output: 'built in 3s' }),
    onOpenTerminal: recordOpenedTerminal,
    onProcessOutput: async () => {
      reads += 1;
      const payload: unknown = { name: 'dev', state: 'running', paneId: '%17', output: ['ready in 120ms', ...Array.from({ length: 80 }, (_, index) => `compiled module ${index + 1}`), ...Array.from({ length: reads }, (_, index) => `request ${index + 1}`)].join('\n') };
      if (!isStackProcessOutput(payload)) throw new Error('invalid process output');
      return payload;
    }
  }));
};

// render a Stack process with no one-shot commands, which has died
export const renderExitedProcessOutputControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    stack: { actions: ['start', 'stop', 'restart'], running: false, process: { name: 'dev', state: 'exited', exitCode: 127 } },
    onStackAction: () => {},
    onStackLog: async () => undefined,
    onOpenTerminal: recordOpenedTerminal,
    onProcessOutput: async () => ({ name: 'dev', state: 'exited', exitCode: 127, output: 'bash: line 1: pnpm: command not found' })
  }));
};
