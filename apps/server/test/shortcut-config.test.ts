import { describe, expect, it } from 'vitest';
import { lookupKeyBinding, parseKeysConfig, resolveKeyTables } from '../src/config/keys.js';
import { editShortcutOverrides, reconcileShortcutOverrides, resolveShortcutTables, shortcutCommands, shortcutKeys, shortcutLabel, shortcutOrigin, shortcutValidationError, validateShortcutOverrides, type ShortcutOverrides } from '../../web/src/shortcut-config.js';

// build representative server tables without duplicating row metadata
const configuredTables = () => resolveKeyTables(parseKeysConfig({
  root: { 'C-g': { table: 'git' }, 'C-p': { table: 'prefix' } },
  prefix: { q: 'command-palette', x: null },
  git: { d: { terminal: 'gh dash' }, e: { terminal: 'gh dash' }, x: null }
}));

describe('shortcut table overrides', () => {
  it('assigns multiple aliases without mutating the server tables', () => {
    const base = configuredTables();
    const before = structuredClone(base);
    const resolved = resolveShortcutTables(base, { prefix: { c: ['C-c', 'M-c'] }, git: { d: ['C-d', 'M-d'] } });

    expect(resolved.prefix!.c).toBeUndefined();
    expect(resolved.prefix!['C-c']).toEqual({ ...base.prefix!.c, chord: 'C-c' });
    expect(resolved.prefix!['M-c']).toEqual({ ...base.prefix!.c, chord: 'M-c' });
    expect(resolved.git!.d).toBeUndefined();
    expect(resolved.git!['C-d']).toEqual({ ...base.git!.d, chord: 'C-d' });
    expect(resolved.git!['M-d']).toEqual({ ...base.git!.d, chord: 'M-d' });
    expect(base).toEqual(before);
  });

  it('disables a row and an empty override resets every row to the server result', () => {
    const base = configuredTables();

    expect(resolveShortcutTables(base, { prefix: { c: null } }).prefix!.c).toBeUndefined();
    expect(resolveShortcutTables(base, {})).toEqual(base);
  });

  it('preserves operator removals and lets an active alias occupy their placeholder', () => {
    const base = configuredTables();
    const stale = resolveShortcutTables(base, { prefix: { x: ['C-x'] } });
    const occupied = resolveShortcutTables(base, { prefix: { c: ['x'] } });

    expect(stale.prefix!.x).toEqual(base.prefix!.x);
    expect(stale.prefix!['C-x']).toBeUndefined();
    expect(occupied.prefix!.x).toEqual({ ...base.prefix!.c, chord: 'x' });
  });
});

describe('shortcut commands', () => {
  it('globally consolidates built-in actions and table switches in first-origin order', () => {
    const commands = shortcutCommands(configuredTables(), {});
    const larger = commands.find(command => command.id === 'action:font-larger')!;
    const nextPanel = commands.find(command => command.id === 'action:next-panel')!;
    const prefix = commands.find(command => command.id === 'table:prefix')!;

    expect(larger.origins.map(origin => `${origin.table}.${origin.chord}`)).toEqual(['root.C-=', 'root.C-+', 'root.Super-=', 'root.Super-+']);
    expect(nextPanel.origins.map(origin => `${origin.table}.${origin.chord}`)).toEqual(['prefix.n', 'prefix.o']);
    expect(prefix.origins.map(origin => `${origin.table}.${origin.chord}`)).toEqual(['root.C-b', 'root.C-p']);
    expect(commands.indexOf(larger)).toBeLessThan(commands.indexOf(nextPanel));
  });

  it('keeps terminal commands distinct by server origin even when their redacted binding matches', () => {
    const commands = shortcutCommands(configuredTables(), {});
    const terminals = commands.filter(command => command.id.startsWith('terminal:git:'));

    expect(terminals.map(command => command.id)).toEqual(['terminal:git:d', 'terminal:git:e']);
    expect(terminals.map(command => command.origins[0]!.chord)).toEqual(['d', 'e']);
  });

  it('deduplicates identical aliases assigned to the same command', () => {
    const commands = shortcutCommands(configuredTables(), { root: { 'C-=': ['C-F6'], 'Super-=': ['C-F6'] } });
    const larger = commands.find(command => command.id === 'action:font-larger')!;

    expect(larger.shortcuts.filter(shortcut => shortcut.chord === 'C-F6')).toEqual([
      { table: 'root', chord: 'C-F6', originTable: 'root', original: 'C-=', source: 'default', conflicted: false }
    ]);
    expect(reconcileShortcutOverrides(configuredTables(), { root: { 'C-=': ['C-F6'], 'Super-=': ['C-F6'] } }).conflicts).toEqual([]);
  });

  it('keeps browser-disabled commands editable and reserves unavailable for full operator removal', () => {
    const locallyDisabled = shortcutCommands(configuredTables(), { prefix: { n: null, o: null } }).find(command => command.id === 'action:next-panel')!;
    const partlyRemoved = shortcutCommands(resolveKeyTables(parseKeysConfig({ prefix: { n: null } })), {}).find(command => command.id === 'action:next-panel')!;
    const operatorRemoved = shortcutCommands(resolveKeyTables(parseKeysConfig({ prefix: { n: null, o: null } })), {}).find(command => command.id === 'action:next-panel')!;

    expect(locallyDisabled).toMatchObject({ unavailable: false, customized: true, shortcuts: [] });
    expect(partlyRemoved).toMatchObject({ unavailable: false });
    expect(operatorRemoved).toMatchObject({ unavailable: true, customized: false, shortcuts: [] });
  });
});

