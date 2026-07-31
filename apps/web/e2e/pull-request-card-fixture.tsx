import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PullRequestCard, type PullRequestSummary } from '../src/pull-request-card.js';

const pullRequests: PullRequestSummary[] = [
  { number: 7, title: 'Draft card', status: 'draft', url: 'https://github.com/octo/repo/pull/7', checks: 'passed' },
  { number: 8, title: 'Open card', status: 'open', url: 'https://github.com/octo/repo/pull/8', checks: 'failed', issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true } },
  { number: 9, title: 'Merged card', status: 'merged', url: 'https://github.com/octo/repo/pull/9', checks: 'pending' }
];

export const renderPullRequestCards = (root: HTMLElement) => {
  createRoot(root).render(createElement('div', {}, pullRequests.map(pullRequest => createElement(PullRequestCard, { key: pullRequest.number, pullRequest, onFixup: pullRequest.number === 8 ? async () => { root.dataset.fixup = 'queued'; return true; } : undefined }))));
};

export const renderPullRequestLayout = (root: HTMLElement) => {
  createRoot(root).render(createElement('article', { className: 'agent-view' },
    createElement('section', { className: 'log-shell', 'data-testid': 'output' }),
    createElement(PullRequestCard, { pullRequest: pullRequests[1] }),
    createElement('section', { className: 'prompt' }, createElement('div', { className: 'prompt-actions', 'data-testid': 'prompt-controls' }))
  ));
};
