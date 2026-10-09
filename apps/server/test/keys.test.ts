import { describe, expect, it } from 'vitest';
import { defaultKeyTables, eventChord, keyActions, parseChord, parseKeysConfig, resolveKeyTables, terminalBindingCommand } from '../src/config/keys.js';

const press = (key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; code?: string; isComposing?: boolean } = {}) => ({ key, code: modifiers.code ?? '', ctrlKey: modifiers.ctrl ?? false, altKey: modifiers.alt ?? false, shiftKey: modifiers.shift ?? false, metaKey: modifiers.meta ?? false, isComposing: modifiers.isComposing ?? false });

describe('chord syntax', () => {
  it('canonicalizes modifiers into C-M-S-Super order', () => {
    expect(parseChord('C-b')).toBe('C-b');
    expect(parseChord('Super-S-C-x')).toBe('C-S-Super-x');
    expect(parseChord('M-C-Space')).toBe('C-M-Space');
  });

  it('reads an uppercase letter as Shift and drops Shift from other characters', () => {
    expect(parseChord('L')).toBe('S-l');
    expect(parseChord('S-l')).toBe('S-l');
    expect(parseChord('C-S-c')).toBe('C-S-c');
    expect(parseChord('C-C')).toBe('C-S-c');
    expect(parseChord('S-%')).toBe('%');
    expect(parseChord('C-?')).toBe('C-?');
  });

  it('keeps a dash or plus as the key after a modifier', () => {
    expect(parseChord('C--')).toBe('C--');
    expect(parseChord('C-+')).toBe('C-+');
    expect(parseChord('-')).toBe('-');
  });

  it('accepts named keys in any case and keeps Shift on them', () => {
    expect(parseChord('S-Left')).toBe('S-Left');
    expect(parseChord('c-pageup')).toBe('C-PageUp');
    expect(parseChord('F12')).toBe('F12');
  });

  it('refuses unknown keys, empty chords and repeated modifiers', () => {
    for (const bad of ['', 'C-', 'C-C-b', 'Hyper-b', 'C-abc', 'F13']) expect(() => parseChord(bad), bad).toThrow();
  });
});

describe('eventChord', () => {
  it('names a chord by the character typed', () => {
    expect(eventChord(press('b', { ctrl: true }))).toBe('C-b');
    expect(eventChord(press('%', { shift: true }))).toBe('%');
    expect(eventChord(press('?', { ctrl: true, shift: true }))).toBe('C-?');
    expect(eventChord(press('L', { shift: true }))).toBe('S-l');
    expect(eventChord(press('C', { ctrl: true, shift: true }))).toBe('C-S-c');
  });

  it('ignores Caps Lock on letters', () => {
    expect(eventChord(press('L'))).toBe('l');
  });

  it('maps named keys', () => {
    expect(eventChord(press('ArrowLeft', { shift: true }))).toBe('S-Left');
    expect(eventChord(press(' ', { ctrl: true }))).toBe('C-Space');
    expect(eventChord(press('Backspace'))).toBe('BSpace');
    expect(eventChord(press('F5'))).toBe('F5');
    expect(eventChord(press('=', { meta: true }))).toBe('Super-=');
  });

  it('reads Alt letters and digits from the physical key when the layout rewrites them', () => {
    expect(eventChord(press('å', { alt: true, code: 'KeyA' }))).toBe('M-a');
    expect(eventChord(press('¡', { alt: true, code: 'Digit1' }))).toBe('M-1');
  });

  it('gives no chord for a bare modifier, a dead key or an IME composition', () => {
    expect(eventChord(press('Shift', { shift: true }))).toBeUndefined();
    expect(eventChord(press('Control', { ctrl: true }))).toBeUndefined();
    expect(eventChord(press('Dead'))).toBeUndefined();
    expect(eventChord(press('Process'))).toBeUndefined();
    expect(eventChord(press('a', { isComposing: true }))).toBeUndefined();
  });

  it('agrees with parseChord on every default binding', () => {
    for (const table of Object.values(defaultKeyTables)) for (const chord of Object.keys(table)) expect(parseChord(chord)).toBe(chord);
  });
});

