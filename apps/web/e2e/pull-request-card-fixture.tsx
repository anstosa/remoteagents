import { createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { PullRequestCard, PullRequestFixup, type PullRequestSummary } from '../src/pull-request-card.js';

const pullRequests: PullRequestSummary[] = [
  { number: 7, title: 'Draft card', status: 'draft', url: 'https://github.com/octo/repo/pull/7', checks: 'passed' },
  { number: 8, title: 'Open card', status: 'open', url: 'https://github.com/octo/repo/pull/8', checks: 'failed', issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true } },
  { number: 9, title: 'Merged card', status: 'merged', url: 'https://github.com/octo/repo/pull/9', checks: 'pending' }
];

// render pr links with independent fixup actions
export const renderPullRequestCards = (root: HTMLElement) => {
  createRoot(root).render(createElement('div', {}, pullRequests.map(pullRequest => {
    // preserve each standalone link and action
    return createElement(Fragment, { key: pullRequest.number },
      createElement(PullRequestCard, { pullRequest }),
      createElement(PullRequestFixup, { pullRequest, onFixup: pullRequest.number === 8 ? async () => { /* accept queued fixes */ return true; } : undefined })
    );
  })));
};
