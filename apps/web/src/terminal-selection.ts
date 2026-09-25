import type { StreamedTerminalHandle } from './streamed-terminal.js';
import { computeTerminalTheme } from './terminal-theme.js';

export type TerminalSelection = { text: string; top: number; left: number };

type TerminalSelectionOptions = {
  onSelection: (selection: TerminalSelection | undefined) => void;
  copyText: (value: string) => Promise<void>;
  flashElement: HTMLElement;
  copyFlashMs: number;
};

const selectionContainers = new Set<HTMLElement>();
// the share of a pane that must show for it to count as on screen
const minimumInViewRatio = 0.01;
let shortcutOwner: HTMLElement | undefined;

// resolve text-node event targets to their parent element
const eventTargetElement = (target: EventTarget | null): Element | null => {
  // preserve element targets directly
  if (target instanceof Element) return target;
  // map browser text targets back to their containing element
  if (target instanceof Node) return target.parentElement;
  return null;
};

// identify fields that own ordinary typing
const isEditableTarget = (target: Element | null): boolean => {
  // treat form controls as editable surfaces
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
};

// reject panes hidden by desktop or mobile layout rules
const containerIsVisible = (container: HTMLElement): boolean => {
  // reject detached and semantically hidden terminals
  if (!container.isConnected || container.closest('[hidden], [aria-hidden="true"]') !== null) return false;
  const style = window.getComputedStyle(container);
  // reject stylesheet-hidden terminals and ancestors
  return style.visibility !== 'hidden' && style.display !== 'none' && container.getClientRects().length > 0;
};

// find which registered terminal owns one selection endpoint
const selectionEndpointOwner = (node: Node | null): HTMLElement | undefined => {
  // prefer the first containing terminal
  for (const candidate of selectionContainers) {
    // return the endpoint's terminal
    if (node !== null && candidate.contains(node)) return candidate;
  }
  return undefined;
};