describe('keys configuration', () => {
  it('accepts tables of bindings, canonicalizing their chords', () => {
    const keys = parseKeysConfig({
      root: { 'C-g': { table: 'git' } },
      prefix: { x: null, 'C-S-L': 'last-workspace' },
      git: { l: { terminal: 'lazygit', reuse: true }, d: { terminal: 'gh dash' } }
    });
    expect(keys).toEqual({
      root: { 'C-g': { table: 'git' } },
      prefix: { x: null, 'C-S-l': 'last-workspace' },
      git: { l: { terminal: 'lazygit', reuse: true }, d: { terminal: 'gh dash' } }
    });
  });

  it.each([
    ['C-t', 'Firefox and Chromium'],
    ['C-S-n', 'Firefox and Chromium'],
    ['C-Tab', 'never receives'],
    ['C-PageDown', 'never receives'],
    ['C-S-p', 'Firefox'],
    ['C-S-u', 'IBus'],
    ['C-]', 'Chromium']
  ])('refuses the browser-reserved chord %s', (chord, reason) => {
    expect(() => parseKeysConfig({ prefix: { [chord]: 'next-panel' } })).toThrow(reason);
  });

  it('refuses a plain key in root but allows modifiers, function keys and removals there', () => {
    expect(() => parseKeysConfig({ root: { g: 'next-panel' } })).toThrow('keys.root.g');
    expect(() => parseKeysConfig({ root: { 'S-Left': 'next-panel' } })).toThrow('C-, M- or Super-');
    expect(parseKeysConfig({ root: { 'M-1': 'select-panel-1', F2: 'command-palette', y: null } })).toEqual({ root: { 'M-1': 'select-panel-1', F2: 'command-palette', y: null } });
  });

  it('refuses an unknown table, an unknown action and a malformed binding', () => {
    expect(() => parseKeysConfig({ root: { 'C-g': { table: 'git' } } })).toThrow('no table named git');
    expect(() => parseKeysConfig({ prefix: { q: 'quit-everything' } })).toThrow('unknown action quit-everything');
    expect(() => parseKeysConfig({ prefix: { q: { terminal: '' } } })).toThrow();
    expect(() => parseKeysConfig({ prefix: { q: { terminal: 'vim\nrm -rf ~' } } })).toThrow('newlines');
    expect(() => parseKeysConfig({ prefix: { q: { terminal: 'htop', reuse: 'yes' } } })).toThrow();
    expect(() => parseKeysConfig({ prefix: { q: { terminal: 'htop', extra: 1 } } })).toThrow();
    expect(() => parseKeysConfig({ prefix: { q: 42 } })).toThrow();
    expect(() => parseKeysConfig({ 'Bad Name': {} })).toThrow('table name');
    expect(() => parseKeysConfig([])).toThrow();
  });

  it('refuses two spellings of one chord in a table', () => {
    expect(() => parseKeysConfig({ prefix: { L: 'next-panel', 'S-l': 'previous-panel' } })).toThrow('twice');
  });

  it('reports every problem at once', () => {
    expect(() => parseKeysConfig({ root: { g: 'next-panel' }, prefix: { 'C-t': 'next-panel' } })).toThrow(/keys\.root\.g.*keys\.prefix\.C-t/su);
  });

  it('binds only actions it knows', () => {
    for (const table of Object.values(defaultKeyTables)) for (const binding of Object.values(table)) if (typeof binding === 'string') expect(keyActions).toHaveProperty(binding);
  });
});

describe('resolveKeyTables', () => {
  it('returns the defaults when nothing is configured', () => {
    const tables = resolveKeyTables(undefined);
    expect(tables.root!['C-b']).toEqual({ chord: 'C-b', binding: { table: 'prefix' }, source: 'default' });
    expect(tables.prefix!.c).toEqual({ chord: 'c', binding: 'new-terminal', source: 'default' });
  });

  it('merges config over the defaults per key, keeping removed defaults for the sheet', () => {
    const tables = resolveKeyTables(parseKeysConfig({ root: { 'C-a': { table: 'prefix' }, 'C-b': null }, prefix: { c: 'command-palette', q: 'show-bindings' }, git: { l: { terminal: 'lazygit' } } }));
    expect(tables.root!['C-b']).toEqual({ chord: 'C-b', binding: { table: 'prefix' }, source: 'removed' });
    expect(tables.root!['C-a']).toEqual({ chord: 'C-a', binding: { table: 'prefix' }, source: 'config' });
    expect(tables.prefix!.c).toEqual({ chord: 'c', binding: 'command-palette', source: 'replaced' });
    expect(tables.prefix!.q!.source).toBe('config');
    expect(tables.git!.l).toEqual({ chord: 'l', binding: { terminal: 'lazygit' }, source: 'config' });
  });

  it('ignores a removal of a key no default binds', () => {
    expect(resolveKeyTables(parseKeysConfig({ prefix: { q: null } })).prefix!.q).toBeUndefined();
  });
});

describe('terminalBindingCommand', () => {
  it('resolves the command a terminal binding runs, from config or the defaults', () => {
    const keys = parseKeysConfig({ git: { d: { terminal: 'gh dash' } }, root: { 'C-g': { table: 'git' } } });
    expect(terminalBindingCommand(keys, 'git', 'd')).toEqual({ command: 'gh dash', reuse: false });
    expect(terminalBindingCommand(undefined, 'prefix', 'g')).toEqual({ command: 'lazygit', reuse: true });
  });

  it('resolves nothing for an action, a removed binding or an unknown key', () => {
    expect(terminalBindingCommand(undefined, 'prefix', 'c')).toBeUndefined();
    expect(terminalBindingCommand(parseKeysConfig({ prefix: { g: null } }), 'prefix', 'g')).toBeUndefined();
    expect(terminalBindingCommand(undefined, 'nope', 'x')).toBeUndefined();
    expect(terminalBindingCommand(undefined, '__proto__', 'x')).toBeUndefined();
  });
});
