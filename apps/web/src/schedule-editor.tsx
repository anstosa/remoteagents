import { useEffect, useRef, useState } from 'react';
import { agentKindGlyph, agentKindLabel, type AgentKind } from './launch-profile.js';

// The wire shape of a Schedule (mirrors the server's `Schedule`). `updatedAt` and
// `lastRun` are server-owned; the editor emits only the four fields the set route reads.
export type ScheduleTarget = { worktreeId: string } | { projectId: string } | { scratch: true };
export type ScheduleRunStatus = 'launched' | 'skipped' | 'failed';
export type ScheduleLastRun = { at: string; status: ScheduleRunStatus; detail?: string; agentId?: string };
export type Schedule = { cron: string; kind: AgentKind; target: ScheduleTarget; enabled: boolean; updatedAt?: string; lastRun?: ScheduleLastRun };
export type ScheduleSetBody = { cron: string; kind: AgentKind; target: ScheduleTarget; enabled: boolean };

export const defaultScheduleCron = '0 9 * * *';

// ---- pure preset / cron / copy helpers (no dashboard dependency) ----
// The presets the cadence popover offers; a stored expression that no preset reproduces
// falls back to `cron`, the raw-field display. `hour`/`minute` drive the time slot for the
// three time-of-day presets, `days` the weekly chips (Sunday = 0), `everyN` the interval.
export type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'everyN' | 'cron';
export type ScheduleEdit = { preset: SchedulePreset; hour: number; minute: number; days: number[]; everyN: number; cron: string };

