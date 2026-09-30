import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { UpstreamRebaseNotification } from '../src/upstream-rebase.js';

// mount one upstream notice in its fixed stack
export const renderUpstreamRebaseNotifications = (root: HTMLElement) => {
  createRoot(root).render(createElement('div', { className: 'toast-region' },
    createElement(UpstreamRebaseNotification, { notificationKey: 'fixture:feature', summary: { upstream: 'origin/feature', ahead: 2, behind: 3 }, onRebase: async () => { root.dataset.rebase = 'queued'; return true; } }),
    createElement(UpstreamRebaseNotification, { notificationKey: 'fixture:main', summary: { upstream: 'origin/main', ahead: 1, behind: 0 }, onRebase: async () => true })
  ));
};
