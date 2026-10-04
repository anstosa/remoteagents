// The AI Code review that can run beside a Review tour: its Findings, the dashboard's Review presets
// and the device's last choice. The shapes follow the server's Code review API; every guard
// tolerates extra fields, and a malformed payload reads as absent rather than throwing.

export type CodeReviewSeverity = 'high' | 'medium' | 'low';
export type CodeReviewAgent = 'codex' | 'claude';
// one Finding anchored to a tour Change: `side` and the lines follow ReviewDiffComment
// (`additions` = new-file line numbers, `deletions` = old-file line numbers); `id` is a stable digest
export type Finding = { id: string; changeId: string; side: 'additions' | 'deletions'; startLine: number; endLine: number; severity: CodeReviewSeverity; title: string; body: string };
// a Finding with no anchor in the tour's diffs (an unknown Change or lines outside its hunk)
export type GeneralFinding = { id: string; severity: CodeReviewSeverity; title: string; body: string; file?: string };
// a completed Code review of the tour's Comparison
export type CodeReview = { fingerprint: string; preset: { id: string; label: string; agent: CodeReviewAgent }; effort?: string; focus?: string; findings: Finding[]; general: GeneralFinding[]; completedAt: string };
// what one Code review run asks for: a preset id, an effort it accepts, and an optional extra focus
export type CodeReviewOptions = { preset: string; effort?: string; focus?: string };
// one Review preset as the dashboard lists it; an unavailable one says why
export type CodeReviewPreset = { id: string; label: string; agent: CodeReviewAgent; effort?: string; efforts: string[]; available: boolean; reason?: string };
// the dashboard's `codeReview`; an older server omits it
export type CodeReviewCapability = { defaultPreset: string; presets: CodeReviewPreset[] };

export const maxCodeReviewFocus = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const isSeverity = (value: unknown): value is CodeReviewSeverity => value === 'high' || value === 'medium' || value === 'low';
const isAgent = (value: unknown): value is CodeReviewAgent => value === 'codex' || value === 'claude';
const isLine = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

// validate one anchored Finding
export function isFinding(value: unknown): value is Finding {
  return isRecord(value) && typeof value.id === 'string' && typeof value.changeId === 'string' && (value.side === 'additions' || value.side === 'deletions')
    && isLine(value.startLine) && isLine(value.endLine) && value.startLine <= value.endLine && isSeverity(value.severity) && typeof value.title === 'string' && typeof value.body === 'string';
}

// validate one general Finding
export function isGeneralFinding(value: unknown): value is GeneralFinding {
  return isRecord(value) && typeof value.id === 'string' && isSeverity(value.severity) && typeof value.title === 'string' && typeof value.body === 'string' && optionalString(value.file);
}

// validate a completed Code review
export function isCodeReview(value: unknown): value is CodeReview {
  return isRecord(value) && typeof value.fingerprint === 'string' && typeof value.completedAt === 'string' && optionalString(value.effort) && optionalString(value.focus)
    && isRecord(value.preset) && typeof value.preset.id === 'string' && typeof value.preset.label === 'string' && isAgent(value.preset.agent)
    && Array.isArray(value.findings) && value.findings.every(isFinding) && Array.isArray(value.general) && value.general.every(isGeneralFinding);
}

// read one listed preset, dropping malformed efforts
function presetFrom(value: unknown): CodeReviewPreset | undefined {
  // require the identifying fields
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string' || !isAgent(value.agent) || typeof value.available !== 'boolean') return undefined;
  const efforts = Array.isArray(value.efforts) ? value.efforts.filter((effort): effort is string => typeof effort === 'string') : [];
  return { id: value.id, label: value.label, agent: value.agent, efforts, available: value.available, ...(typeof value.effort === 'string' ? { effort: value.effort } : {}), ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
}

// The dashboard's Code review capability, or undefined when absent, malformed or without presets
// (the start sheet then hides the AI review). Malformed presets are dropped one by one.
export function codeReviewCapability(value: unknown): CodeReviewCapability | undefined {
  // require the envelope
  if (!isRecord(value) || !Array.isArray(value.presets)) return undefined;
  const presets = value.presets.map(presetFrom).filter((preset): preset is CodeReviewPreset => preset !== undefined);
  // hide a capability with nothing to offer
  if (presets.length === 0) return undefined;
  return { defaultPreset: typeof value.defaultPreset === 'string' ? value.defaultPreset : presets[0]!.id, presets };
}

// The device's last Code review choice: the preset, and per preset the effort ('' = its default).
type CodeReviewChoice = { preset?: string; efforts: Record<string, string> };
const codeReviewChoiceKey = 'rac.code-review-choice';

// read the last choice, tolerating absent or malformed storage
export function readCodeReviewChoice(): CodeReviewChoice {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(codeReviewChoiceKey) ?? 'null');
    // ignore unreadable choices
    if (!isRecord(stored)) return { efforts: {} };
    const efforts = isRecord(stored.efforts) ? Object.fromEntries(Object.entries(stored.efforts).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    return { ...(typeof stored.preset === 'string' ? { preset: stored.preset } : {}), efforts };
  } catch { return { efforts: {} }; }
}

// remember the preset and its effort for the next start on this device
export function saveCodeReviewChoice(options: CodeReviewOptions): void {
  const current = readCodeReviewChoice();
  try { localStorage.setItem(codeReviewChoiceKey, JSON.stringify({ preset: options.preset, efforts: { ...current.efforts, [options.preset]: options.effort ?? '' } })); }
  catch { /* storage unavailable: the defaults apply next time */ }
}

// The preset a sheet opens on: the last one used if it is still available, else the default, else
// the first available one.
export function initialPreset(capability: CodeReviewCapability): CodeReviewPreset | undefined {
  const available = capability.presets.filter(preset => preset.available);
  const last = readCodeReviewChoice().preset;
  return available.find(preset => preset.id === last) ?? available.find(preset => preset.id === capability.defaultPreset) ?? available[0];
}

// The effort a preset opens on: the last one used with it if still accepted, else the preset's own
// effort, else '' (its default).
export function initialEffort(preset: CodeReviewPreset): string {
  const last = readCodeReviewChoice().efforts[preset.id];
  if (last !== undefined && (last === '' || preset.efforts.includes(last))) return last;
  return preset.effort !== undefined && preset.efforts.includes(preset.effort) ? preset.effort : '';
}
