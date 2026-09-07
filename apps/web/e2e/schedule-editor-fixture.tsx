import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ScheduleEditor, type Schedule, type ScheduleSetBody } from '../src/schedule-editor.js';

type Emitted = { type: 'set'; body: ScheduleSetBody } | { type: 'remove' };
declare global { interface Window { scheduleEmitted: Emitted[] } }

// A stateful harness that renders the extracted editor, records every emitted Schedule
// record, and re-renders with the emitted value so "applies immediately" round-trips.
function Harness({ initial }: { initial?: Schedule }) {
  const [schedule, setSchedule] = useState<Schedule | undefined>(initial);
  return createElement(ScheduleEditor, {
    schedule,
    nextRun: schedule === undefined ? undefined : '2026-09-07T09:00:00-07:00',
    prefill: { kind: 'claude', target: { worktreeId: 'wt-main' } },
    runsOnText: 'atlas · main worktree',
    onSet: (body: ScheduleSetBody) => { window.scheduleEmitted.push({ type: 'set', body }); setSchedule({ ...body, updatedAt: '2026-09-06T12:00:00-07:00' }); },
    onRemove: () => { window.scheduleEmitted.push({ type: 'remove' }); setSchedule(undefined); },
    preview: async () => ['2026-09-07T09:00:00-07:00', '2026-09-08T09:00:00-07:00', '2026-09-09T09:00:00-07:00'],
    now: () => Date.parse('2026-09-06T12:00:00-07:00'),
  });
}

export const renderScheduleEditor = (root: HTMLElement, initial?: Schedule) => {
  window.scheduleEmitted = [];
  createRoot(root).render(createElement(Harness, { initial }));
};
