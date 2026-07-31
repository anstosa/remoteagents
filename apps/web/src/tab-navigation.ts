import { useEffect } from 'react';

export function cycleTabIndex(activeTab: number, tabCount: number, direction: -1 | 1) {
  if (tabCount < 1) return 0;
  return (activeTab + direction + tabCount) % tabCount;
}

export function useShiftArrowTabCycling(activeTab: number, tabCount: number, selectTab: (index: number) => void) {
  useEffect(() => {
    const cycle = (event: KeyboardEvent) => {
      if (
        tabCount < 2
        || !event.shiftKey
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
      ) return;

      event.preventDefault();
      selectTab(cycleTabIndex(activeTab, tabCount, event.key === 'ArrowLeft' ? -1 : 1));
    };

    window.addEventListener('keydown', cycle);
    return () => window.removeEventListener('keydown', cycle);
  }, [activeTab, selectTab, tabCount]);
}
