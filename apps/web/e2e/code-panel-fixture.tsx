import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import CodePanel from '../src/code-panel/code-panel.js';
import type { ComparisonFileContents, ComparisonPatch } from '../src/code-panel/comparison.js';

// Mount the Code panel in isolation with a scripted Comparison, so a Playwright spec can drive item
// derivation — grouping, capped placeholders, load-anyway — without the dashboard or the network.
// `loaded` stands in for the /comparison/file endpoint the "Load anyway" affordance calls.
export const renderCodePanel = (root: HTMLElement, patch: ComparisonPatch, loaded: Record<string, ComparisonFileContents> = {}) => {
  createRoot(root).render(createElement(CodePanel, {
    mode: patch.kind,
    state: 'ready',
    patch,
    loadFile: async (path: string) => loaded[path],
    onClose: () => { /* isolated fixture has nothing to close into */ }
  }));
};
