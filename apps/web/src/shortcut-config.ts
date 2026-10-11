import { defaultKeyTables, parseChord, parseKeysConfig, type KeyBinding, type KeyRow, type ResolvedKeyTables } from '../../server/src/config/keys.js';

// browser-local choices are keyed by the server binding's stable original identity
export type ShortcutAlias = string | { table: string; chord: string };
export type ShortcutOverrides = Record<string, Record<string, ShortcutAlias[] | null>>;
export type ShortcutOrigin = { table: string; chord: string };
export type ShortcutCommand = {
  id: string;
  binding: KeyBinding;
  origins: Array<{ table: string; chord: string; source: KeyRow['source'] }>;
  shortcuts: Array<{ table: string; chord: string; originTable: string; original: string; source: KeyRow['source']; conflicted: boolean }>;
  unavailable: boolean;
  customized: boolean;
};
export type ShortcutEdit =
  | { kind: 'reset' }
  | { kind: 'disable' }
  | { kind: 'add'; table: string; chord: string }
  | { kind: 'replace'; fromTable: string; from: string; table: string; chord: string }
  | { kind: 'remove'; table: string; from: string };

const tableName = /^[a-z][a-z0-9-]{0,31}$/u;
const maxTables = 32;
const maxBindingsPerTable = 200;
const maxAliasesPerBinding = 20;
const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

type EffectiveAssignment = { table: string; chord: string; originTable: string; original: string; row: KeyRow; commandId: string };

// identify globally shared commands while keeping redacted terminal rows distinct
const commandId = (binding: KeyBinding, table: string, original: string): string => typeof binding === 'string'
  ? `action:${binding}`
  : 'table' in binding ? `table:${binding.table}` : `terminal:${table}:${original}`;

// copy a row before changing its effective chord
const copyRow = (row: KeyRow, chord = row.chord, conflicted = row.conflicted === true): KeyRow => ({
  chord,
  binding: typeof row.binding === 'string' ? row.binding : { ...row.binding },
  source: row.source,
  ...(conflicted ? { conflicted: true } : {})
});

// normalize a stored alias to its effective table and chord
const aliasDestination = (originTable: string, alias: ShortcutAlias): ShortcutOrigin => typeof alias === 'string' ? { table: originTable, chord: alias } : alias;

// use the compact string form for aliases that stay in their origin table
const storedAlias = (originTable: string, destination: ShortcutOrigin): ShortcutAlias => destination.table === originTable ? destination.chord : { ...destination };

// identify one effective destination independently of its storage representation
const aliasKey = (originTable: string, alias: ShortcutAlias): string => {
  const destination = aliasDestination(originTable, alias);
  return `${destination.table}\0${destination.chord}`;
};

// read one active row's current destinations
const effectiveAliases = (originTable: string, rows: Record<string, KeyRow>, choices: Record<string, ShortcutAlias[] | null> | undefined, original: string): ShortcutOrigin[] => {
  const row = rows[original]!;
  // operator removals stay authoritative
  if (row.source === 'removed') return [];
  // inherit the current server chord without a browser choice
  if (choices === undefined || !hasOwn(choices, original)) return [{ table: originTable, chord: original }];
  return (choices[original] ?? []).map(alias => aliasDestination(originTable, alias));
};

// enumerate assignments once so conflict, display and dispatch use identical semantics
const effectiveAssignments = (base: ResolvedKeyTables, overrides: ShortcutOverrides): EffectiveAssignment[] => {
  const assignments: EffectiveAssignment[] = [];
  const seen = new Set<string>();
  // retain server order for commands and aliases
  for (const [originTable, rows] of Object.entries(base)) {
    const choices = overrides[originTable];
    // expand every active origin to all of its browser aliases
    for (const [original, row] of Object.entries(rows)) {
      const identity = commandId(row.binding, originTable, original);
      for (const destination of effectiveAliases(originTable, rows, choices, original)) {
        const key = `${destination.table}\0${destination.chord}\0${identity}`;
        // identical aliases for one command are one effective shortcut
        if (seen.has(key)) continue;
        seen.add(key);
        assignments.push({ table: destination.table, chord: destination.chord, originTable, original, row, commandId: identity });
      }
    }
  }
  return assignments;
};

