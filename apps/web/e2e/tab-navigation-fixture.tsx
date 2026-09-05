import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useShiftArrowTabCycling } from '../src/tab-navigation.js';

const tabs = ['Alpha', 'Bravo', 'Charlie'];

function TabNavigationFixture() {
  const [active, setActive] = useState(0);
  useShiftArrowTabCycling(active, tabs.length, setActive);

  return createElement('div', {},
    createElement('section', { className: 'prompt' },
      createElement('input', { 'aria-label': 'Prompt', defaultValue: 'copy this text' }),
      createElement('button', { type: 'button' }, 'Prompt action')
    ),
    createElement('div', { role: 'tablist', 'aria-label': 'Agents' },
      tabs.map((tab, index) => createElement('button', {
        key: tab,
        role: 'tab',
        'aria-selected': active === index,
        tabIndex: active === index ? 0 : -1
      }, tab))
    )
  );
}

export const renderTabNavigation = (root: HTMLElement) => {
  createRoot(root).render(createElement(TabNavigationFixture));
};