const pad = (value: number) => String(value).padStart(2, '0');
// short weekday / month names for the "Mon 7 Sep" instant format
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 12-hour clock, so the sentence reads like a sentence
export const clock = (hour: number, minute: number) => `${((hour + 11) % 12) + 1}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
const hhmm = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
export const formatInstant = (iso: string) => { const date = new Date(iso); return `${WD[date.getDay()]} ${date.getDate()} ${MON[date.getMonth()]} ${clock(date.getHours(), date.getMinutes())}`; };
export const relativeAge = (iso: string, now: number) => {
  const seconds = (now - new Date(iso).getTime()) / 1000;
  if (seconds < 90) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

// ascending, de-duplicated weekday list, so a preset's cron is canonical
const sortedDays = (days: number[]) => Array.from(new Set(days)).filter(day => day >= 0 && day <= 6).sort((a, b) => a - b);
const dayNames = (days: number[]) => sortedDays(days).map(day => WD[day]).join(', ');
// the hours an "every N hours" schedule fires: N restarts at midnight, so the sequence is 0, N, 2N, … below 24
const everyNHours = (n: number) => { const hours: number[] = []; for (let hour = 0; hour < 24; hour += n) hours.push(hour); return hours; };
// those hours as comma-joined 12-hour clock times, shared by the slot label and the popover description
const everyNHoursText = (n: number) => everyNHours(n).map(hour => clock(hour, 0)).join(', ');
// N evenly tiles the day only when it divides 24; otherwise the last gap before midnight is short
const everyNDivides = (n: number) => 24 % n === 0;
const isNumericField = (value: string) => /^\d+$/u.test(value);

// A stored expression maps back to the preset that reproduces it exactly, else to the raw
// `cron` display — so re-opening the popover restores the controls that emitted the schedule.
export const cronToEdit = (cron: string): ScheduleEdit => {
  const normal = cron.trim().replace(/\s+/gu, ' ');
  const base: ScheduleEdit = { preset: 'cron', hour: 9, minute: 0, days: [1], everyN: 6, cron: normal };
  const fields = normal.split(' ');
  if (fields.length !== 5) return base;
  const [minute, hour, dom, month, dow] = fields;
  // every N hours: `0 */N * * *`
  const every = /^\*\/(\d+)$/u.exec(hour);
  if (minute === '0' && every !== null && dom === '*' && month === '*' && dow === '*') {
    const n = Number(every[1]);
    const candidate: ScheduleEdit = { ...base, preset: 'everyN', everyN: n };
    if (n >= 1 && n <= 23 && editToCron(candidate) === normal) return candidate;
  }
  if (dom !== '*' || month !== '*' || !isNumericField(minute) || !isNumericField(hour)) return base;
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) return base;
  if (dow === '*') return { ...base, preset: 'daily', hour: h, minute: m };
  if (dow === '1-5') return { ...base, preset: 'weekdays', hour: h, minute: m };
  // weekly: a comma list of single-digit days that our own emit would reproduce
  if (/^[0-6](,[0-6])*$/u.test(dow)) {
    const candidate: ScheduleEdit = { ...base, preset: 'weekly', hour: h, minute: m, days: dow.split(',').map(Number) };
    if (editToCron(candidate) === normal) return candidate;
  }
  return base;
};
export const editToCron = (edit: ScheduleEdit): string => {
  switch (edit.preset) {
    case 'daily': return `${edit.minute} ${edit.hour} * * *`;
    case 'weekdays': return `${edit.minute} ${edit.hour} * * 1-5`;
    case 'weekly': return `${edit.minute} ${edit.hour} * * ${sortedDays(edit.days).join(',')}`;
    case 'everyN': return `0 */${edit.everyN} * * *`;
    case 'cron': return edit.cron;
  }
};
// the three time-of-day presets carry a trailing "at <time>" slot; everyN and cron do not
export const presetHasTime = (preset: SchedulePreset) => preset === 'daily' || preset === 'weekdays' || preset === 'weekly';
// the tappable cadence-slot label — the sentence's reading of the cadence
export const cadenceLabel = (edit: ScheduleEdit): string => {
  switch (edit.preset) {
    case 'daily': return 'every day';
    case 'weekdays': return 'every weekday';
    case 'weekly': return `every ${dayNames(edit.days)}`;
    // a divisor tiles the day evenly; otherwise spell out the hours so the midnight restart is not a surprise
    case 'everyN': return everyNDivides(edit.everyN) ? `every ${edit.everyN} h` : `at ${everyNHoursText(edit.everyN)} (restarts at midnight)`;
    case 'cron': return `on cron ${edit.cron}`;
  }
};
// the popover description line
export const describeCadence = (edit: ScheduleEdit): string => {
  switch (edit.preset) {
    case 'daily': return `Every day at ${clock(edit.hour, edit.minute)}`;
    case 'weekdays': return `Every weekday at ${clock(edit.hour, edit.minute)}`;
    case 'weekly': return `Every ${dayNames(edit.days)} at ${clock(edit.hour, edit.minute)}`;
    case 'everyN': return everyNDivides(edit.everyN) ? `Every ${edit.everyN} hours, on the hour` : `Fires ${everyNHoursText(edit.everyN)}; the count restarts at midnight`;
    case 'cron': return `Cron ${edit.cron}`;
  }
};

// The one place the "a scheduled note the server gave no nextRun to won't run" rule lives, shared
// by the editor and the fly-out badge. The server omits nextRun when the stored cron no longer
// parses or never matches a date (a valid, matchable 5-field expression always has a next instant).
export const scheduleInvalid = (note: { schedule?: unknown; nextRun?: string }) => note.schedule !== undefined && note.nextRun === undefined;

type ScheduleEditorProps = {
  schedule?: Schedule;
  nextRun?: string;
  prefill: { kind: AgentKind; target: ScheduleTarget };
  runsOnText: string;
  onSet: (body: ScheduleSetBody) => void | Promise<void>;
  onRemove: () => void | Promise<void>;
  // the server owns the clock and the parser, so the preview returns both the next instants and,
  // for an unparseable expression, the parser's message the raw-cron field shows inline
  preview: (cron: string) => Promise<{ next: string[]; error?: string }>;
  busy?: boolean;
  now?: () => number;
};

const KindMark = ({ kind }: { kind: AgentKind }) => <span className={`schedule-kind-mark launch-kind-${kind}`} aria-hidden="true">{agentKindGlyph[kind]}</span>;

// The note-pane Schedule editor: variant C, the sentence with tappable slots, on two
// lines. Every change applies immediately by emitting the full set body; kind and
// target render read-only for now (their pickers arrive in a later ticket).
export function ScheduleEditor({ schedule, nextRun, prefill, runsOnText, onSet, onRemove, preview, busy = false, now = Date.now }: ScheduleEditorProps) {
  const [openSlot, setOpenSlot] = useState<'cadence' | 'time' | null>(null);
  const [previewRuns, setPreviewRuns] = useState<string[]>([]);
  const [cronDraft, setCronDraft] = useState(() => schedule?.cron ?? defaultScheduleCron);
  const [cronFieldError, setCronFieldError] = useState<string | undefined>(undefined);
  // The preset is normally derived from the stored cron, but choosing "Cron" is a mode the
  // string cannot express (an expression that also matches a preset would re-derive to it), so
  // raw editing is held here and reset whenever the cadence popover closes — a reopen re-derives.
  const [rawCron, setRawCron] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cron = schedule?.cron ?? defaultScheduleCron;
  const derived = cronToEdit(cron);
  const edit: ScheduleEdit = rawCron ? { ...derived, preset: 'cron' } : derived;
  const kind = schedule?.kind ?? prefill.kind;
  const invalid = scheduleInvalid({ schedule, nextRun });

  // close the open popover on an outside click or Escape
  useEffect(() => {
    if (openSlot === null) return;
    const dismiss = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpenSlot(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenSlot(null); };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', key); };
  }, [openSlot]);

  // fetch the next-three preview from the server while a popover is open
  useEffect(() => {
    if (openSlot === null) { setPreviewRuns([]); return; }
    let live = true;
    void preview(cron).then(result => { if (live) setPreviewRuns(result.next); }, () => { if (live) setPreviewRuns([]); });
    return () => { live = false; };
  }, [openSlot, cron, preview]);

  // Keep the raw-cron field honest across opens, closes and commits. A rejected edit changes
  // neither `openSlot` nor `cron`, so its inline error survives (the value is kept); but any
  // open/close or a committed expression clears the error, an open (re)syncs the draft to the
  // stored expression, and a close drops raw-editing mode so a reopen re-derives the preset.
  useEffect(() => {
    setCronFieldError(undefined);
    if (openSlot === 'cadence') setCronDraft(cron);
    else setRawCron(false);
  }, [openSlot, cron]);

  const apply = (next: ScheduleSetBody) => { void onSet(next); };
  const applyEdit = (nextEdit: ScheduleEdit) => { if (schedule === undefined) return; apply({ cron: editToCron(nextEdit), kind: schedule.kind, target: schedule.target, enabled: schedule.enabled }); };
  // choose a cadence preset: Cron just enters raw-editing mode (the expression is unchanged until
  // the field is applied); every other preset leaves raw mode and emits its canonical expression.
  // Clear the raw field here too, since a preset whose cron equals the stored one won't change the
  // `cron` prop and so won't trip the reset effect, leaving a rejected draft to resurface later.
  const selectPreset = (preset: SchedulePreset) => {
    if (preset === 'cron') { setRawCron(true); return; }
    setRawCron(false);
    setCronDraft(cron);
    setCronFieldError(undefined);
    applyEdit({ ...edit, preset });
  };
  // toggle a weekly day chip, keeping at least one day selected so the emitted cron is always valid
  const toggleDay = (day: number) => {
    const current = sortedDays(edit.days);
    const next = current.includes(day) ? current.filter(other => other !== day) : [...current, day];
    if (next.length > 0) applyEdit({ ...edit, preset: 'weekly', days: next });
  };
  // validate the raw-cron draft against the server; on an error keep the previous expression and show it inline
  const applyCron = async () => {
    if (schedule === undefined) return;
    const value = cronDraft.trim();
    if (value === cron) { setCronFieldError(undefined); return; }
    if (value === '') { setCronFieldError('Enter a cron expression'); return; }
    const result = await preview(value);
    if (result.error !== undefined) { setCronFieldError(result.error); return; }
    // a parseable expression that never matches a date (e.g. `0 0 31 2 *`) previews empty; refuse it
    // rather than commit a schedule that would immediately read as invalid
    if (result.next.length === 0) { setCronFieldError('This expression never runs'); return; }
    setCronFieldError(undefined);
    apply({ cron: value, kind: schedule.kind, target: schedule.target, enabled: schedule.enabled });
  };

  if (schedule === undefined) {
    return (
      <div className="schedule-sentence schedule-unscheduled" role="group" aria-label="Schedule" ref={rootRef}>
        <p className="schedule-line">
          <span>Not scheduled.</span>
          <button type="button" className="schedule-create" disabled={busy} onClick={() => apply({ cron: defaultScheduleCron, kind: prefill.kind, target: prefill.target, enabled: true })}>
            <ClockGlyph />Schedule this note
          </button>
        </p>
        <p className="schedule-hint">Starts as every day at 9:00 AM on <b>{runsOnText}</b>; tap any part of the sentence to change it.</p>
      </div>
    );
  }

  const enabled = schedule.enabled;
  const lastRun = schedule.lastRun;
  return (
    <div className={`schedule-sentence${invalid ? ' schedule-invalid' : ''}`} role="group" aria-label="Schedule" ref={rootRef}>
      <p className="schedule-line">
        <button type="button" className={`schedule-slot schedule-onoff${enabled ? '' : ' off'}`} role="switch" aria-checked={enabled} aria-label="Schedule enabled" disabled={busy} onClick={() => apply({ cron, kind: schedule.kind, target: schedule.target, enabled: !enabled })}>{enabled ? '● Runs' : '○ Paused'}</button>
        <button type="button" className="schedule-slot" aria-label="Cadence" aria-expanded={openSlot === 'cadence'} disabled={busy} onClick={() => setOpenSlot(current => current === 'cadence' ? null : 'cadence')}>{cadenceLabel(edit)}</button>
        {presetHasTime(edit.preset) && <>
          <span>at</span>
          <button type="button" className="schedule-slot" aria-label="Time" aria-expanded={openSlot === 'time'} disabled={busy} onClick={() => setOpenSlot(current => current === 'time' ? null : 'time')}>{clock(edit.hour, edit.minute)}</button>
        </>}
      </p>
      <p className="schedule-line">
        <span>with</span>
        <span className="schedule-slot schedule-slot-static"><KindMark kind={kind} />{agentKindLabel[kind]}</span>
        <span>on</span>
        <span className="schedule-slot schedule-slot-static">{runsOnText}</span>
      </p>
      {invalid && <p className="schedule-invalid-note" role="alert">This schedule won’t run — its cron can’t be read or never matches a date. Edit it under Cadence or remove it.</p>}
      <div className="schedule-meta">
        <p className={`schedule-next${enabled ? '' : ' paused'}`}>{nextRun === undefined ? 'Won’t run — invalid cron' : enabled ? <>Next <b>{formatInstant(nextRun)}</b></> : <>Paused · would next run <b>{formatInstant(nextRun)}</b></>}</p>
        <p className={`schedule-last${lastRun && lastRun.status !== 'launched' ? ' bad' : ''}`}>{lastRun === undefined ? 'Not run yet' : <>Last run {relativeAge(lastRun.at, now())} · <b>{lastRun.status}</b>{lastRun.detail ? `, ${lastRun.detail}` : ''}</>}</p>
      </div>
      <div className="schedule-foot">
        <button type="button" className="schedule-remove" disabled={busy} onClick={() => void onRemove()}>Remove schedule</button>
      </div>
      {openSlot === 'cadence' && (
        <div className="schedule-popover" role="dialog" aria-label="Cadence">
          <p className="schedule-popover-title">Cadence</p>
          <div className="schedule-presets" role="group" aria-label="Cadence preset">
            <button type="button" aria-pressed={edit.preset === 'daily'} onClick={() => selectPreset('daily')}>Daily at</button>
            <button type="button" aria-pressed={edit.preset === 'weekdays'} onClick={() => selectPreset('weekdays')}>Weekdays at</button>
            <button type="button" aria-pressed={edit.preset === 'weekly'} onClick={() => selectPreset('weekly')}>Weekly on</button>
            <button type="button" aria-pressed={edit.preset === 'everyN'} onClick={() => selectPreset('everyN')}>Every N hours</button>
            <button type="button" aria-pressed={edit.preset === 'cron'} onClick={() => selectPreset('cron')}>Cron</button>
          </div>
          {edit.preset === 'weekly' && (
            <div className="schedule-days" role="group" aria-label="Days">
              {WD.map((name, day) => <button key={day} type="button" aria-pressed={sortedDays(edit.days).includes(day)} aria-label={WD_FULL[day]} onClick={() => toggleDay(day)}>{name.charAt(0)}</button>)}
            </div>
          )}
          {edit.preset === 'everyN' && (
            <div className="schedule-stepper" role="group" aria-label="Hours between runs">
              <button type="button" aria-label="Fewer hours" disabled={edit.everyN <= 1} onClick={() => applyEdit({ ...edit, preset: 'everyN', everyN: edit.everyN - 1 })}>−</button>
              <span className="schedule-stepper-value">{edit.everyN} h</span>
              <button type="button" aria-label="More hours" disabled={edit.everyN >= 23} onClick={() => applyEdit({ ...edit, preset: 'everyN', everyN: edit.everyN + 1 })}>+</button>
            </div>
          )}
          {edit.preset === 'cron' && (
            <form className="schedule-cron-field" onSubmit={event => { event.preventDefault(); void applyCron(); }}>
              <input aria-label="Cron expression" value={cronDraft} spellCheck={false} autoCapitalize="none" autoCorrect="off" maxLength={200} onChange={event => setCronDraft(event.target.value)} onBlur={() => void applyCron()} />
              {cronFieldError !== undefined && <p className="schedule-cron-error" role="alert">{cronFieldError}</p>}
            </form>
          )}
          <p className="schedule-describe">{describeCadence(edit)}</p>
          {previewRuns.length > 0 && <p className="schedule-preview">Next <b>{previewRuns.map(formatInstant).join(' · ')}</b></p>}
        </div>
      )}
      {openSlot === 'time' && (
        <div className="schedule-popover" role="dialog" aria-label="Time">
          <input type="time" aria-label="Set time" value={hhmm(edit.hour, edit.minute)} step={60} onChange={event => { const [hour, minute] = event.target.value.split(':').map(Number); if (Number.isFinite(hour) && Number.isFinite(minute)) applyEdit({ ...edit, hour, minute }); }} />
          <p className="schedule-describe">{describeCadence(edit)}</p>
          {previewRuns.length > 0 && <p className="schedule-preview">Next <b>{previewRuns.map(formatInstant).join(' · ')}</b></p>}
        </div>
      )}
    </div>
  );
}

const ClockGlyph = () => <svg className="schedule-clock" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