describe('shortcut identity and conflicts', () => {
  it('maps every terminal alias back to the correct server identity', () => {
    const base = configuredTables();
    const overrides = { git: { d: ['C-d', 'M-d'], e: ['C-e', 'M-e'] } };

    expect(shortcutOrigin(base, overrides, 'git', 'C-d')).toEqual({ table: 'git', chord: 'd' });
    expect(shortcutOrigin(base, overrides, 'git', 'M-d')).toEqual({ table: 'git', chord: 'd' });
    expect(shortcutOrigin(base, overrides, 'git', 'C-e')).toEqual({ table: 'git', chord: 'e' });
    expect(shortcutOrigin(base, overrides, 'git', 'd')).toEqual({ table: 'git', chord: 'd' });
    expect(shortcutOrigin(base, overrides, 'missing', 'C-d')).toEqual({ table: 'missing', chord: 'C-d' });
  });

  it('dispatches cross-table aliases through their stable server origin', () => {
    const base = configuredTables();
    const overrides: ShortcutOverrides = { git: { d: [{ table: 'root', chord: 'C-F6' }] } };
    const resolved = resolveShortcutTables(base, overrides);

    expect(resolved.git!.d).toBeUndefined();
    expect(lookupKeyBinding(resolved, 'root', 'C-F6')).toEqual({ terminal: 'gh dash' });
    expect(shortcutOrigin(base, overrides, 'root', 'C-F6')).toEqual({ table: 'git', chord: 'd' });
    expect(shortcutCommands(base, overrides).find(command => command.id === 'terminal:git:d')!.shortcuts).toEqual([
      { table: 'root', chord: 'C-F6', originTable: 'git', original: 'd', source: 'config', conflicted: false }
    ]);
  });

});

