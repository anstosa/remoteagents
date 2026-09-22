import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CodePanel from '../src/code-panel/code-panel.js';
import type { CodePanelMode, ComparisonFileContents, ComparisonPatch } from '../src/code-panel/comparison.js';

// A spec reads the recorded loadFile calls to confirm Plain / Full-context fetched the file.
const loadLog = (): { __codeLoads?: string[] } => window as unknown as { __codeLoads?: string[] };

// A tiny stateful stand-in for the controller: it owns the selected file and the Working/All PR mode
// so a Playwright spec can drive the real single-file / breadcrumb / mode controls in isolation from
// the dashboard and the network. `loaded` stands in for the /comparison/file endpoint that Plain,
// Full-context, and "Load anyway" call, and every call is recorded on `window.__codeLoads`.
function Harness({ patch, loaded }: { patch: ComparisonPatch; loaded: Record<string, ComparisonFileContents> }) {
  const [selectedPath, setSelectedPath] = useState<string>();
  const [mode, setMode] = useState<CodePanelMode>(patch.kind);
  return createElement(CodePanel, {
    mode,
    state: 'ready',
    patch,
    selectedPath,
    prAvailable: true,
    loadFile: async (path: string) => { (loadLog().__codeLoads ??= []).push(path); return loaded[path]; },
    onSelectFile: (path: string) => setSelectedPath(path),
    onClearFile: () => setSelectedPath(undefined),
    onSetMode: (next: CodePanelMode) => setMode(next),
    onClose: () => { /* isolated fixture has nothing to close into */ }
  });
}

export const renderCodePanel = (root: HTMLElement, patch: ComparisonPatch, loaded: Record<string, ComparisonFileContents> = {}) => {
  loadLog().__codeLoads = [];
  createRoot(root).render(createElement(Harness, { patch, loaded }));
};
