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
// only Daily is offered now; a non-daily stored expression falls back to a raw `cron` display
export type SchedulePreset = 'daily' | 'cron';
export type ScheduleEdit = { preset: SchedulePreset; hour: number; minute: number; cron: string };

const pad = (value: number) => String(value).padStart(2, '0');
// short weekday / month names for the "Mon 7 Sep" instant format
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

// Only the Daily cadence is offered for now; any other stored expression is displayed
// as a raw cron so a Schedule set by a later cadence still reads correctly here.
export const cronToEdit = (cron: string): ScheduleEdit => {
  const fields = cron.trim().split(/\s+/);
  const base: ScheduleEdit = { preset: 'cron', hour: 9, minute: 0, cron };
  if (fields.length === 5) {
    const [minute, hour, dom, month, dow] = fields;
    if (dom === '*' && month === '*' && dow === '*' && /^\d+$/u.test(minute) && /^\d+$/u.test(hour)) return { ...base, preset: 'daily', hour: Number(hour), minute: Number(minute) };
  }
  return base;
};
export const editToCron = (edit: ScheduleEdit): string => edit.preset === 'daily' ? `${edit.minute} ${edit.hour} * * *` : edit.cron;
// the tappable cadence-slot label
export const cadenceLabel = (edit: ScheduleEdit) => edit.preset === 'daily' ? 'every day' : `on cron ${edit.cron}`;
// the popover description line
export const describeCadence = (edit: ScheduleEdit) => edit.preset === 'daily' ? `Every day at ${clock(edit.hour, edit.minute)}` : `Cron ${edit.cron}`;

type ScheduleEditorProps = {
  schedule?: Schedule;
  nextRun?: string;
  prefill: { kind: AgentKind; target: ScheduleTarget };
  runsOnText: string;
  onSet: (body: ScheduleSetBody) => void | Promise<void>;
  onRemove: () => void | Promise<void>;
  preview: (cron: string) => Promise<string[]>;
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cron = schedule?.cron ?? defaultScheduleCron;
  const edit = cronToEdit(cron);
  const kind = schedule?.kind ?? prefill.kind;

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
    void preview(cron).then(runs => { if (live) setPreviewRuns(runs); }, () => { if (live) setPreviewRuns([]); });
    return () => { live = false; };
  }, [openSlot, cron, preview]);

  const apply = (next: ScheduleSetBody) => { void onSet(next); };
  const applyEdit = (nextEdit: ScheduleEdit) => { if (schedule === undefined) return; apply({ cron: editToCron(nextEdit), kind: schedule.kind, target: schedule.target, enabled: schedule.enabled }); };

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
    <div className="schedule-sentence" role="group" aria-label="Schedule" ref={rootRef}>
      <p className="schedule-line">
        <button type="button" className={`schedule-slot schedule-onoff${enabled ? '' : ' off'}`} role="switch" aria-checked={enabled} aria-label="Schedule enabled" disabled={busy} onClick={() => apply({ cron, kind: schedule.kind, target: schedule.target, enabled: !enabled })}>{enabled ? '● Runs' : '○ Paused'}</button>
        <button type="button" className="schedule-slot" aria-label="Cadence" aria-expanded={openSlot === 'cadence'} disabled={busy} onClick={() => setOpenSlot(current => current === 'cadence' ? null : 'cadence')}>{cadenceLabel(edit)}</button>
        <span>at</span>
        <button type="button" className="schedule-slot" aria-label="Time" aria-expanded={openSlot === 'time'} disabled={busy || edit.preset !== 'daily'} onClick={() => setOpenSlot(current => current === 'time' ? null : 'time')}>{clock(edit.hour, edit.minute)}</button>
      </p>
      <p className="schedule-line">
        <span>with</span>
        <span className="schedule-slot schedule-slot-static"><KindMark kind={kind} />{agentKindLabel[kind]}</span>
        <span>on</span>
        <span className="schedule-slot schedule-slot-static">{runsOnText}</span>
      </p>
      <div className="schedule-meta">
        <p className={`schedule-next${enabled ? '' : ' paused'}`}>{nextRun === undefined ? 'No upcoming run' : enabled ? <>Next <b>{formatInstant(nextRun)}</b></> : <>Paused · would next run <b>{formatInstant(nextRun)}</b></>}</p>
        <p className={`schedule-last${lastRun && lastRun.status !== 'launched' ? ' bad' : ''}`}>{lastRun === undefined ? 'Not run yet' : <>Last run {relativeAge(lastRun.at, now())} · <b>{lastRun.status}</b>{lastRun.detail ? `, ${lastRun.detail}` : ''}</>}</p>
      </div>
      <div className="schedule-foot">
        <button type="button" className="schedule-remove" disabled={busy} onClick={() => void onRemove()}>Remove schedule</button>
      </div>
      {openSlot === 'cadence' && (
        <div className="schedule-popover" role="dialog" aria-label="Cadence">
          <p className="schedule-popover-title">Cadence</p>
          <div className="schedule-presets" role="group" aria-label="Cadence preset">
            <button type="button" aria-pressed={edit.preset === 'daily'} onClick={() => applyEdit({ ...edit, preset: 'daily' })}>Daily at</button>
          </div>
          <p className="schedule-describe">{describeCadence(edit)}</p>
          {previewRuns.length > 0 && <p className="schedule-preview">Next <b>{previewRuns.map(formatInstant).join(' · ')}</b></p>}
        </div>
      )}
      {openSlot === 'time' && (
        <div className="schedule-popover" role="dialog" aria-label="Time">
          <input type="time" aria-label="Set time" value={hhmm(edit.hour, edit.minute)} step={60} onChange={event => { const [hour, minute] = event.target.value.split(':').map(Number); if (Number.isFinite(hour) && Number.isFinite(minute)) applyEdit({ ...edit, preset: 'daily', hour, minute }); }} />
          <p className="schedule-describe">{describeCadence(edit)}</p>
          {previewRuns.length > 0 && <p className="schedule-preview">Next <b>{previewRuns.map(formatInstant).join(' · ')}</b></p>}
        </div>
      )}
    </div>
  );
}

const ClockGlyph = () => <svg className="schedule-clock" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
