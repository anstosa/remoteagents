import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { eventChord, isTableBinding, isTerminalBinding, keyActions, lookupKeyBinding, resolveKeyTables, type KeyBinding, type KeyRow, type KeysConfig, type ResolvedKeyTables } from '../../server/src/config/keys.js';
import { createKeyDispatcher, type KeyDispatchState } from './key-dispatch.js';
import { resolveShortcutTables, reconcileShortcutOverrides, shortcutOrigin, shortcutKeys, shortcutLabel, shortcutCommands, editShortcutOverrides, validateShortcutOverrides, type ShortcutOverrides, type ShortcutCommand, type ShortcutEdit } from './shortcut-config.js';
import { resetTerminalFontSize, stepTerminalFontSize } from './terminal-font-size.js';

// What a handler hears about the key that ran it; undefined when the palette runs it.
export type KeyActionContext = { table: string; chord: string; binding: KeyBinding };
// A handler returns false when its action does not apply right now (copy with nothing selected),
// so a root key passes through to the focused control untouched.
export type KeyActionHandler = (event: KeyboardEvent | undefined, context: KeyActionContext | undefined) => boolean | void;
// the action a `{ terminal }` binding runs; its handler asks the server to open the binding's Terminal
export const terminalBindingAction = 'open-terminal-binding';

export const shortcutStorageKey = 'rac.keyboard-shortcuts';
// tolerate unavailable or malformed browser storage
const readShortcuts = (): { choices: ShortcutOverrides; error?: string } => {
  try { return { choices: validateShortcutOverrides(JSON.parse(localStorage.getItem(shortcutStorageKey) ?? '{}')) }; }
  catch { return { choices: {}, error: 'Saved shortcuts could not be loaded. Defaults are active; reset all shortcuts to clear the saved preferences.' }; }
};
let configured: KeysConfig | undefined;
let baseTables = resolveKeyTables(undefined);
const initialShortcuts = readShortcuts();
let savedShortcuts = initialShortcuts.choices;
let shortcutLoadError = initialShortcuts.error;
const initialReconciliation = reconcileShortcutOverrides(baseTables, savedShortcuts);
let shortcuts = initialReconciliation.overrides;
// preserve conflicting choices while explaining why their keys do not run
const conflictWarning = (conflicts: string[]) => conflicts.length > 0 ? `Conflicting shortcuts are ignored until resolved: ${conflicts.map(conflict => conflict.replace(/^root\./u, '')).join(', ')}. Edit or remove a shared shortcut to resolve the conflict.` : undefined;
let shortcutWarning = shortcutLoadError ?? conflictWarning(initialReconciliation.conflicts);
let tables = resolveShortcutTables(baseTables, shortcuts);
let tablesRevision = 0;
const tableListeners = new Set<() => void>();
// refresh dispatch and every mounted shortcut surface together
const refreshTables = () => {
  const reconciled = reconcileShortcutOverrides(baseTables, savedShortcuts);
  shortcuts = reconciled.overrides;
  shortcutWarning = shortcutLoadError ?? conflictWarning(reconciled.conflicts);
  tables = resolveShortcutTables(baseTables, shortcuts);
  dispatcher.reset();
  clearKeyPress();
  tablesRevision += 1;
  tableListeners.forEach(listener => listener());
};
// adopt the operator's tables while retaining this browser's choices
export const setKeysConfig = (keys: KeysConfig | undefined) => {
  // skip identical dashboard updates
  if (JSON.stringify(keys) === JSON.stringify(configured)) return;
  configured = keys;
  baseTables = resolveKeyTables(keys);
  refreshTables();
};
// subscribe both the reference and the settings editor to live bindings
const useKeyTables = () => {
  useSyncExternalStore(listener => { tableListeners.add(listener); return () => { tableListeners.delete(listener); }; }, () => tablesRevision);
  return tables;
};
// expose original binding identities for the per-browser editor
export const useShortcutSettings = () => {
  useKeyTables();
  return { commands: shortcutCommands(baseTables, shortcuts), warning: shortcutWarning, hasSavedShortcuts: Object.keys(savedShortcuts).length > 0 || shortcutWarning !== undefined };
};
// persist overrides only after storage succeeds so saving never silently fails
const saveShortcuts = (next: ShortcutOverrides): string | undefined => {
  try {
    // an empty preference follows future server defaults
    if (Object.keys(next).length === 0) localStorage.removeItem(shortcutStorageKey);
    else localStorage.setItem(shortcutStorageKey, JSON.stringify(next));
  } catch { return 'Could not save shortcuts in this browser. Check browser storage permissions.'; }
  savedShortcuts = next;
  shortcutLoadError = undefined;
  refreshTables();
};
// persist one validated command edit without changing its server authorization
const editShortcutCommand = (id: string, edit: ShortcutEdit): string | undefined => {
  const result = editShortcutOverrides(baseTables, shortcuts, id, edit);
  // keep validation errors free of internal names for direct bindings
  if (result.error !== undefined) return result.error.replace(/\broot\b/gu, 'non-prefixed');
  return saveShortcuts(result.overrides!);
};
// restore the operator's current configuration and the built-in defaults
export const resetShortcuts = () => saveShortcuts({});
// follow changes made by another tab of this browser
window.addEventListener('storage', event => {
  // ignore unrelated browser preferences
  if (event.key !== null && event.key !== shortcutStorageKey) return;
  const stored = readShortcuts();
  savedShortcuts = stored.choices;
  shortcutLoadError = stored.error;
  refreshTables();
});
// use the operating system's familiar modifier name
const platform = navigator.platform || navigator.userAgent;
// separate simultaneous keys without putting the plus sign inside a keycap
function KeyCaps({ keys }: { keys: string[] }) {
  return <span className="shortcut-keys" aria-label={keys.join(' + ')}>{keys.map((key, index) => <Fragment key={`${index}:${key}`}>{index > 0 && <span className="shortcut-key-separator" aria-hidden="true"> + </span>}<kbd>{key}</kbd></Fragment>)}</span>;
}
// render each physical key with its own outline
export const ShortcutKeys = ({ chord }: { chord: string }) => <KeyCaps keys={shortcutKeys(chord, platform)} />;
// share readable labels with editor controls and the command palette
export const readableShortcut = (chord: string) => shortcutLabel(chord, platform);