// attach selection freezing, actions and copy feedback to one terminal
export function attachTerminalSelection(container: HTMLElement, handle: StreamedTerminalHandle, options: TerminalSelectionOptions): { copy: (value: string) => Promise<void>; dispose: () => void } {
  const terminal = handle.terminal;
  let disposed = false;
  let nativeSelectionWasActive = false;
  let mouseSelectionGesture = false;
  let copiedSelectionTimer: number | undefined;
  let terminalThemeFlashed = false;
  // whether the pane is on screen; the view observer below keeps it current
  let inView = true;
  const paneIsVisible = () => inView && containerIsVisible(container);
  selectionContainers.add(container);

  // scope the browser selection to one terminal
  const nativeSelectionActive = (): boolean => {
    const selection = window.getSelection();
    // ignore empty browser selections
    if (selection === null || selection.isCollapsed) return false;
    const anchorOwner = selectionEndpointOwner(selection.anchorNode);
    // make cross-pane selections belong to their starting pane
    if (anchorOwner !== undefined) return anchorOwner === container;
    return selection.focusNode !== null && container.contains(selection.focusNode);
  };

  // keep the toolbar within the viewport around this pane
  const toolbarPosition = (bottom: number): Pick<TerminalSelection, 'top' | 'left'> => {
    const bounds = container.getBoundingClientRect();
    const maximumTop = Math.max(8, window.innerHeight - 48);
    const maximumLeft = Math.max(8, window.innerWidth - 8);
    return {
      top: Math.max(8, Math.min(maximumTop, bottom + 8)),
      left: Math.max(8, Math.min(maximumLeft, bounds.left + bounds.width / 2))
    };
  };

  // restore a flashed xterm palette only outside native selection mode
  const restoreTerminalTheme = () => {
    // preserve the flash and avoid repainting browser-owned selection nodes
    if (!terminalThemeFlashed || copiedSelectionTimer !== undefined || nativeSelectionActive()) return;
    terminal.options.theme = computeTerminalTheme();
    terminalThemeFlashed = false;
  };

  // flash both native and terminal-rendered selections after copying
  const flashCopiedSelection = () => {
    // ignore late clipboard completions
    if (disposed) return;
    options.flashElement.classList.add('selection-copied');
    const flashTerminalSelection = terminal.hasSelection() && !nativeSelectionActive();
    // repaint only xterm-rendered selections
    if (flashTerminalSelection) {
      const theme = computeTerminalTheme();
      terminal.options.theme = { ...theme, selectionBackground: theme.green, selectionInactiveBackground: theme.green };
      terminalThemeFlashed = true;
    }
    // restart the flash when another copy completes
    if (copiedSelectionTimer !== undefined) window.clearTimeout(copiedSelectionTimer);
    // restore the current palette without clearing the copied selection
    copiedSelectionTimer = window.setTimeout(() => {
      copiedSelectionTimer = undefined;
      options.flashElement.classList.remove('selection-copied');
      restoreTerminalTheme();
    }, options.copyFlashMs);
  };

  // copy one selection and acknowledge successful writes
  const copy = async (value: string): Promise<void> => {
    await options.copyText(value);
    // suppress effects after disposal
    if (!disposed) flashCopiedSelection();
  };

  // publish the current terminal or browser selection
  const syncSelectionMode = (claimShortcuts = false) => {
    // release hidden panes instead of retaining global shortcut ownership
    if (!paneIsVisible()) {
      mouseSelectionGesture = false;
      nativeSelectionWasActive = false;
      // discard browser ranges owned by the hidden pane
      if (nativeSelectionActive()) window.getSelection()?.removeAllRanges();
      // prevent stale terminal selections from returning after layout changes
      if (terminal.hasSelection()) terminal.clearSelection();
      handle.setOutputPaused(false);
      options.onSelection(undefined);
      // release only this pane's shortcut claim
      if (shortcutOwner === container) shortcutOwner = undefined;
      restoreTerminalTheme();
      return;
    }
    const nativeActive = nativeSelectionActive();
    // clear xterm's mirror when the browser selection leaves output
    if (!nativeActive && nativeSelectionWasActive) {
      nativeSelectionWasActive = false;
      // let the nested xterm event finish the state transition
      if (terminal.hasSelection()) {
        terminal.clearSelection();
        return;
      }
    }
    nativeSelectionWasActive = nativeActive;
    restoreTerminalTheme();
    const hasTerminalSelection = terminal.hasSelection();
    const hasSelection = hasTerminalSelection || nativeActive;
    handle.setOutputPaused(mouseSelectionGesture || hasSelection);
    // claim shortcuts only from an event local to this pane
    if (hasSelection && claimShortcuts) shortcutOwner = container;
    // release only this pane's cleared shortcut claim
    if (!hasSelection && shortcutOwner === container) shortcutOwner = undefined;
    // position browser-native selections below their final row
    if (nativeActive) {
      const selection = window.getSelection();
      const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
      const bounds = range === undefined ? undefined : (Array.from(range.getClientRects()).at(-1) ?? range.getBoundingClientRect());
      const text = selection?.toString() ?? '';
      options.onSelection(!text || bounds === undefined ? undefined : { text, ...toolbarPosition(bounds.bottom) });
      return;
    }
    // clear the toolbar with the terminal selection
    if (!hasTerminalSelection) {
      options.onSelection(undefined);
      return;
    }
    const text = terminal.getSelection();
    const position = terminal.getSelectionPosition();
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    // require enough grid geometry to locate the selected row
    if (!text || position === undefined || screen === null || screen === undefined || terminal.rows < 1) {
      options.onSelection(undefined);
      return;
    }
    const screenBounds = screen.getBoundingClientRect();
    const viewportRow = position.end.y - terminal.buffer.active.viewportY + 1;
    const selectionBottom = screenBounds.top + viewportRow * (screenBounds.height / terminal.rows);
    options.onSelection({ text, ...toolbarPosition(selectionBottom) });
  };

  // freeze before xterm commits desktop drag selections on mouseup
  const beginOutputSelection = (event: PointerEvent) => {
    // leave hidden panes, touch scrolling, secondary clicks and scrollbar drags alone
    if (!paneIsVisible() || event.pointerType !== 'mouse' || event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('.xterm-screen')) return;
    // preserve live application mouse gestures without the platform override
    if (terminal.modes.mouseTrackingMode !== 'none') {
      const forceSelection = navigator.platform.startsWith('Mac')
        ? event.altKey && terminal.options.macOptionClickForcesSelection
        : event.shiftKey;
      // require xterm's mouse-reporting override
      if (!forceSelection) return;
    }
    mouseSelectionGesture = true;
    shortcutOwner = container;
    handle.setOutputPaused(true);
  };

  // keep completed selections frozen but release empty or cancelled drags
  const endOutputSelection = () => {
    // ignore unrelated pointer releases and window focus changes
    if (!mouseSelectionGesture) return;
    mouseSelectionGesture = false;
    syncSelectionMode();
  };

  // identify events owned by another output surface
  const targetsForeignOutput = (target: Element | null): boolean => {
    // body-level mobile shortcuts have no foreign surface
    if (target === null) return false;
    // accept events from this terminal's own DOM
    if (container.contains(target)) return false;
    const ownOutput = container.closest('.terminal-pane, .log-output');
    const targetOutput = target.closest('.terminal-pane, .log-output');
    // isolate terminal and log surfaces from one another
    if (targetOutput !== null) return targetOutput !== ownOutput;
    // portal toolbars never belong to another pane's shortcut handler
    return target.closest('.output-selection-toolbar') !== null;
  };

  // return the selected text owned by this pane
  const selectedOutput = (): string => {
    // preserve xterm's selection precedence
    if (terminal.hasSelection()) return terminal.getSelection();
    // mirror native text only from this container
    if (nativeSelectionActive()) return window.getSelection()?.toString() ?? '';
    return '';
  };

  // yank or copy the active output selection
  const copySelectionShortcut = (event: KeyboardEvent) => {
    // ignore late events after cleanup
    if (disposed) return;
    const key = event.key.toLowerCase();
    const yank = key === 'y' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const terminalCopy = key === 'c' && event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
    // avoid per-pane layout reads for ordinary typing
    if (!yank && !terminalCopy) return;
    const target = eventTargetElement(event.target);
    const localTarget = target !== null && container.contains(target);
    // require ownership only for body-level and other neutral targets
    if (!localTarget && shortcutOwner !== container) return;
    // leave fields outside this terminal untouched
    if (isEditableTarget(target) && (target === null || !container.contains(target))) return;
    // leave every other output surface untouched
    if (targetsForeignOutput(target)) return;
    // measure visibility only for this pane's copy shortcuts
    if (!paneIsVisible()) return;
    const selected = selectedOutput();
    // preserve the key when selection has cleared
    if (!selected) return;
    event.preventDefault();
    event.stopPropagation();
    void copy(selected);
  };

  // acknowledge the browser's native clipboard copy
  const nativeOutputCopied = () => {
    // flash only the visible pane that owns the native selection
    if (paneIsVisible() && nativeSelectionActive()) flashCopiedSelection();
  };

  container.addEventListener('pointerdown', beginOutputSelection, true);
  window.addEventListener('pointerup', endOutputSelection, true);
  window.addEventListener('pointercancel', endOutputSelection, true);
  window.addEventListener('blur', endOutputSelection);
  const selectionSub = terminal.onSelectionChange(() => syncSelectionMode(true));
  // claim native selection shortcuts only in the pane containing the selection
  const nativeSelectionChanged = () => syncSelectionMode(nativeSelectionActive());
  document.addEventListener('selectionchange', nativeSelectionChanged);
  document.addEventListener('copy', nativeOutputCopied);
  document.addEventListener('keydown', copySelectionShortcut, true);
  // follow fullscreen and responsive visibility changes without selection events
  const selectionResizeObserver = new ResizeObserver(() => {
    // ignore callbacks queued before cleanup
    if (!disposed) syncSelectionMode();
  });
  selectionResizeObserver.observe(container);
  // A pane swiped out of the phone's panel carousel is hidden too, though its size is unchanged.
  // Its neighbour's edge still touches the screen, which counts as intersecting at ratio 0, so a
  // pane is on screen only while a sliver of it shows.
  const selectionViewObserver = new IntersectionObserver(entries => {
    const entry = entries.at(-1);
    if (entry !== undefined) inView = entry.intersectionRatio >= minimumInViewRatio;
    // ignore callbacks queued before cleanup
    if (!disposed) syncSelectionMode();
  }, { threshold: minimumInViewRatio });
  selectionViewObserver.observe(container);
  // let focused terminals copy instead of sending interrupt
  terminal.attachCustomKeyEventHandler(event => {
    // preserve non-copy keys and late terminal events
    if (disposed || event.type !== 'keydown' || event.key.toLowerCase() !== 'c') return true;
    // copy a visible xterm selection on Ctrl/Cmd+C
    if (paneIsVisible() && (event.ctrlKey || event.metaKey) && !event.shiftKey && terminal.hasSelection()) {
      event.preventDefault();
      void copy(terminal.getSelection());
      return false;
    }
    return true;
  });

  // release every listener and transient visual state
  const dispose = () => {
    // make cleanup idempotent
    if (disposed) return;
    disposed = true;
    // release only this pane's shortcut claim
    if (shortcutOwner === container) shortcutOwner = undefined;
    // cancel any pending flash cleanup
    if (copiedSelectionTimer !== undefined) window.clearTimeout(copiedSelectionTimer);
    copiedSelectionTimer = undefined;
    options.flashElement.classList.remove('selection-copied');
    selectionSub.dispose();
    selectionResizeObserver.disconnect();
    selectionViewObserver.disconnect();
    container.removeEventListener('pointerdown', beginOutputSelection, true);
    window.removeEventListener('pointerup', endOutputSelection, true);
    window.removeEventListener('pointercancel', endOutputSelection, true);
    window.removeEventListener('blur', endOutputSelection);
    document.removeEventListener('selectionchange', nativeSelectionChanged);
    document.removeEventListener('copy', nativeOutputCopied);
    document.removeEventListener('keydown', copySelectionShortcut, true);
    handle.setOutputPaused(false);
    options.onSelection(undefined);
    // avoid mutating native selection nodes during teardown
    if (!nativeSelectionActive()) restoreTerminalTheme();
    selectionContainers.delete(container);
  };

  return { copy, dispose };
}