describe('shortcut reconciliation', () => {
  it('preserves every conflict participant and makes the ambiguous chord non-dispatchable', () => {
    const base = configuredTables();
    const overrides = { prefix: { c: ['C-a'], n: ['C-a'] } };
    const reconciled = reconcileShortcutOverrides(base, overrides);
    const resolved = resolveShortcutTables(base, overrides);

    expect(reconciled).toEqual({ overrides, conflicts: ['prefix.C-a'] });
    expect(resolved.prefix!.c).toBeUndefined();
    expect(resolved.prefix!['C-a']?.conflicted).toBe(true);
    expect(lookupKeyBinding(resolved, 'prefix', 'C-a')).toBeUndefined();
    expect(shortcutCommands(base, overrides).filter(command => command.shortcuts.some(shortcut => shortcut.chord === 'C-a')).map(command => [command.id, command.shortcuts.find(shortcut => shortcut.chord === 'C-a')!.conflicted])).toEqual([
      ['action:new-terminal', true],
      ['action:next-panel', true]
    ]);
  });

  it('does not fall back to a default when a custom alias conflicts with it', () => {
    const base = configuredTables();
    const overrides = { prefix: { c: ['n'] } };
    const resolved = resolveShortcutTables(base, overrides);

    expect(reconcileShortcutOverrides(base, overrides)).toEqual({ overrides, conflicts: ['prefix.n'] });
    expect(resolved.prefix!.c).toBeUndefined();
    expect(resolved.prefix!.n?.conflicted).toBe(true);
  });

  it('scopes conflicts to a key table', () => {
    const base = configuredTables();
    const overrides = { prefix: { c: ['C-a'] }, git: { d: ['C-a'] } };

    expect(reconcileShortcutOverrides(base, overrides).conflicts).toEqual([]);
    expect(lookupKeyBinding(resolveShortcutTables(base, overrides), 'prefix', 'C-a')).toBe('new-terminal');
    expect(lookupKeyBinding(resolveShortcutTables(base, overrides), 'git', 'C-a')).toEqual({ terminal: 'gh dash' });
  });

  it('detects conflicts and same-command duplicates at effective cross-table destinations', () => {
    const base = configuredTables();
    const conflict: ShortcutOverrides = { prefix: { c: [{ table: 'root', chord: 'C-=' }] } };
    const duplicate: ShortcutOverrides = { prefix: { '?': [{ table: 'root', chord: 'C-?' }] } };

    expect(reconcileShortcutOverrides(base, conflict).conflicts).toEqual(['root.C-=']);
    expect(lookupKeyBinding(resolveShortcutTables(base, conflict), 'root', 'C-=')).toBeUndefined();
    expect(shortcutCommands(base, conflict).filter(command => command.shortcuts.some(shortcut => shortcut.table === 'root' && shortcut.chord === 'C-=')).map(command => command.id)).toEqual([
      'action:font-larger',
      'action:new-terminal'
    ]);
    expect(reconcileShortcutOverrides(base, duplicate).conflicts).toEqual([]);
    expect(shortcutCommands(base, duplicate).find(command => command.id === 'action:show-bindings')!.shortcuts.filter(shortcut => shortcut.table === 'root' && shortcut.chord === 'C-?')).toHaveLength(1);
  });

  it('keeps preferences while conflicted and recovers after one participant changes', () => {
    const base = configuredTables();
    const conflicted = { prefix: { c: ['C-a', 'M-c'], n: ['C-a'] } };
    const recovered = { prefix: { c: ['C-a', 'M-c'], n: ['M-n'] } };

    expect(reconcileShortcutOverrides(base, conflicted).overrides).toEqual(conflicted);
    expect(reconcileShortcutOverrides(base, recovered)).toEqual({ overrides: recovered, conflicts: [] });
    expect(lookupKeyBinding(resolveShortcutTables(base, recovered), 'prefix', 'C-a')).toBe('new-terminal');
    expect(lookupKeyBinding(resolveShortcutTables(base, recovered), 'prefix', 'M-n')).toBe('next-panel');
  });

  it('drops stored identities removed or no longer supplied by the server', () => {
    const base = configuredTables();
    const reconciled = reconcileShortcutOverrides(base, { prefix: { x: ['C-x'], missing: null, c: ['C-c'] }, missing: { c: ['C-c'] } });

    expect(reconciled).toEqual({ overrides: { prefix: { c: ['C-c'] } }, conflicts: [] });
  });

  it('drops aliases for missing destination tables and safely restores inheritance', () => {
    const base = configuredTables();
    const overrides: ShortcutOverrides = { prefix: { c: [{ table: 'gone', chord: 'C-c' }] } };

    expect(reconcileShortcutOverrides(base, overrides)).toEqual({ overrides: {}, conflicts: [] });
    expect(lookupKeyBinding(resolveShortcutTables(base, overrides), 'prefix', 'c')).toBe('new-terminal');
  });
});

