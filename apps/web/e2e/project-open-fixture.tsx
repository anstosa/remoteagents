import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectOpen } from '../src/project-open.js';

export const renderProjectOpen = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://project.example.com',
    stack: { actions: ['build', 'restart'], operation: 'build', tunnel: true },
    onStackAction: () => {}
  }));
};

export const renderProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://project.example.com',
    stack: { actions: ['start', 'build', 'restart'], running: true, tunnel: false },
    onBrowserToggle: () => { root.dataset.browser = 'open'; },
    onStackAction: async action => {
      root.dataset.action = action;
      await new Promise(resolve => window.setTimeout(resolve, 200));
    }
  }));
};

export const renderStoppedProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://project.example.com',
    stack: { actions: ['start', 'build'], running: false, tunnel: false },
    onBrowserToggle: () => { root.dataset.browser = 'open'; },
    onStackAction: () => {}
  }));
};

// render an available direct project without stack commands
export const renderDirectProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://external-preview.example/map/',
    projectProxied: false,
    stack: { actions: [], tunnel: true },
    onBrowserToggle: () => { root.dataset.browser = 'open'; }
  }));
};

// render a direct project with explicit failed health
export const renderUnavailableDirectProjectOpenControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    url: 'https://external-preview.example/map/',
    projectProxied: false,
    stack: { actions: ['start'], running: false, tunnel: false },
    onBrowserToggle: () => { root.dataset.browser = 'open'; },
    onStackAction: () => {}
  }));
};

export const renderStackOnlyControls = (root: HTMLElement) => {
  createRoot(root).render(createElement(ProjectOpen, {
    stack: { actions: ['start', 'stop', 'build', 'restart'], running: true },
    onStackAction: action => { root.dataset.action = action; }
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
