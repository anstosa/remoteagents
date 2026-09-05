import { useEffect } from 'react';

export const isPromptKeyboardTarget = (target: EventTarget | null) => target instanceof HTMLElement && target.getAttribute('aria-label') === 'Prompt';

// recognize focus anywhere inside prompt controls
const isPromptAreaKeyboardTarget = (target: EventTarget | null) => target instanceof HTMLElement && target.closest('.prompt') !== null;

export function cycleTabIndex(activeTab: number, tabCount: number, direction: -1 | 1) {
  if (tabCount < 1) return 0;
  return (activeTab + direction + tabCount) % tabCount;
}

export function useShiftArrowTabCycling(activeTab: number, tabCount: number, selectTab: (index: number) => void) {
  useEffect(() => {
    const cycle = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        tabCount < 2
        || !event.shiftKey
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || isPromptAreaKeyboardTarget(target)
        || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
      ) return;

      event.preventDefault();
      selectTab(cycleTabIndex(activeTab, tabCount, event.key === 'ArrowLeft' ? -1 : 1));
    };

    window.addEventListener('keydown', cycle);
    return () => window.removeEventListener('keydown', cycle);
  }, [activeTab, selectTab, tabCount]);
}