describe('stored shortcut validation', () => {
  it('migrates strings and keeps only bounded canonical safe aliases', () => {
    const validated = validateShortcutOverrides({
      prefix: { c: 'C-c', n: null, p: ['M-p', 'M-p', 'Hyper-x'], q: [], bad: ['Hyper-x'] },
      root: { y: ['y'], 'C-b': ['g', 'C-g'], 'C-s': 'C-s' },
      'Bad Table': { c: 'C-c' },
      broken: null
    });

    expect(validated).toEqual({
      prefix: { c: ['C-c'], n: null, p: ['M-p'], q: null },
      root: { y: ['y'], 'C-b': ['C-g'], 'C-s': ['C-s'] }
    });
    expect(validateShortcutOverrides(null)).toEqual({});
    expect(validateShortcutOverrides([])).toEqual({});
  });

  it('canonicalizes and deduplicates same-table and cross-table destinations', () => {
    expect(validateShortcutOverrides({
      prefix: {
        c: ['C-c', { table: 'prefix', chord: 'C-c' }, { table: 'root', chord: 'C-F6' }, { table: 'root', chord: 'C-F6' }, { table: 'root', chord: 'c' }]
      }
    })).toEqual({ prefix: { c: ['C-c', { table: 'root', chord: 'C-F6' }] } });
    expect(validateShortcutOverrides({ prefix: { c: 'C-c' } })).toEqual({ prefix: { c: ['C-c'] } });
  });

  it('caps stored tables, rows and aliases', () => {
    const input = Object.fromEntries(Array.from({ length: 40 }, (_, table) => [`table-${table}`, Object.fromEntries(Array.from({ length: 240 }, (_, row) => [`C-F${row + 1}`, Array.from({ length: 30 }, (__, alias) => `M-F${alias + 1}`)]))]));
    const validated = validateShortcutOverrides(input);

    expect(Object.keys(validated).length).toBeLessThanOrEqual(32);
    expect(Object.values(validated).every(rows => Object.keys(rows).length <= 200)).toBe(true);
    expect(Object.values(validated).flatMap(Object.values).filter(Array.isArray).every(aliases => aliases.length <= 20)).toBe(true);
  });
});

describe('shortcut validation', () => {
  it('reports browser reservations and unsafe root typing', () => {
    expect(shortcutValidationError('prefix', 'C-t', 'c')).toContain('reserve it');
    expect(shortcutValidationError('root', 'g', 'C-b')).toContain('cannot steal typing');
    expect(shortcutValidationError('prefix', 'Hyper-x', 'c')).toContain('not a key');
  });

  it('allows retained built-in root typing shortcuts but not aliases borrowed from another origin', () => {
    expect(shortcutValidationError('root', 'y', 'y')).toBeUndefined();
    expect(shortcutValidationError('root', 'S-Left', 'S-Left')).toBeUndefined();
    expect(shortcutValidationError('root', 'S-Enter', 'S-Enter')).toBeUndefined();
    expect(shortcutValidationError('root', 'S-Right', 'C-b')).toContain('cannot steal typing');
    expect(shortcutValidationError('root', 'S-Right', 'S-Right', 'prefix')).toContain('cannot steal typing');
    expect(shortcutValidationError('root', '', 'C-b')).toBeUndefined();
  });
});