type KeyPressFeedback = { chords: string[][]; matched: boolean; expiresAt: number; target: Element | null };
let keyPressFeedback: KeyPressFeedback | undefined;
let keyPressTimer: ReturnType<typeof setTimeout> | undefined;
let keyPressMatched = false;
const keyPressListeners = new Set<() => void>();
// publish transient shortcut feedback without persisting input
const publishKeyPress = (next: KeyPressFeedback | undefined) => {
  keyPressFeedback = next;
  keyPressListeners.forEach(listener => listener());
};
// clear transient feedback when its deadline or keyboard listener ends
const clearKeyPress = () => {
  clearTimeout(keyPressTimer);
  publishKeyPress(undefined);
};
// hide ordinary typing and native control navigation, including terminal output mode
const inputOwnsKey = (target: Element | null) => target?.closest('input, textarea, select, [role="textbox"], [role="combobox"], [role="menu"], [role="listbox"], .xterm, .prompt, .note-pane.editing') != null || target instanceof HTMLElement && target.isContentEditable;
// preserve the entire leader chain until its command finishes and fades together
const showKeyPress = (event: KeyboardEvent, chord: string | undefined, previous: KeyDispatchState | undefined, matched: boolean, previousFeedback: KeyPressFeedback | undefined) => {
  const target = keyTarget(event);
  const binding = chord === undefined ? undefined : lookupKeyBinding(tables, previous?.table ?? 'root', chord);
  const continuing = previous !== undefined && (previous.confirm !== undefined || !previous.repeat || typeof binding === 'string' && keyActions[binding]?.repeat === true);
  // password characters stay private even when a binding consumes the key
  if (target instanceof HTMLInputElement && target.type === 'password') { clearKeyPress(); return; }
  // composition is private input, never a shortcut attempt
  if (event.isComposing) { clearKeyPress(); return; }
  // bare modifiers are not bindings and never replace a pending leader
  if (chord === undefined) return;
  // ordinary field editing stays silent even when a newline has a configured binding
  if (!continuing && inputOwnsKey(target) && (!matched || binding === 'prompt-newline')) { clearKeyPress(); return; }
  const keys = shortcutKeys(chord, platform);
  const trail = continuing ? previousFeedback?.chords ?? [] : [];
  const priorChords = previous?.table !== undefined && previous.repeat ? trail.slice(0, -1) : trail;
  const state = dispatcher.state();
  const pending = state !== undefined && (state.confirm !== undefined || !state.repeat);
  const expiresAt = pending ? state.expiresAt : Date.now() + 1500;
  clearTimeout(keyPressTimer);
  publishKeyPress({ chords: [...priorChords, keys], matched, expiresAt, target });
  keyPressTimer = setTimeout(clearKeyPress, Math.max(0, expiresAt - Date.now()));
};
// share key feedback with the floating indicator without rerendering the app
const useKeyPress = () => useSyncExternalStore(listener => { keyPressListeners.add(listener); return () => { keyPressListeners.delete(listener); }; }, () => keyPressFeedback);

