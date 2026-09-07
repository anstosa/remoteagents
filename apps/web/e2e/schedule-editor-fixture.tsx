import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ScheduleEditor, type Schedule, type ScheduleSetBody } from '../src/schedule-editor.js';

type Emitted = { type: 'set'; body: ScheduleSetBody } | { type: 'remove' };
declare global { interface Window { scheduleEmitted: Emitted[] } }

// Stands in for the server's parser: a real croner check lives on the server, so the fixture treats
// any 5-field expression as parseable and everything else as the parse-error case. A parseable
// expression with an impossible day/month (Feb 31) models croner's "parses but never matches a
// date" outcome — it previews empty with no error and yields no nextRun, like the real route.
const fields = (cron: string) => cron.trim().split(/\s+/);
const parseable = (cron: string) => fields(cron).length === 5;
const neverFires = (cron: string) => { const f = fields(cron); return f.length === 5 && f[2] === '31' && f[3] === '2'; };

// A stateful harness that renders the extracted editor, records every emitted Schedule
// record, and re-renders with the emitted value so "applies immediately" round-trips.
function Harness({ initial }: { initial?: Schedule }) {
  const [schedule, setSchedule] = useState<Schedule | undefined>(initial);
  return createElement(ScheduleEditor, {
    schedule,
    // the server omits nextRun for a schedule whose cron cannot yield a next instant
    nextRun: schedule !== undefined && parseable(schedule.cron) && !neverFires(schedule.cron) ? '2026-09-07T09:00:00-07:00' : undefined,
    prefill: { kind: 'claude', target: { worktreeId: 'wt-main' } },
    runsOnText: 'atlas · main worktree',
    onSet: (body: ScheduleSetBody) => { window.scheduleEmitted.push({ type: 'set', body }); setSchedule({ ...body, updatedAt: '2026-09-06T12:00:00-07:00' }); },
    onRemove: () => { window.scheduleEmitted.push({ type: 'remove' }); setSchedule(undefined); },
    preview: async (cron: string) => !parseable(cron)
      ? { next: [], error: `Invalid cron expression: ${cron}` }
      : neverFires(cron)
        ? { next: [] }
        : { next: ['2026-09-07T09:00:00-07:00', '2026-09-08T09:00:00-07:00', '2026-09-09T09:00:00-07:00'] },
    now: () => Date.parse('2026-09-06T12:00:00-07:00'),
  });
}

export const renderScheduleEditor = (root: HTMLElement, initial?: Schedule) => {
  window.scheduleEmitted = [];
  createRoot(root).render(createElement(Harness, { initial }));
};
