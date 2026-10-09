import { keyTarget, typingOutsideTerminal, useKeyAction, type KeyActionContext } from './keyboard.js';

export const isPromptKeyboardTarget = (target: EventTarget | null) => target instanceof HTMLElement && target.getAttribute('aria-label') === 'Prompt';

export function cycleTabIndex(activeTab: number, tabCount: number, direction: -1 | 1) {
  if (tabCount < 1) return 0;
  return (activeTab + direction + tabCount) % tabCount;
}

// The next- and previous-workspace actions, which cycle the Workspace tabs with wraparound. From
// root (S-Left, S-Right) they decline in text fields and the prompt's controls, where Shift+Arrow
// selects text; behind the leader they always apply.
export function useWorkspaceCycleKeys(activeTab: number, tabCount: number, selectTab: (index: number) => void) {
  const cycle = (direction: -1 | 1) => (event: KeyboardEvent | undefined, context: KeyActionContext | undefined) => {
    if (tabCount < 2) return false;
    if (context?.table === 'root' && (typingOutsideTerminal(event) || keyTarget(event)?.closest('.prompt') != null)) return false;
    selectTab(cycleTabIndex(activeTab, tabCount, direction));
  };
  useKeyAction('next-workspace', cycle(1));
  useKeyAction('previous-workspace', cycle(-1));
}