// Handlers per action, newest first: the first that does not decline handles the key.
const handlers = new Map<string, KeyActionHandler[]>();
export const registerKeyAction = (name: string, handler: KeyActionHandler) => {
  handlers.set(name, [handler, ...(handlers.get(name) ?? [])]);
  return () => { handlers.set(name, (handlers.get(name) ?? []).filter(candidate => candidate !== handler)); };
};
export const runKeyAction = (name: string, event?: KeyboardEvent, context?: KeyActionContext): boolean => {
  for (const handler of handlers.get(name) ?? []) if (handler(event, context) !== false) return true;
  return false;
};
// register a component's handlers for as long as it is mounted, always calling its latest render's
export function useKeyActions(actions: Record<string, KeyActionHandler>) {
  const latest = useRef(actions);
  latest.current = actions;
  const names = Object.keys(actions).join('\n');
  useEffect(() => {
    // a handler that returns nothing handled the key; only an explicit false declines it
    const unregister = names.split('\n').map(name => registerKeyAction(name, (event, context) => latest.current[name] === undefined ? false : latest.current[name]!(event, context)));
    return () => unregister.forEach(release => release());
  }, [names]);
}
export const useKeyAction = (name: string, handler: KeyActionHandler) => useKeyActions({ [name]: handler });

const dispatcher = createKeyDispatcher<KeyboardEvent>({
  tables: () => tables,
  // distinguish successful dispatch from an inapplicable root binding
  onMatch: () => { keyPressMatched = true; },
  // retain the server binding identity when a terminal shortcut is remapped
  run: (binding, { table, chord, event }) => runKeyAction(typeof binding === 'string' ? binding : terminalBindingAction, event, { ...shortcutOrigin(baseTables, shortcuts, table, chord), binding })
});
// ask a y/n question in the indicator; the next key answers it
export const confirmKey = (message: string, onYes: () => void) => dispatcher.confirm(message, onYes);

// the element a key really went to, through any shadow root (the Code panel's diffs)
export const keyTarget = (event: KeyboardEvent | undefined): Element | null => {
  const target = event?.composedPath()[0] ?? document.activeElement;
  return target instanceof Element ? target : null;
};
// whether a key goes to a text field other than a terminal's own input, where it is typing; an
// action the palette runs has no key, so it is never typing
export const typingOutsideTerminal = (event: KeyboardEvent | undefined): boolean => {
  if (event === undefined) return false;
  const target = keyTarget(event);
  const editable = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
  return editable && target.closest('.xterm') === null;
};