// map every ambiguous destination to all commands occupying it
const conflictDestinations = (assignments: EffectiveAssignment[]): Set<string> => {
  const occupants = new Map<string, Set<string>>();
  // collect unique commands because duplicate origins for one command are harmless
  for (const assignment of assignments) {
    const destination = `${assignment.table}.${assignment.chord}`;
    const commands = occupants.get(destination) ?? new Set<string>();
    commands.add(assignment.commandId);
    occupants.set(destination, commands);
  }
  return new Set([...occupants].filter(([, commands]) => commands.size > 1).map(([destination]) => destination));
};

// remove stale choices while preserving collisions for the user to resolve
export function reconcileShortcutOverrides(base: ResolvedKeyTables, overrides: ShortcutOverrides): { overrides: ShortcutOverrides; conflicts: string[] } {
  const safe = validateShortcutOverrides(overrides);
  const reconciled: ShortcutOverrides = {};
  // retain only active binding identities still supplied by the server
  for (const [table, choices] of Object.entries(safe)) {
    const rows = base[table];
    // drop a table removed by a server update
    if (rows === undefined) continue;
    const retained: Record<string, ShortcutAlias[] | null> = {};
    // discard unknown and operator-removed identities
    for (const [original, destinations] of Object.entries(choices)) {
      if (rows[original]?.source === undefined || rows[original]!.source === 'removed') continue;
      // drop destinations whose table no longer exists and inherit when none survive
      if (destinations === null) retained[original] = null;
      else {
        const available = destinations.filter(alias => base[aliasDestination(table, alias).table] !== undefined);
        if (available.length > 0) retained[original] = available;
      }
    }
    // omit tables with no live choices
    if (Object.keys(retained).length > 0) reconciled[table] = retained;
  }
  const assignments = effectiveAssignments(base, reconciled);
  return { overrides: reconciled, conflicts: [...conflictDestinations(assignments)] };
}

// apply browser-local destinations without changing stable server binding identities
export function resolveShortcutTables(base: ResolvedKeyTables, overrides: ShortcutOverrides): ResolvedKeyTables {
  const choicesByTable = reconcileShortcutOverrides(base, overrides).overrides;
  const assignments = effectiveAssignments(base, choicesByTable);
  const conflicts = conflictDestinations(assignments);
  const resolved: ResolvedKeyTables = {};
  // retain the server's table order
  for (const [table, rows] of Object.entries(base)) {
    const effective: Record<string, KeyRow> = {};
    // keep operator removal placeholders visible until an active alias occupies them
    for (const [original, row] of Object.entries(rows)) if (row.source === 'removed') effective[original] = copyRow(row);
    // add active assignments after placeholders so aliases can occupy a removed chord
    for (const assignment of assignments) {
      if (assignment.table !== table) continue;
      effective[assignment.chord] = copyRow(assignment.row, assignment.chord, conflicts.has(`${table}.${assignment.chord}`));
    }
    resolved[table] = effective;
  }
  return resolved;
}