describe('shortcut editing', () => {
  it('adds and moves bindings between prefixed and nonprefixed tables', () => {
    const base = configuredTables();
    const added = editShortcutOverrides(base, {}, 'action:new-terminal', { kind: 'add', table: 'root', chord: 'C-F6' });

    expect(added).toEqual({ overrides: { prefix: { c: ['c', { table: 'root', chord: 'C-F6' }] } } });
    expect(lookupKeyBinding(resolveShortcutTables(base, added.overrides!), 'prefix', 'c')).toBe('new-terminal');
    expect(lookupKeyBinding(resolveShortcutTables(base, added.overrides!), 'root', 'C-F6')).toBe('new-terminal');

    const moved = editShortcutOverrides(base, added.overrides!, 'action:new-terminal', { kind: 'replace', fromTable: 'root', from: 'C-F6', table: 'prefix', chord: 'M-c' });
    expect(moved).toEqual({ overrides: { prefix: { c: ['c', 'M-c'] } } });
    expect(shortcutOrigin(base, moved.overrides!, 'prefix', 'M-c')).toEqual({ table: 'prefix', chord: 'c' });

    const rootToPrefix = editShortcutOverrides(base, {}, 'action:show-bindings', { kind: 'replace', fromTable: 'root', from: 'C-?', table: 'prefix', chord: 'F6' });
    expect(rootToPrefix).toEqual({ overrides: { root: { 'C-?': [{ table: 'prefix', chord: 'F6' }] } } });
    expect(shortcutOrigin(base, rootToPrefix.overrides!, 'prefix', 'F6')).toEqual({ table: 'root', chord: 'C-?' });
  });

  it('removes, disables and resets cross-table aliases across consolidated origins', () => {
    const base = configuredTables();
    const overrides: ShortcutOverrides = { root: { 'C-=': ['C-=', { table: 'prefix', chord: 'F6' }] } };
    const removed = editShortcutOverrides(base, overrides, 'action:font-larger', { kind: 'remove', table: 'prefix', from: 'F6' });
    const disabled = editShortcutOverrides(base, overrides, 'action:font-larger', { kind: 'disable' });
    const reset = editShortcutOverrides(base, disabled.overrides!, 'action:font-larger', { kind: 'reset' });

    expect(removed).toEqual({ overrides: {} });
    expect(shortcutCommands(base, disabled.overrides!).find(command => command.id === 'action:font-larger')!.shortcuts).toEqual([]);
    expect(reset).toEqual({ overrides: {} });
  });

  it('keeps terminal authorization tied to its original server row after a move', () => {
    const base = configuredTables();
    const moved = editShortcutOverrides(base, {}, 'terminal:git:d', { kind: 'replace', fromTable: 'git', from: 'd', table: 'root', chord: 'C-F8' });

    expect(moved).toEqual({ overrides: { git: { d: [{ table: 'root', chord: 'C-F8' }] } } });
    expect(shortcutOrigin(base, moved.overrides!, 'root', 'C-F8')).toEqual({ table: 'git', chord: 'd' });
    expect(shortcutCommands(base, moved.overrides!).filter(command => command.id.startsWith('terminal:git:')).map(command => [command.id, command.shortcuts.map(shortcut => `${shortcut.table}.${shortcut.chord}`)])).toEqual([
      ['terminal:git:d', ['root.C-F8']],
      ['terminal:git:e', ['git.e']]
    ]);
  });

  it('rejects stale aliases, missing tables, unsafe root typing and server-disabled commands', () => {
    const base = configuredTables();

    expect(editShortcutOverrides(base, {}, 'action:new-terminal', { kind: 'replace', fromTable: 'prefix', from: 'missing', table: 'root', chord: 'C-F6' }).error).toContain('changed');
    expect(editShortcutOverrides(base, {}, 'action:new-terminal', { kind: 'add', table: 'gone', chord: 'C-F6' }).error).toContain('no longer available');
    expect(editShortcutOverrides(base, {}, 'action:new-terminal', { kind: 'add', table: 'root', chord: 'c' }).error).toContain('cannot steal typing');
    const removed = resolveKeyTables(parseKeysConfig({ prefix: { c: null } }));
    expect(editShortcutOverrides(removed, {}, 'action:new-terminal', { kind: 'add', table: 'root', chord: 'C-F6' }).error).toContain('disabled by the server');
  });
});

describe('shortcut labels', () => {
  it('uses separate familiar labels for every modifier and key', () => {
    expect(shortcutKeys('C-M-S-Super-Left', 'Win32')).toEqual(['Ctrl', 'Alt', 'Shift', 'Win', '←']);
    expect(shortcutKeys('M-Super-BSpace', 'MacIntel')).toEqual(['Alt', 'Cmd', 'Backspace']);
    expect(shortcutKeys('Super-a', 'Darwin arm64')).toEqual(['Cmd', 'A']);
    expect(shortcutKeys('Super-a', 'Linux x86_64')).toEqual(['Super', 'A']);
    expect(shortcutKeys('C--', 'Linux')).toEqual(['Ctrl', '-']);
    expect(shortcutLabel('C-S-c', 'Windows')).toBe('Ctrl + Shift + C');
  });
});
