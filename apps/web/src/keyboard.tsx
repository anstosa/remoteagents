import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { eventChord, isTableBinding, isTerminalBinding, keyActions, resolveKeyTables, type KeyBinding, type KeyRow, type KeysConfig, type ResolvedKeyTables } from '../../server/src/config/keys.js';
import { createKeyDispatcher } from './key-dispatch.js';
import { resetTerminalFontSize, stepTerminalFontSize } from './terminal-font-size.js';

// What a handler hears about the key that ran it; undefined when the palette runs it.
export type KeyActionContext = { table: string; chord: string; binding: KeyBinding };
// A handler returns false when its action does not apply right now (copy with nothing selected),
// so a root key passes through to the focused control untouched.
export type KeyActionHandler = (event: KeyboardEvent | undefined, context: KeyActionContext | undefined) => boolean | void;
// the action a `{ terminal }` binding runs; its handler asks the server to open the binding's Terminal
export const terminalBindingAction = 'open-terminal-binding';

let configured: KeysConfig | undefined;
let tables: ResolvedKeyTables = resolveKeyTables(undefined);
let tablesRevision = 0;
const tableListeners = new Set<() => void>();
// adopt the operator's tables from the dashboard payload, merged over the defaults
export const setKeysConfig = (keys: KeysConfig | undefined) => {
  if (JSON.stringify(keys) === JSON.stringify(configured)) return;
  configured = keys;
  tables = resolveKeyTables(keys);
  tablesRevision += 1;
  tableListeners.forEach(listener => listener());
};
const useKeyTables = () => {
  useSyncExternalStore(listener => { tableListeners.add(listener); return () => { tableListeners.delete(listener); }; }, () => tablesRevision);
  return tables;
};

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
    const unregister = names.split('\n').map(name => registerKeyAction(name, (event, context) => latest.current[name]?.(event, context) ?? false));
    return () => unregister.forEach(release => release());
  }, [names]);
}
export const useKeyAction = (name: string, handler: KeyActionHandler) => useKeyActions({ [name]: handler });

const dispatcher = createKeyDispatcher<KeyboardEvent>({
  tables: () => tables,
  run: (binding, { table, chord, event }) => runKeyAction(typeof binding === 'string' ? binding : terminalBindingAction, event, { table, chord, binding })
});
// ask a y/n question in the indicator; the next key answers it
export const confirmKey = (message: string, onYes: () => void) => dispatcher.confirm(message, onYes);

// the element a key really went to, through any shadow root (the Code panel's diffs)
export const keyTarget = (event: KeyboardEvent | undefined): Element | null => {
  const target = event?.composedPath()[0] ?? document.activeElement;
  return target instanceof Element ? target : null;
};
// whether a key goes to a text field other than a terminal's own input, where it is typing
export const typingOutsideTerminal = (event: KeyboardEvent | undefined): boolean => {
  const target = keyTarget(event);
  const editable = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
  return editable && target.closest('.xterm') === null;
};

// The one keydown listener for app shortcuts. It runs first (window, capture phase) and swallows
// only the keys the dispatcher handles; every other key reaches xterm, the composer or the control.
const onKeyDown = (event: KeyboardEvent) => {
  if (dispatcher.handle(eventChord(event), event) !== 'handled') return;
  event.preventDefault();
  event.stopImmediatePropagation();
};
let installed = 0;
const installKeyboard = () => {
  if (installed++ === 0) window.addEventListener('keydown', onKeyDown, true);
  return () => { if (--installed === 0) { window.removeEventListener('keydown', onKeyDown, true); dispatcher.reset(); } };
};

// The overlays the keyboard opens, outside any one Workspace.
type KeyboardOverlay = 'bindings' | 'palette' | undefined;
let overlay: KeyboardOverlay;
const overlayListeners = new Set<() => void>();
const setOverlay = (next: KeyboardOverlay) => { overlay = next; overlayListeners.forEach(listener => listener()); };
export const openBindingsSheet = () => setOverlay('bindings');
const useOverlay = () => useSyncExternalStore(listener => { overlayListeners.add(listener); return () => { overlayListeners.delete(listener); }; }, () => overlay);

registerKeyAction('show-bindings', () => setOverlay(overlay === 'bindings' ? undefined : 'bindings'));
registerKeyAction('command-palette', () => setOverlay('palette'));
// font size steps from anywhere but a text field, so Ctrl+- still edits a field's own way
registerKeyAction('font-larger', event => { if (typingOutsideTerminal(event)) return false; stepTerminalFontSize(1); });
registerKeyAction('font-smaller', event => { if (typingOutsideTerminal(event)) return false; stepTerminalFontSize(-1); });
registerKeyAction('font-reset', event => { if (typingOutsideTerminal(event)) return false; resetTerminalFontSize(); });