// consolidate repeated defaults and aliases into commands for the reference and editor
export function shortcutCommands(base: ResolvedKeyTables, overrides: ShortcutOverrides): ShortcutCommand[] {
  const choicesByTable = reconcileShortcutOverrides(base, overrides).overrides;
  const assignments = effectiveAssignments(base, choicesByTable);
  const conflicts = conflictDestinations(assignments);
  const commands = new Map<string, ShortcutCommand>();
  // establish command order and preserve every server origin, removed rows included
  for (const [table, rows] of Object.entries(base)) for (const [original, row] of Object.entries(rows)) {
    const id = commandId(row.binding, table, original);
    const command = commands.get(id) ?? { id, binding: copyRow(row).binding, origins: [], shortcuts: [], unavailable: true, customized: false };
    command.origins.push({ table, chord: original, source: row.source });
    command.customized ||= choicesByTable[table] !== undefined && hasOwn(choicesByTable[table]!, original);
    commands.set(id, command);
  }
  // attach each deduplicated effective assignment to its command
  for (const assignment of assignments) {
    const command = commands.get(assignment.commandId)!;
    command.shortcuts.push({
      table: assignment.table,
      chord: assignment.chord,
      originTable: assignment.originTable,
      original: assignment.original,
      source: assignment.row.source,
      conflicted: conflicts.has(`${assignment.table}.${assignment.chord}`)
    });
  }
  // only operator removal blocks editing; browser-disabled commands remain restorable
  for (const command of commands.values()) command.unavailable = command.origins.every(origin => origin.source === 'removed');
  return [...commands.values()];
}

// recover the stable server identity behind an effective browser chord
export function shortcutOrigin(base: ResolvedKeyTables, overrides: ShortcutOverrides, table: string, chord: string): ShortcutOrigin {
  const choices = reconcileShortcutOverrides(base, overrides).overrides;
  const assignment = effectiveAssignments(base, choices).find(candidate => candidate.table === table && candidate.chord === chord);
  // leave unknown destinations addressed as received
  return assignment === undefined ? { table, chord } : { table: assignment.originTable, chord: assignment.original };
}

// validate one recorded destination through the shared browser and root-key rules
export function shortcutValidationError(table: string, chord: string, originalChord: string, originTable = table): string | undefined {
  // an empty recorder value means inherit the original
  if (chord === '') return undefined;
  // only a true root origin may retain its own legacy typing key
  if (table === 'root' && originTable === 'root' && chord === originalChord && hasOwn(defaultKeyTables.root!, chord)) return undefined;
  try {
    parseKeysConfig({ [table]: { [chord]: 'show-bindings' } });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid shortcut';
  }
}

// validate and deduplicate one stored alias list
const validatedAliases = (value: unknown, originTable: string, original: string): ShortcutAlias[] | null | undefined => {
  // explicit null and empty arrays both disable the command origin
  if (value === null || Array.isArray(value) && value.length === 0) return null;
  const stored = typeof value === 'string' ? [value] : Array.isArray(value) ? value.slice(0, maxAliasesPerBinding) : undefined;
  if (stored === undefined) return undefined;
  const aliases: ShortcutAlias[] = [];
  const destinations = new Set<string>();
  // discard malformed aliases without losing other valid assignments
  for (const alias of stored) {
    const destination = typeof alias === 'string'
      ? { table: originTable, chord: alias }
      : isRecord(alias) && Object.keys(alias).every(field => field === 'table' || field === 'chord') && typeof alias.table === 'string' && typeof alias.chord === 'string'
        ? { table: alias.table, chord: alias.chord }
        : undefined;
    if (destination === undefined || !tableName.test(destination.table)) continue;
    let canonical: string;
    try { canonical = parseChord(destination.chord); }
    catch { continue; }
    const key = `${destination.table}\0${destination.chord}`;
    if (canonical !== destination.chord || shortcutValidationError(destination.table, destination.chord, original, originTable) !== undefined || destinations.has(key)) continue;
    destinations.add(key);
    aliases.push(storedAlias(originTable, destination));
  }
  return aliases.length > 0 ? aliases : undefined;
};

