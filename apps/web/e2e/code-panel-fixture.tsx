import { createElement, type ReactElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CodePanel from '../src/code-panel/code-panel.js';
import { useCodePanel, type CodePanelMode, type ComparisonFileContents, type ComparisonPatch, type FilePreviewView } from '../src/code-panel/comparison.js';
import { PanelExpandContext, useExpansionScope, usePanelExpansion } from '../src/panel-header.js';

// Host the panel the way a Workspace split does: one expansion scope holding the Code panel, with
// Esc restoring from the container. `startExpanded` opens it promoted, as an agentless Worktree does.
function Workspace({ children, startExpanded = false }: { children: ReactElement; startExpanded?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const expansion = usePanelExpansion();
  const scope = useExpansionScope(expansion, ['code'], containerRef);
  useLayoutEffect(() => { if (startExpanded) expansion.setExpanded('code', true); }, [startExpanded, expansion.setExpanded]);
  return createElement(PanelExpandContext.Provider, { value: scope.context }, createElement('div', { ref: containerRef, style: { display: 'grid', minWidth: 0, minHeight: 0 }, onKeyDown: scope.onKeyDown }, children));
}

// A spec reads the recorded loadFile calls to confirm Plain / Full-context / live-rebuild fetched the file.
const loadLog = (): { __codeLoads?: string[] } => window as unknown as { __codeLoads?: string[] };

// A gate a spec can close to hold loadFile mid-flight, so it can observe the panel while a file's
// contents are still being fetched — used to prove a full-context file keeps its expanded view (not a
// hunks-only blink) while its non-partial rebuild is in flight.
type Gate = { held: boolean; waiters: (() => void)[] };
const gate: Gate = { held: false, waiters: [] };
export const holdLoads = () => { gate.held = true; };
export const releaseLoads = () => { gate.held = false; gate.waiters.splice(0).forEach(resume => resume()); };

// A spec pushes a fresh Comparison (and optional per-file revision contents) to drive a live update.
let pushUpdate: ((patch: ComparisonPatch, loaded?: Record<string, ComparisonFileContents>) => void) | undefined;
export const updateCodePanel = (patch: ComparisonPatch, loaded?: Record<string, ComparisonFileContents>) => pushUpdate?.(patch, loaded);

// A tiny stateful stand-in for the controller: it owns the selected file, the Working/All PR mode, and
// the current patch so a Playwright spec can drive the real single-file / breadcrumb / mode controls
// and a live update in isolation from the dashboard and the network. `loaded` stands in for the
// /comparison/file endpoint that Plain, Full-context, and "Load anyway" call; every call is recorded
// on `window.__codeLoads` and held while the gate is closed.
function Harness({ initialPatch, initialLoaded, startExpanded }: { initialPatch: ComparisonPatch; initialLoaded: Record<string, ComparisonFileContents>; startExpanded?: boolean }) {
  const [patch, setPatch] = useState(initialPatch);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [mode, setMode] = useState<CodePanelMode>(initialPatch.kind);
  // loaded contents live in a ref so loadFile keeps a stable identity across renders and live updates
  const loadedRef = useRef(initialLoaded);
  const loadFile = useCallback(async (path: string) => {
    (loadLog().__codeLoads ??= []).push(path);
    if (gate.held) await new Promise<void>(resume => gate.waiters.push(resume));
    return loadedRef.current[path];
  }, []);
  useEffect(() => {
    pushUpdate = (next, loaded) => { if (loaded !== undefined) loadedRef.current = loaded; setPatch(next); };
    return () => { pushUpdate = undefined; };
  }, []);
  return createElement(Workspace, { startExpanded }, createElement(CodePanel, {
    mode,
    state: 'ready',
    patch,
    selectedPath,
    prAvailable: true,
    loadFile,
    onSelectFile: (path: string) => setSelectedPath(path),
    onClearFile: () => setSelectedPath(undefined),
    onSetMode: (next: CodePanelMode) => setMode(next),
    onCloseFile: () => { /* isolated fixture has no Comparison to return to */ },
    onClose: () => { /* isolated fixture has nothing to close into */ }
  }));
}

export const renderCodePanel = (root: HTMLElement, patch: ComparisonPatch, loaded: Record<string, ComparisonFileContents> = {}, startExpanded = false) => {
  loadLog().__codeLoads = [];
  gate.held = false; gate.waiters = [];
  createRoot(root).render(createElement(Harness, { initialPatch: patch, initialLoaded: loaded, startExpanded }));
};

// Mount the panel showing a static File view, so a spec can assert each preview state (text through
// the library, an image, a binary placeholder, an over-cap notice) without a controller or network.
export const renderFilePreview = (root: HTMLElement, filePreview: FilePreviewView) => {
  createRoot(root).render(createElement(Workspace, {}, createElement(CodePanel, {
    mode: 'working' as CodePanelMode,
    state: 'ready' as const,
    patch: undefined,
    selectedPath: undefined,
    filePreview,
    prAvailable: false,
    loadFile: async () => undefined,
    onSelectFile: () => { /* no rail in the File view */ },
    onClearFile: () => { /* no rail in the File view */ },
    onSetMode: () => { /* no Comparison toggle in the File view */ },
    onCloseFile: () => { /* spec asserts render, not navigation */ },
    onClose: () => { /* spec asserts render, not navigation */ }
  })));
};

// Controls a spec drives on the REAL `useCodePanel` controller (below), so the production trigger —
// its soft refresh keyed on the change signal, the fingerprint no-repaint guard, and the request
// stale-guard — is exercised end to end rather than the view being fed patches by hand.
type Controls = {
  // fetches so far against the /comparison endpoint, and how many times the controller's patch
  // reference actually changed (a same-fingerprint refresh must not bump this)
  fetches: number;
  patchChanges: number;
  // the Comparison the next fetch resolves with
  setNext(patch: ComparisonPatch): void;
  // open the panel (a hard load) / move the live change signal (a soft refresh)
  open(): void;
  bump(signal: string): void;
  // open one file in the File view via the real controller (a file-preview fetch), then leave it
  openFile(path: string, content: string): void;
  closeFile(): void;
};
const controlLog = (): { __ctrl?: Controls } => window as unknown as { __ctrl?: Controls };

function ControllerHarness({ initialPatch }: { initialPatch: ComparisonPatch }) {
  const [signal, setSignal] = useState('s0');
  const nextRef = useRef(initialPatch);
  // the file-preview payload the next /file-preview fetch resolves with, so the round-trip runs
  // through the real openFilePreview fetch + isFilePreview guard
  const nextFileRef = useRef<{ path: string; size: number; truncated: boolean; binary: false; content: string } | undefined>(undefined);
  const stats = useRef({ fetches: 0, patchChanges: 0 });
  const lastPatch = useRef<ComparisonPatch | undefined>(undefined);
  const request = useCallback(async (url: string) => {
    const body = url.includes('/file-preview') ? nextFileRef.current : nextRef.current;
    if (!url.includes('/file-preview')) stats.current.fetches += 1;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }, []);
  const controller = useCodePanel('cora', request, signal);
  // count each real change of the patch reference — the no-repaint guard returns the same object when
  // the fingerprint is unchanged, so a same-fingerprint refresh leaves this flat
  if (controller.patch !== lastPatch.current) { lastPatch.current = controller.patch; stats.current.patchChanges += 1; }
  useEffect(() => {
    controlLog().__ctrl = {
      get fetches() { return stats.current.fetches; },
      get patchChanges() { return stats.current.patchChanges; },
      setNext: patch => { nextRef.current = patch; },
      open: () => controller.openChanges('working'),
      bump: next => setSignal(next),
      openFile: (path, content) => { nextFileRef.current = { path, size: content.length, truncated: false, binary: false, content }; controller.openFilePreview(path, `/api/agents/agent-1/file-preview`); },
      closeFile: () => controller.closeFilePreview()
    };
  });
  return createElement(Workspace, {}, createElement(CodePanel, {
    mode: controller.mode,
    state: controller.state,
    patch: controller.patch,
    selectedPath: controller.selectedPath,
    filePreview: controller.filePreview,
    prAvailable: true,
    loadFile: controller.loadFile,
    onSelectFile: controller.selectFile,
    onClearFile: controller.clearFile,
    onSetMode: controller.setMode,
    onCloseFile: controller.closeFilePreview,
    onClose: controller.close,
    onRetry: controller.refresh
  }));
}

export const renderCodeController = (root: HTMLElement, initialPatch: ComparisonPatch) => {
  createRoot(root).render(createElement(ControllerHarness, { initialPatch }));
};