// The one keydown listener for app shortcuts. It runs first (window, capture phase) and swallows
// only the keys the dispatcher handles; every other key reaches xterm, the composer or the control.
const onKeyDown = (event: KeyboardEvent) => {
  const chord = eventChord(event);
  // let the recorder hear shortcuts without executing or illustrating them
  if (keyTarget(event)?.closest('[data-shortcut-recorder]') != null) { dispatcher.reset(); clearKeyPress(); return; }
  // modal controls own their keys without workspace feedback behind them
  if (document.querySelector('[aria-modal="true"]') !== null) {
    dispatcher.reset();
    clearKeyPress();
    // keep the quick reference's own toggle available
    if (overlay === 'bindings' && chord !== undefined && lookupKeyBinding(tables, 'root', chord) === 'show-bindings') {
      event.preventDefault();
      event.stopImmediatePropagation();
      setOverlay(undefined);
    }
    return;
  }
  const previous = dispatcher.state();
  const previousFeedback = keyPressFeedback;
  // holding the leader neither sends it on nor duplicates its keycaps
  const held = event.repeat && chord !== undefined && chord === previous?.chord;
  keyPressMatched = false;
  const result = held ? 'handled' : dispatcher.handle(chord, event);
  // publish consumed shortcuts only while the action has not opened a modal
  if (!held && overlay === undefined) showKeyPress(event, chord, previous, keyPressMatched && result !== 'pass', previousFeedback);
  // send-prefix reaches a terminal only; elsewhere the browser would act on it
  if (result === 'pass' || (result === 'send' && keyTarget(event)?.closest('.xterm') != null)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};
let installed = 0;
const installKeyboard = () => {
  // install one shared capture listener across dashboard mounts
  if (installed++ === 0) window.addEventListener('keydown', onKeyDown, true);
  // release transient state when the final keyboard layer unmounts
  return () => { if (--installed === 0) { window.removeEventListener('keydown', onKeyDown, true); dispatcher.reset(); clearKeyPress(); } };
};

// The overlays the keyboard opens, outside any one Workspace.
type KeyboardOverlay = 'bindings' | 'palette' | undefined;
let overlay: KeyboardOverlay;
const overlayListeners = new Set<() => void>();
// modal entry cancels any leader before a recorder or picker can own focus
const setOverlay = (next: KeyboardOverlay) => {
  // mouse-opened overlays must also release the pending table
  if (next !== undefined) { dispatcher.reset(); clearKeyPress(); }
  overlay = next;
  overlayListeners.forEach(listener => listener());
};
export const openBindingsSheet = () => setOverlay('bindings');
const useOverlay = () => useSyncExternalStore(listener => { overlayListeners.add(listener); return () => { overlayListeners.delete(listener); }; }, () => overlay);

registerKeyAction('show-bindings', () => setOverlay(overlay === 'bindings' ? undefined : 'bindings'));
registerKeyAction('command-palette', () => setOverlay('palette'));
// font size steps while a terminal shows, from anywhere but a text field; otherwise the browser
// zooms the page as it always has
const fontKeyDeclines = (event: KeyboardEvent | undefined) => document.querySelector('.xterm') === null || typingOutsideTerminal(event);
registerKeyAction('font-larger', event => { if (fontKeyDeclines(event)) return false; stepTerminalFontSize(1); });
registerKeyAction('font-smaller', event => { if (fontKeyDeclines(event)) return false; stepTerminalFontSize(-1); });
registerKeyAction('font-reset', event => { if (fontKeyDeclines(event)) return false; resetTerminalFontSize(); });

// how a binding reads in the sheet and the palette
export const describeBinding = (binding: KeyBinding): string => typeof binding === 'string'
  ? keyActions[binding]?.description ?? binding
  : isTableBinding(binding) ? `Switch to the ${binding.table} table` : `Terminal running ${binding.terminal}${binding.reuse === true ? ' (reused)' : ''}`;
const sourceLabel: Record<KeyRow['source'], string> = { default: 'Default', config: 'Config', replaced: 'Config, replaces the default', removed: 'Default, removed by config' };
export type KeyPickerOption = { id: string; label: string; detail?: string; nested?: boolean; current?: boolean; onSelect: () => void };
// A filterable list in a dialog: type to filter, arrows to move, Enter to choose, Escape to close.
// Closing hands focus back to where it was before the choice runs, so a choice can move it on.
export function KeyPicker({ title, options, onClose, placeholder = 'Filter' }: { title: string; options: readonly KeyPickerOption[]; onClose: () => void; placeholder?: string }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(() => Math.max(0, options.findIndex(option => option.current === true)));
  const returnFocus = useRef(document.activeElement);
  const listRef = useRef<HTMLUListElement | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = needle === '' ? options : options.filter(option => `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(needle));
  const active = Math.min(index, shown.length - 1);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const close = () => {
    onClose();
    if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus({ preventScroll: true });
  };
  const choose = (option: KeyPickerOption | undefined) => {
    if (option === undefined) return;
    close();
    option.onSelect();
  };
  const keyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((active + 1) % Math.max(1, shown.length)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((active - 1 + shown.length) % Math.max(1, shown.length)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(shown[active]); }
  };
  return createPortal(<div className="dialog key-picker-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={keyDown} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div>
    <input className="key-picker-filter" autoFocus aria-label={`${title} filter`} placeholder={placeholder} value={query} role="combobox" aria-expanded="true" aria-controls="key-picker-list" aria-activedescendant={shown[active] === undefined ? undefined : `key-picker-${active}`} onChange={event => { setQuery(event.target.value); setIndex(0); }} />
    <ul ref={listRef} id="key-picker-list" className="key-picker-list" role="listbox" aria-label={title}>
      {shown.map((option, position) => <li key={option.id} id={`key-picker-${position}`} role="option" aria-selected={position === active} className={`${option.nested ? 'nested' : ''}${option.current ? ' current' : ''}`} onMouseMove={() => setIndex(position)} onClick={() => choose(option)}><span>{option.label}</span>{option.detail !== undefined && <small>{option.detail}</small>}</li>)}
      {shown.length === 0 && <li className="key-picker-empty" role="presentation">No matches</li>}
    </ul>
  </div></div>, document.body);
}

// identify every command origin even when all of its shortcuts are disabled
const commandOrigins = (command: ShortcutCommand): string => command.origins.map(origin => `${origin.table}:${origin.chord}`).join(' ');
// direct shortcuts need no internal table label
const assignmentLabel = (table: string, chord: string): string => `${table === 'root' ? '' : `${table}: `}${readableShortcut(chord)}`;
// explain exactly which ambiguous shortcuts are ignored in either popup mode
const commandConflict = (command: ShortcutCommand): string | undefined => {
  const shared = command.shortcuts.filter(shortcut => shortcut.conflicted).map(shortcut => assignmentLabel(shortcut.table, shortcut.chord));
  return shared.length === 0 ? undefined : `Conflict: ${shared.join(', ')} — assigned to another command. These shortcuts are ignored until resolved.`;
};
// summarize provenance once for each consolidated command
const commandSource = (command: ShortcutCommand): string => command.shortcuts.length === 0 ? 'Disabled' : command.customized ? 'Custom' : [...new Set(command.shortcuts.map(shortcut => sourceLabel[shortcut.source]))].join(', ');

// edit aliases together without changing the server identity behind terminal commands
function ShortcutSetting({ command }: { command: ShortcutCommand }) {
  const [editing, setEditing] = useState<{ table: string; prefixTable: string; from?: { table: string; chord: string } }>();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const recorderRef = useRef<HTMLDivElement>(null);
  const signature = JSON.stringify(command);
  const description = describeBinding(command.binding);
  const disabled = command.shortcuts.length === 0;
  const conflict = commandConflict(command);
  const prefixTables = Object.keys(baseTables).filter(table => table !== 'root');
  // recover focus when an assignment or its old edit icon disappears
  const focusControl = () => {
    const trigger = triggerRef.current;
    // prefer the actual opener while it still exists and remains usable
    if (trigger?.isConnected === true && !trigger.disabled) trigger.focus();
    else rowRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };
  // abandon stale drafts after live server or cross-tab changes
  useEffect(() => {
    const restoreFocus = recorderRef.current?.contains(document.activeElement) === true;
    setEditing(undefined);
    setError(undefined);
    // avoid stealing focus from another command's controls
    if (restoreFocus) requestAnimationFrame(focusControl);
  }, [signature]);
  // record a replacement or an additional shortcut without executing it
  const begin = (trigger: HTMLButtonElement, table: string, from?: string) => {
    triggerRef.current = trigger;
    setDraft(from);
    setError(undefined);
    setEditing({ table, prefixTable: table === 'root' ? 'prefix' : table, ...(from === undefined ? {} : { from: { table, chord: from } }) });
  };
  // cancel capture without leaving the quick reference
  const cancel = () => { setEditing(undefined); setError(undefined); requestAnimationFrame(focusControl); };
  // persist one atomic command edit and leave invalid drafts available for correction
  const apply = (edit: ShortcutEdit) => {
    const failure = editShortcutCommand(command.id, edit);
    setError(failure);
    // focus a surviving control only after a successful save
    if (failure === undefined) { setEditing(undefined); requestAnimationFrame(focusControl); }
  };
  // retain tab navigation and escape cancellation while capturing a complete chord
  const record = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // the dialog still owns keyboard focus navigation
    if (event.key === 'Tab') return;
    event.stopPropagation();
    event.preventDefault();
    // escape cancels recording rather than dismissing the reference
    if (event.key === 'Escape') { cancel(); return; }
    const next = eventChord(event.nativeEvent);
    // wait for a nonmodifier key and exclude composition
    if (next === undefined) return;
    setDraft(next);
    setError(undefined);
  };
  const assignments = command.shortcuts.map(shortcut => assignmentLabel(shortcut.table, shortcut.chord)).join(', ');
  return <div ref={rowRef} className={`shortcut-setting${disabled ? ' key-binding-removed' : ''}${conflict === undefined ? '' : ' shortcut-conflict'}`} role="group" aria-label={`${description} (${disabled ? 'disabled' : assignments})`} data-shortcut-command={command.id} data-shortcut-origins={commandOrigins(command)}>
    <div className="shortcut-setting-keys">
      {command.shortcuts.map(shortcut => <span key={`${shortcut.table}:${shortcut.chord}`} className={`shortcut-assignment${shortcut.conflicted ? ' shortcut-assignment-conflict' : ''}`} data-shortcut-id={`${shortcut.originTable}:${shortcut.original}`} data-shortcut-table={shortcut.table} data-shortcut-chord={shortcut.chord}>
        <span className="shortcut-assignment-controls">
          <button type="button" className="shortcut-change shortcut-outline" aria-label={`Change shortcut for ${description} (${assignmentLabel(shortcut.table, shortcut.chord)})`} title="Rebind shortcut" onClick={event => { /* capture only this visible alias */ begin(event.currentTarget, shortcut.table, shortcut.chord); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3" /></svg></button>
          <button type="button" className="shortcut-remove shortcut-outline" aria-label={`Remove shortcut ${assignmentLabel(shortcut.table, shortcut.chord)} for ${description}`} title="Remove shortcut" onClick={() => { /* remove all duplicate owners of this alias */ apply({ kind: 'remove', table: shortcut.table, from: shortcut.chord }); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg></button>
        </span>
        {shortcut.table !== 'root' && <span className="shortcut-table-label">{shortcut.table}</span>}<ShortcutKeys chord={shortcut.chord} />
      </span>)}
      {!disabled && <button type="button" className="shortcut-add shortcut-outline" aria-label={`Add shortcut for ${description}`} onClick={event => { /* start in this command's current context */ begin(event.currentTarget, command.shortcuts[0]!.table); }}>+ Add</button>}
    </div>
    <div className="shortcut-setting-description"><strong>{disabled ? <s>{description}</s> : description}</strong></div>
    <div className="shortcut-setting-actions shortcut-binding-controls">
      <button type="button" className="shortcut-outline" disabled={command.unavailable} title={disabled ? 'Restore the default shortcuts' : 'Disable all shortcuts for this command'} onClick={() => { /* toggle every assignment for the consolidated command */ apply({ kind: disabled ? 'reset' : 'disable' }); }}>{disabled ? 'Enable' : 'Disable'}</button>
      <button type="button" className="shortcut-outline" disabled={!command.customized} onClick={() => { /* restore all original assignments for this command */ apply({ kind: 'reset' }); }}>Reset</button>
    </div>
    {editing !== undefined && <div ref={recorderRef} className="shortcut-recorder">
      <label className="client-settings-toggle shortcut-prefix-toggle"><span>Use prefix</span><input role="switch" type="checkbox" aria-label={`Use prefix for ${description}`} checked={editing.table !== 'root'} onChange={event => { /* change only the destination context until save */ setEditing({ ...editing, table: event.currentTarget.checked ? editing.prefixTable : 'root' }); setError(undefined); }} /><span className="client-settings-switch-state">{editing.table === 'root' ? 'Off' : 'On'}</span><span className="client-settings-switch-track" aria-hidden="true" /></label>
      {editing.table !== 'root' && prefixTables.length > 1 && <label>Prefix table<select aria-label={`Prefix table for ${description}`} value={editing.table} onChange={event => { /* retain the original alias while choosing a different prefix */ setEditing({ ...editing, table: event.target.value, prefixTable: event.target.value }); setError(undefined); }}>{prefixTables.map(table => <option key={table} value={table}>{table}</option>)}</select></label>}
      <input autoFocus readOnly data-shortcut-recorder aria-label={`New shortcut for ${description}`} placeholder="Press a shortcut…" value={draft === undefined ? '' : readableShortcut(draft)} onKeyDown={record} />
      <span>Press keys, then Save. Escape cancels.</span>
      <div className="shortcut-setting-actions"><button type="button" disabled={draft === undefined} onClick={() => { /* save a replacement or an additional assignment */ if (draft !== undefined) apply(editing.from === undefined ? { kind: 'add', table: editing.table, chord: draft } : { kind: 'replace', table: editing.table, fromTable: editing.from.table, from: editing.from.chord, chord: draft }); }}>Save</button><button type="button" onClick={cancel}>Cancel</button></div>
    </div>}
    {command.unavailable && <small>Disabled by the server.</small>}
    {conflict !== undefined && <p className="shortcut-conflict-message">{conflict}</p>}
    {error && <p className="shortcut-error" role="alert">{error}</p>}
  </div>;
}

// consolidate every command while keeping all of its table-specific assignments editable
function ShortcutEditor() {
  const { commands, hasSavedShortcuts } = useShortcutSettings();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  // search descriptions, original contexts and every current assignment
  const shown = commands.filter(command => `${describeBinding(command.binding)} ${command.origins.map(origin => `${origin.table} ${readableShortcut(origin.chord)}`).join(' ')} ${command.shortcuts.map(shortcut => `${shortcut.table} ${readableShortcut(shortcut.chord)}`).join(' ')} ${commandConflict(command) ?? ''}`.toLowerCase().includes(needle));
  // reset all assignments without leaving a stale recorder or disabled focus target
  const reset = () => {
    const failure = resetShortcuts();
    setError(failure);
    // focus the search before reset becomes disabled
    if (failure === undefined) requestAnimationFrame(() => searchRef.current?.focus());
  };
  return <div className="shortcut-editor" role="region" aria-label="Edit keyboard shortcuts">
    <p>Add multiple shortcuts per command. Use the prefix switch to choose whether to press a leader key first. Changes apply only to this browser.</p>
    <div className="shortcut-editor-actions"><button type="button" className="shortcut-outline" disabled={!hasSavedShortcuts} onClick={reset}>Reset all shortcuts</button></div>
    {error && <p className="shortcut-error" role="alert">{error}</p>}
    <input ref={searchRef} type="search" aria-label="Find keyboard shortcuts" placeholder="Find a shortcut…" value={query} onChange={event => { /* filter without changing assignments */ setQuery(event.target.value); }} />
    <div className="shortcut-table">{shown.map(command => <ShortcutSetting key={command.id} command={command} />)}</div>
    {shown.length === 0 && <p>No matching shortcuts.</p>}
  </div>;
}

// show each command once with disabled and conflicting assignments clearly marked
function BindingsSheet({ onClose }: { onClose: () => void }) {
  const { commands } = useShortcutSettings();
  const [editing, setEditing] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(document.activeElement);
  // recover focus if a live configuration update removes the focused control
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    // leave valid modal focus untouched
    if (sheet !== null && !sheet.contains(document.activeElement)) sheet.querySelector<HTMLButtonElement>('button')?.focus();
  });
  // hand focus back however the sheet closes, C-? again included
  useLayoutEffect(() => () => { if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus({ preventScroll: true }); }, []);
  // contain keyboard navigation across both reference and editor controls
  const sheetKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // dismiss without also closing settings behind the portal
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    // cycle focus within the quick reference
    if (event.key === 'Tab') {
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])');
      const first = controls[0];
      const last = controls[controls.length - 1];
      // wrap at either end of the modal controls
      if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
  };
  return createPortal(<div ref={sheetRef} className="dialog key-bindings-dialog" role="dialog" aria-modal="true" aria-labelledby="key-bindings-title" onKeyDown={sheetKey} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div>
    <header><h2 id="key-bindings-title">Key bindings</h2><button className="key-bindings-edit" type="button" aria-pressed={editing} onClick={() => { /* switch modes without leaving the popup */ setEditing(current => !current); }}>{editing ? 'Done editing' : 'Edit shortcuts'}</button><button type="button" autoFocus aria-label="Close key bindings" onClick={onClose}>×</button></header>
    {shortcutWarning && <p className="key-bindings-hint shortcut-error" role="alert">{shortcutWarning}</p>}
    <p className="key-bindings-hint">Unlabeled shortcuts run directly. Prefix labels mean press that table&rsquo;s leader first. Press a leader twice to send it to the focused terminal; otherwise it waits 10 seconds for the next key.</p>
    {editing ? <ShortcutEditor /> : <section aria-label="Keyboard shortcuts"><table><tbody>{commands.map(command => {
      const disabled = command.shortcuts.length === 0;
      const conflict = commandConflict(command);
      return <tr key={command.id} data-shortcut-command={command.id} data-shortcut-origins={commandOrigins(command)} className={`key-binding-${disabled ? 'removed' : command.origins[0]!.source}${conflict === undefined ? '' : ' shortcut-conflict'}`}>
        <td><div className="shortcut-reference-keys">{command.shortcuts.map(shortcut => <span key={`${shortcut.table}:${shortcut.chord}`} className={`shortcut-assignment${shortcut.conflicted ? ' shortcut-assignment-conflict' : ''}`} data-shortcut-id={`${shortcut.originTable}:${shortcut.original}`} data-shortcut-table={shortcut.table} data-shortcut-chord={shortcut.chord}>{shortcut.table !== 'root' && <span className="shortcut-table-label">{shortcut.table}</span>}<ShortcutKeys chord={shortcut.chord} /></span>)}</div></td>
        <td>{disabled ? <s>{describeBinding(command.binding)}</s> : describeBinding(command.binding)}{conflict !== undefined && <p className="shortcut-conflict-message">{conflict}</p>}</td>
        <td className="key-binding-source">{commandSource(command)}</td>
      </tr>;
    })}</tbody></table></section>}
  </div></div>, document.body);
}

// Every action, and each Terminal binding, runnable by name.
function CommandPalette({ onClose }: { onClose: () => void }) {
  const resolved = useKeyTables();
  // keys that run each binding, so a row teaches its shortcut
  const keysFor = (matches: (binding: KeyBinding) => boolean) => Object.entries(resolved).flatMap(([table, rows]) => Object.values(rows).filter(row => row.source !== 'removed' && row.conflicted !== true && matches(row.binding)).map(row => table === 'root' ? readableShortcut(row.chord) : `${table} ${readableShortcut(row.chord)}`)).join(', ');
  // copy and save-note act on the key's own target, so they only make sense as keys
  const actions = Object.entries(keyActions).filter(([name]) => name !== 'copy-selection' && name !== 'save-note' && name !== 'prompt-newline' && name !== 'command-palette').map(([name, action]): KeyPickerOption => ({ id: name, label: action.description, detail: keysFor(binding => binding === name) || name, onSelect: () => runKeyAction(name) }));
  // keep one terminal command option even when it has several aliases
  const terminals = shortcutCommands(baseTables, shortcuts).flatMap((command): KeyPickerOption[] => {
    // operator-disabled terminal commands remain unavailable
    if (!isTerminalBinding(command.binding) || command.unavailable) return [];
    const origin = command.origins.find(candidate => candidate.source !== 'removed')!;
    const detail = command.shortcuts.filter(shortcut => !shortcut.conflicted).map(shortcut => shortcut.table === 'root' ? readableShortcut(shortcut.chord) : `${shortcut.table} ${readableShortcut(shortcut.chord)}`).join(', ');
    return [{ id: command.id, label: `Open ${command.binding.terminal}`, detail: detail || 'No active shortcut', onSelect: () => runKeyAction(terminalBindingAction, undefined, { table: origin.table, chord: origin.chord, binding: command.binding }) }];
  });
  return <KeyPicker title="Command palette" placeholder="Run a command" options={[...actions, ...terminals]} onClose={onClose} />;
}

// keep a countdown's duration stable while its keypress labels update
function KeyIndicatorTimer({ expiresAt }: { expiresAt: number }) {
  const [duration] = useState(() => Math.max(0, expiresAt - Date.now()));
  return <span className="key-indicator-bar" style={{ animationDuration: `${duration}ms` }} />;
}

// place feedback above the current split's composer and terminal helper controls
function useKeyIndicatorPosition(target: Element | null) {
  const [position, setPosition] = useState({ right: 12, bottom: 104, maxWidth: 'calc(100vw - 24px)' });
  // follow resized composers, split navigation and the software keyboard
  useLayoutEffect(() => {
    const panelSelector = '.log-split > *';
    let observedPanel: Element | null | undefined;
    // derive an anchor from visible controls rather than a fixed composer height
    const update = () => {
      const panel = document.activeElement?.closest(panelSelector) ?? (target?.isConnected === true ? target.closest(panelSelector) : null);
      // workspace chrome still needs clearance above visible split input forms
      const scope = panel ?? document.querySelector('.log-split');
      const controls = Array.from(scope?.querySelectorAll<HTMLElement>('.agent-composer, .question-prompt, .mobile-terminal-keys') ?? []);
      // move observations when a shortcut focuses a different split
      if (scope !== observedPanel) {
        observer.disconnect();
        observedPanel = scope;
        // keep global shortcuts aligned when the workspace resizes
        if (scope !== null) observer.observe(scope);
        controls.forEach(control => observer.observe(control));
      }
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? window.innerHeight);
      const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth);
      const rect = panel?.getBoundingClientRect();
      const panelRight = rect === undefined ? right : Math.min(right, rect.right);
      let anchor = Math.min(bottom - 92, rect?.bottom ?? bottom);
      // avoid every visible input bar within this split
      for (const control of controls) {
        const bounds = control.getBoundingClientRect();
        // hidden mobile controls have no layout box
        if (bounds.width > 0 && bounds.height > 0) anchor = Math.min(anchor, bounds.top);
      }
      setPosition({ right: Math.max(12, window.innerWidth - panelRight + 12), bottom: Math.max(12, window.innerHeight - Math.max(top + 72, anchor) + 12), maxWidth: `${Math.max(0, Math.min(512, panelRight - Math.max(viewport?.offsetLeft ?? 0, rect?.left ?? 0) - 24))}px` });
    };
    const observer = new ResizeObserver(update);
    window.addEventListener('focusin', update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    update();
    // release geometry listeners when the feedback disappears
    return () => {
      observer.disconnect();
      window.removeEventListener('focusin', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [target]);
  return position;
}

// render pending leaders and completed commands as one fading group
function KeyIndicatorFeedback({ feedback, state }: { feedback: KeyPressFeedback | undefined; state: KeyDispatchState | undefined }) {
  const position = useKeyIndicatorPosition(feedback?.target ?? null);
  const chords = feedback?.chords ?? [];
  const sequence = chords.map(keys => keys.join(' + ')).join(' then ');
  const matched = feedback?.matched ?? true;
  const pending = state !== undefined && (state.confirm !== undefined || !state.repeat);
  const expiresAt = pending ? state.expiresAt : feedback!.expiresAt;
  // geometry updates must not shorten the shared fade
  const [duration] = useState(() => Math.max(0, expiresAt - Date.now()));
  const label = state?.confirm ?? (pending ? state.table === 'prefix' ? readableShortcut(state.chord!) : state.table : undefined);
  const accessibleLabel = state?.confirm ?? (pending ? `Key table ${label}` : `Key press ${sequence}`);
  return createPortal(<div style={{ ...position, animationDuration: `${duration}ms` }} className={`key-indicator${matched ? ' matched' : ''}${pending ? '' : ' completed'}${state?.confirm === undefined ? '' : ' confirm'}`} role="status" aria-live={pending ? 'polite' : 'off'} aria-label={`${accessibleLabel}, ${matched ? 'binding matched' : 'no binding matched'}`}>
    {chords.length > 0 && <span className="key-indicator-label">{chords.map((keys, index) => <Fragment key={index}>{index > 0 && <span className="key-indicator-next" aria-hidden="true">→</span>}<KeyCaps keys={keys} /></Fragment>)}</span>}
    {label !== undefined && (state?.confirm !== undefined || label !== sequence) && <span className="key-indicator-context">{label}{state?.confirm !== undefined && <kbd>y/n</kbd>}</span>}
    <KeyIndicatorTimer key={expiresAt} expiresAt={expiresAt} />
  </div>, document.body);
}

// keep programmatic confirmations available without illustrating normal typing
function KeyIndicator() {
  const state = useSyncExternalStore(dispatcher.subscribe, dispatcher.state);
  const feedback = useKeyPress();
  // hidden input never gets resurrected by a pending dispatch table
  if (feedback === undefined && state?.confirm === undefined) return null;
  return <KeyIndicatorFeedback key={feedback?.expiresAt ?? state?.expiresAt} feedback={feedback} state={state} />;
}

// The keyboard's listener and overlays, mounted once with the dashboard.
export function KeyboardLayer({ keys }: { keys?: KeysConfig }) {
  useEffect(installKeyboard, []);
  useEffect(() => setKeysConfig(keys), [keys]);
  const open = useOverlay();
  const close = () => setOverlay(undefined);
  return <>
    <KeyIndicator />
    {open === 'bindings' && <BindingsSheet onClose={close} />}
    {open === 'palette' && <CommandPalette onClose={close} />}
  </>;
}