// parse an untrusted stored object into bounded, canonical, safe choices
export function validateShortcutOverrides(input: unknown): ShortcutOverrides {
  const validated: ShortcutOverrides = {};
  // reject a non-object preference as empty
  if (!isRecord(input)) return validated;
  // bound the number of stored tables inspected
  for (const table of Object.keys(input).slice(0, maxTables)) {
    const storedRows = input[table];
    // ignore malformed table names and values
    if (!tableName.test(table) || !isRecord(storedRows)) continue;
    const rows: Record<string, ShortcutAlias[] | null> = {};
    // bound the number of stored bindings inspected per table
    for (const [original, value] of Object.entries(storedRows).slice(0, maxBindingsPerTable)) {
      let canonicalOriginal: string;
      try { canonicalOriginal = parseChord(original); }
      catch { continue; }
      // stable identities must use their canonical spelling
      if (canonicalOriginal !== original) continue;
      const aliases = validatedAliases(value, table, original);
      if (aliases !== undefined) rows[original] = aliases;
    }
    // omit empty tables from the normalized preference
    if (Object.keys(rows).length > 0) validated[table] = rows;
  }
  return validated;
}

// edit one consolidated command without weakening its stable server authorization identity
export function editShortcutOverrides(base: ResolvedKeyTables, overrides: ShortcutOverrides, id: string, edit: ShortcutEdit): { overrides?: ShortcutOverrides; error?: string } {
  const current = reconcileShortcutOverrides(base, overrides).overrides;
  const command = shortcutCommands(base, current).find(candidate => candidate.id === id);
  // refuse stale or server-disabled commands
  if (command === undefined) return { error: 'This command is no longer available. Reopen the quick reference.' };
  if (command.unavailable && edit.kind !== 'reset') return { error: 'This command is disabled by the server.' };
  const next: ShortcutOverrides = Object.fromEntries(Object.entries(current).map(([table, choices]) => [table, Object.fromEntries(Object.entries(choices).map(([original, aliases]) => [original, aliases?.map(alias => typeof alias === 'string' ? alias : { ...alias }) ?? null]))]));
  // read an origin's effective aliases from the pending transaction
  const valuesFor = (originTable: string, original: string): ShortcutAlias[] => next[originTable]?.[original] === null
    ? []
    : next[originTable]?.[original]?.map(alias => typeof alias === 'string' ? alias : { ...alias }) ?? [original];
  // preserve inheritance and canonicalize duplicate destinations on every write
  const write = (originTable: string, original: string, values: ShortcutAlias[] | undefined) => {
    next[originTable] ??= {};
    if (values === undefined) delete next[originTable]![original];
    else {
      const seen = new Set<string>();
      const unique = values.filter(alias => {
        const key = aliasKey(originTable, alias);
        // keep only the first owner within this stable origin
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(alias => storedAlias(originTable, aliasDestination(originTable, alias)));
      // an unchanged same-table original should follow future server defaults
      if (unique.length === 1 && typeof unique[0] === 'string' && unique[0] === original) delete next[originTable]![original];
      else next[originTable]![original] = unique.length === 0 ? null : unique;
    }
    // keep storage free of empty tables
    if (Object.keys(next[originTable]!).length === 0) delete next[originTable];
  };
  // disabling and resetting cover every duplicate origin of this command
  if (edit.kind === 'reset' || edit.kind === 'disable') {
    for (const origin of command.origins) {
      // never re-enable an operator-removed assignment
      if (origin.source === 'removed' && edit.kind !== 'reset') continue;
      write(origin.table, origin.chord, edit.kind === 'reset' ? undefined : []);
    }
    return { overrides: reconcileShortcutOverrides(base, next).overrides };
  }
  const sourceTable = edit.kind === 'replace' ? edit.fromTable : edit.table;
  // a removed or changed alias cannot silently turn into a new assignment
  if ((edit.kind === 'replace' || edit.kind === 'remove') && !command.shortcuts.some(shortcut => shortcut.table === sourceTable && shortcut.chord === edit.from)) return { error: 'This shortcut changed. Try again with its current assignment.' };
  // only tables present in the operator's resolved configuration are valid destinations
  if ((edit.kind === 'add' || edit.kind === 'replace') && base[edit.table] === undefined) return { error: 'This key table is no longer available.' };
  const origins = command.origins.filter(origin => origin.source !== 'removed');
  let destination: (typeof origins)[number] | undefined;
  // select a stable authorized origin while validating the effective destination
  if (edit.kind === 'add' || edit.kind === 'replace') {
    const previous = edit.kind === 'replace' ? command.shortcuts.find(shortcut => shortcut.table === edit.fromTable && shortcut.chord === edit.from) : undefined;
    const preferred = previous === undefined ? undefined : origins.find(origin => origin.table === previous.originTable && origin.chord === previous.original);
    const candidates = [preferred, ...origins.filter(origin => origin.table === edit.table), ...origins].filter((origin, index, all): origin is (typeof origins)[number] => origin !== undefined && all.indexOf(origin) === index);
    destination = candidates.find(origin => shortcutValidationError(edit.table, edit.chord, origin.chord, origin.table) === undefined);
    // browser-reserved and unsafe typing chords still cannot be assigned
    if (destination === undefined) return { error: shortcutValidationError(edit.table, edit.chord, origins[0]?.chord ?? edit.chord, origins[0]?.table ?? edit.table) ?? 'Invalid shortcut' };
  }
  // remove all duplicate owners of one visible destination before replacing or deleting it
  if (edit.kind === 'replace' || edit.kind === 'remove') {
    for (const origin of origins) write(origin.table, origin.chord, valuesFor(origin.table, origin.chord).filter(alias => {
      const effective = aliasDestination(origin.table, alias);
      return effective.table !== sourceTable || effective.chord !== edit.from;
    }));
  }
  // assigning an existing destination to one command is a no-op rather than a duplicate
  if (edit.kind === 'add' || edit.kind === 'replace') {
    const alreadyAssigned = origins.some(origin => valuesFor(origin.table, origin.chord).some(alias => {
      const effective = aliasDestination(origin.table, alias);
      return effective.table === edit.table && effective.chord === edit.chord;
    }));
    if (!alreadyAssigned) {
      const values = [...valuesFor(destination!.table, destination!.chord), storedAlias(destination!.table, { table: edit.table, chord: edit.chord })];
      // match the bounded preference validator instead of silently dropping saved keys
      if (values.length > maxAliasesPerBinding) return { error: `This assignment supports at most ${maxAliasesPerBinding} shortcuts. Remove one before adding another.` };
      write(destination!.table, destination!.chord, values);
    }
  }
  return { overrides: reconcileShortcutOverrides(base, next).overrides };
}

const arrowLabels: Record<string, string> = { Left: '←', Right: '→', Up: '↑', Down: '↓' };

// choose the platform's familiar name for the system modifier
const superLabel = (platform: string): string => {
  // include desktop and mobile apple platform spellings
  if (/(?:darwin|mac|iphone|ipad|ipod|ios)/iu.test(platform)) return 'Cmd';
  // recognize windows platform and user-agent spellings
  if (/win(?:dows|32|64)?/iu.test(platform)) return 'Win';
  return 'Super';
};

// split one canonical chord into human-readable physical key labels
export function shortcutKeys(chord: string, platform: string): string[] {
  const labels: string[] = [];
  let key = chord;
  const modifiers = [['C', 'Ctrl'], ['M', 'Alt'], ['S', 'Shift']] as const;
  // peel canonical modifiers in their fixed order
  for (const [modifier, label] of modifiers) {
    // add only modifiers present on this chord
    if (key.startsWith(`${modifier}-`)) {
      labels.push(label);
      key = key.slice(modifier.length + 1);
    }
  }
  // the system modifier follows shift in canonical chords
  if (key.startsWith('Super-')) {
    labels.push(superLabel(platform));
    key = key.slice('Super-'.length);
  }
  // expand terse and directional key names
  if (key === 'BSpace') key = 'Backspace';
  else if (hasOwn(arrowLabels, key)) key = arrowLabels[key]!;
  else if (/^[a-z]$/iu.test(key)) key = key.toUpperCase();
  labels.push(key);
  return labels;
}

// join the outlined-key labels for text-only surfaces
export const shortcutLabel = (chord: string, platform: string): string => shortcutKeys(chord, platform).join(' + ');
