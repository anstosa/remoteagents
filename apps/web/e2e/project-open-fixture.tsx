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
