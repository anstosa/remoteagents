import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { UpstreamRebaseBanner } from '../src/upstream-rebase.js';

export const renderUpstreamRebaseBanners = (root: HTMLElement) => {
  createRoot(root).render(createElement('div', {},
    createElement(UpstreamRebaseBanner, { summary: { upstream: 'origin/feature', ahead: 2, behind: 3 }, onRebase: async () => { root.dataset.rebase = 'queued'; return true; } }),
    createElement(UpstreamRebaseBanner, { summary: { upstream: 'origin/main', ahead: 1, behind: 0 }, onRebase: async () => true })
  ));
};