// how a binding reads in the sheet and the palette
const describeBinding = (binding: KeyBinding): string => typeof binding === 'string'
  ? keyActions[binding]?.description ?? binding
  : isTableBinding(binding) ? `Switch to the ${binding.table} table` : `Terminal running ${binding.terminal}${binding.reuse === true ? ' (reused)' : ''}`;
const sourceLabel: Record<KeyRow['source'], string> = { default: 'Default', config: 'Config', replaced: 'Config, replaces the default', removed: 'Default, removed by config' };
// the tables with anything to show, in resolveKeyTables' order: the built-in ones, then the operator's
const orderedTables = (resolved: ResolvedKeyTables) => Object.entries(resolved).filter(([, rows]) => Object.keys(rows).length > 0);
// an object lists digit keys first, 0 before 1; the sheet reads them as panels 1 to 10
const digitRank = (row: KeyRow) => /^\d$/u.test(row.chord) ? (Number(row.chord) + 9) % 10 : 10;

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

// Every active binding, grouped by table, with where it came from; removed defaults struck through.
function BindingsSheet({ onClose }: { onClose: () => void }) {
  const resolved = useKeyTables();
  const returnFocus = useRef(document.activeElement);
  // hand focus back however the sheet closes, C-? again included
  useLayoutEffect(() => () => { if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus({ preventScroll: true }); }, []);
  return createPortal(<div className="dialog key-bindings-dialog" role="dialog" aria-modal="true" aria-labelledby="key-bindings-title" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div>
    <header><h2 id="key-bindings-title">Key bindings</h2><button type="button" autoFocus aria-label="Close key bindings" onClick={onClose}>×</button></header>
    <p className="key-bindings-hint">Press a table&rsquo;s key twice to send that key to the focused terminal. A table waits 10 seconds for its key.</p>
    {orderedTables(resolved).map(([name, rows]) => <section key={name} aria-labelledby={`key-table-${name}`}>
      <h3 id={`key-table-${name}`}>{name}</h3>
      <table><tbody>{Object.values(rows).sort((a, b) => digitRank(a) - digitRank(b)).map(row => <tr key={row.chord} className={`key-binding-${row.source}`}>
        <td><kbd>{row.chord}</kbd></td>
        <td>{row.source === 'removed' ? <s>{describeBinding(row.binding)}</s> : describeBinding(row.binding)}</td>
        <td className="key-binding-source">{sourceLabel[row.source]}</td>
      </tr>)}</tbody></table>
    </section>)}
  </div></div>, document.body);
}

// Every action, and each Terminal binding, runnable by name.
function CommandPalette({ onClose }: { onClose: () => void }) {
  const resolved = useKeyTables();
  // keys that run each binding, so a row teaches its shortcut
  const keysFor = (matches: (binding: KeyBinding) => boolean) => Object.entries(resolved).flatMap(([table, rows]) => Object.values(rows).filter(row => row.source !== 'removed' && matches(row.binding)).map(row => table === 'root' ? row.chord : `${table} ${row.chord}`)).join(', ');
  // copy and save-note act on the key's own target, so they only make sense as keys
  const actions = Object.entries(keyActions).filter(([name]) => name !== 'copy-selection' && name !== 'save-note' && name !== 'command-palette').map(([name, action]): KeyPickerOption => ({ id: name, label: action.description, detail: keysFor(binding => binding === name) || name, onSelect: () => runKeyAction(name) }));
  const terminals = Object.entries(resolved).flatMap(([table, rows]) => Object.values(rows).flatMap((row): KeyPickerOption[] => row.source === 'removed' || !isTerminalBinding(row.binding) ? [] : [{ id: `terminal:${table}:${row.chord}`, label: `Open ${row.binding.terminal}`, detail: table === 'root' ? row.chord : `${table} ${row.chord}`, onSelect: () => runKeyAction(terminalBindingAction, undefined, { table, chord: row.chord, binding: row.binding }) }]));
  return <KeyPicker title="Command palette" placeholder="Run a command" options={[...actions, ...terminals]} onClose={onClose} />;
}

// Shown while a table waits for its key: the table (the leader's own chord for `prefix`) and a
// bar draining over the time left; or the y/n question waiting for its answer.
function KeyIndicator() {
  const state = useSyncExternalStore(dispatcher.subscribe, dispatcher.state);
  if (state === undefined) return null;
  const remaining = Math.max(0, state.expiresAt - Date.now());
  const label = state.confirm ?? (state.table === 'prefix' ? state.chord : state.table);
  return <div className={`key-indicator${state.confirm === undefined ? '' : ' confirm'}`} role="status" aria-label={state.confirm === undefined ? `Key table ${label}` : state.confirm}>
    <span className="key-indicator-label">{label}{state.confirm !== undefined && <kbd>y/n</kbd>}</span>
    <span key={state.expiresAt} className="key-indicator-bar" style={{ animationDuration: `${remaining}ms` }} />
  </div>;
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
