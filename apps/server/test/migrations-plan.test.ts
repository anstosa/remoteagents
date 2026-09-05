import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import {
  DataFileError,
  isLegacyConfig,
  planMigration,
  resolutionRequests,
  rewriteBookmarks,
  rewriteListStore,
  rewriteReviewTours,
  rewriteWorktreeRecords,
  type CommandResolution,
  type EntryFacts,
  type ResolvedFacts,
} from '../src/migrations/worktrees-to-projects.js';

// build ResolvedFacts for a set of entries and a bare-name resolution table
const facts = (entries: EntryFacts[], commands: Record<string, CommandResolution> = { codex: { kind: 'absolute', path: '/usr/bin/codex' } }): ResolvedFacts => ({ entries, commands });
// a checkout resolved as the Main worktree at `path`
const mainAt = (path: string): EntryFacts => ({ realpath: path, toplevel: path, commonDir: `${path}/.git`, main: true });

describe('isLegacyConfig', () => {
  it('detects the retired worktrees key and agent keys, ignores the new shape', () => {
    expect(isLegacyConfig({ worktrees: [] })).toBe(true);
    expect(isLegacyConfig({ newAgentCommand: 'codex' })).toBe(true);
    expect(isLegacyConfig({ launch: { program: '/c', args: [] } })).toBe(true);
    expect(isLegacyConfig({ projects: [{ id: 'a', path: '/a', command: 'codex' }] })).toBe(true);
    expect(isLegacyConfig({ projects: [], adapters: { codex: { program: '/c' } } })).toBe(false);
    expect(isLegacyConfig(null)).toBe(false);
    expect(isLegacyConfig([1, 2])).toBe(false);
  });
});

describe('resolutionRequests', () => {
  it('lists entry paths and the bare program names to resolve', () => {
    const raw = { newAgentCommand: 'codex', worktrees: [{ id: 'a', path: '/a', command: 'mycli --flag' }, { id: 'b', path: '/b', launch: { program: '/abs/codex', args: [] } }] };
    const requests = resolutionRequests(raw);
    expect(requests.paths).toEqual(['/a', '/b']);
    expect(requests.programNames.sort()).toEqual(['codex', 'mycli']);
  });
  it('resolves nothing when adapters.codex is already configured', () => {
    const raw = { adapters: { codex: { program: '/x' } }, worktrees: [{ id: 'a', path: '/a', command: 'anything' }] };
    expect(resolutionRequests(raw).programNames).toEqual([]);
  });
  it('resolves no program names when every launch command is already absolute', () => {
    const raw = { newAgentCommand: '/abs/codex', worktrees: [{ id: 'a', path: '/a', command: '/abs/codex --flag' }] };
    expect(resolutionRequests(raw).programNames).toEqual([]);
  });
  it('keeps paths index-aligned with entries, so a path-less entry never shifts the rest', () => {
    const raw = { worktrees: [{ id: 'a', path: '/a', command: '/x' }, { id: 'b', command: '/x' }, { id: 'c', path: '/c', command: '/x' }] };
    expect(resolutionRequests(raw).paths).toEqual(['/a', '', '/c']);
  });
});

describe('planMigration — config mapping', () => {
  it('maps a full legacy config to projects[] + adapters.codex and drops the retired keys', () => {
    const raw = { publicOrigin: 'https://x', newAgentCommand: 'codex', worktrees: [{ id: 'a', label: 'A', path: '/repo-a', saveKey: 'a', pinned: false, command: 'codex', resumeCommand: 'codex resume {threadId}', push: { label: 'P', prompt: 'p' } }] };
    const plan = planMigration(raw, facts([mainAt('/repo-a')]));
    expect(plan.errors).toEqual([]);
    // toEqual is exact: saveKey, command, resumeCommand and pinned must all be gone from the Project
    expect(plan.newConfig).toEqual({ publicOrigin: 'https://x', projects: [{ id: 'a', label: 'A', path: '/repo-a', push: { label: 'P', prompt: 'p' } }], adapters: { codex: { program: '/usr/bin/codex' } } });
    // key order: worktrees' slot becomes projects, adapters immediately after
    expect(Object.keys(plan.newConfig)).toEqual(['publicOrigin', 'projects', 'adapters']);
    expect(plan.codexProgram).toBe('/usr/bin/codex');
    expect(plan.projectsCreated).toEqual([{ id: 'a', mergedFrom: ['a'] }]);
    // a main checkout explicitly unpinned keeps a { pinned: false } record (differs from the default)
    expect(plan.pins).toEqual({ 'a:/repo-a': false });
    expect(plan.labels).toEqual({ 'a:/repo-a': 'A' });
    expect(plan.keyMaps.notes).toEqual({ a: 'a' });
    // saved prompts are Worktree-scoped like queued/history (the live reader keys by wire id)
    expect(plan.keyMaps.savedPrompts).toEqual({ 'worktree:a': 'a:/repo-a' });
    expect(plan.keyMaps.queued).toEqual({ 'worktree:a': 'a:/repo-a' });
    expect(plan.keyMaps.reviewTours).toEqual({ a: 'a:/repo-a' });
    expect(plan.keyMaps.worktrees).toEqual({ a: 'a:/repo-a' });
  });

  it('carries command arguments into adapters.codex.args', () => {
    const raw = { worktrees: [{ id: 'a', path: '/a', command: '/usr/bin/codex --model opus' }] };
    const plan = planMigration(raw, facts([mainAt('/a')]));
    expect(plan.newConfig.adapters).toEqual({ codex: { program: '/usr/bin/codex', args: ['--model', 'opus'] } });
  });

  it('merges entries that share a git repository, first entry winning', () => {
    const raw = { worktrees: [{ id: 'main', path: '/repo', command: 'codex' }, { id: 'wt', path: '/repo-wt', label: 'ignored', command: 'codex' }] };
    const plan = planMigration(raw, facts([{ ...mainAt('/repo') }, { realpath: '/repo-wt', toplevel: '/repo-wt', commonDir: '/repo/.git', main: false }]));
    expect(plan.newConfig.projects).toEqual([{ id: 'main', path: '/repo' }]);
    expect(plan.projectsCreated).toEqual([{ id: 'main', mergedFrom: ['main', 'wt'] }]);
    expect(plan.warnings.some(w => w.includes('merged worktree entries main, wt'))).toBe(true);
    // each member re-keys onto the one Project, keeping its own checkout realpath
    expect(plan.keyMaps.worktrees).toEqual({ main: 'main:/repo', wt: 'main:/repo-wt' });
    expect(plan.labels).toEqual({ 'main:/repo-wt': 'ignored' });
    expect(plan.keyMaps.notes).toEqual({ main: 'main', wt: 'main' });
  });

  // preserve distinct stack and preview settings after a repository merge
  it('preserves each merged worktree stack and preview settings as canonical-path overrides', () => {
    const fullStack = { start: 'docker compose up -d', stop: 'docker compose down', status: 'docker compose ps' };
    const uiStack = { start: 'docker compose up -d web', stop: 'docker compose stop web', status: 'docker compose ps web' };
    const raw = {
      worktrees: [
        { id: 'main', path: '/host/main', hostname: 'main.example.com', port: 80, commands: fullStack, command: 'codex' },
        { id: 'ui', path: '/host/ui', hostname: 'ui.example.com', port: 1080, commands: uiStack, command: 'codex' },
        { id: 'readonly', path: '/host/readonly', command: 'codex' }
      ]
    };
    const entries = [
      { realpath: '/repo/main', toplevel: '/repo/main', commonDir: '/repo/common.git', main: true },
      { realpath: '/repo/ui', toplevel: '/repo/ui', commonDir: '/repo/common.git', main: false },
      { realpath: '/repo/readonly', toplevel: '/repo/readonly', commonDir: '/repo/common.git', main: false }
    ];
    const plan = planMigration(raw, facts(entries));
    expect(plan.newConfig.projects).toEqual([{
      id: 'main',
      path: '/host/main',
      hostname: 'main.example.com',
      port: 80,
      commands: fullStack,
      worktreeOverrides: [
        { path: '/repo/ui', hostname: 'ui.example.com', port: 1080, commands: uiStack },
        { path: '/repo/readonly', hostname: null, port: null, commands: {} }
      ]
    }]);
  });

  // retain malformed legacy commands for the output schema to reject
  it('does not turn null legacy commands into a valid disabled stack', async () => {
    const commands = { start: 'make start' };
    const raw = {
      publicOrigin: 'https://agents.example.com',
      worktrees: [
        { id: 'main', path: '/repo', commands, command: 'codex' },
        { id: 'wt', path: '/repo-wt', commands: null, command: 'codex' }
      ]
    };
    const plan = planMigration(raw, facts([mainAt('/repo'), { realpath: '/repo-wt', toplevel: '/repo-wt', commonDir: '/repo/.git', main: false }]));
    expect(plan.newConfig.projects).toEqual([{
      id: 'main', path: '/repo', commands, worktreeOverrides: [{ path: '/repo-wt', commands: null }]
    }]);
    await expect(validateConfig(plan.newConfig, { checkExecutables: false })).rejects.toThrow();
  });

  // omit override records that would only repeat inherited behavior
  it('does not emit redundant overrides when merged worktree settings match project defaults', () => {
    const commands = { start: 'make start', status: 'make status' };
    const raw = {
      worktrees: [
        { id: 'main', path: '/repo', hostname: 'repo.example.com', port: 3000, commands, command: 'codex' },
        { id: 'wt', path: '/repo-wt', hostname: 'repo.example.com', port: 3000, commands: { status: 'make status', start: 'make start' }, command: 'codex' }
      ]
    };
    const plan = planMigration(raw, facts([mainAt('/repo'), { realpath: '/repo-wt', toplevel: '/repo-wt', commonDir: '/repo/.git', main: false }]));
    expect(plan.newConfig.projects).toEqual([{ id: 'main', path: '/repo', hostname: 'repo.example.com', port: 3000, commands }]);
  });

  it('sends a save key that spans repositories to the first project with a warning', () => {
    const raw = { worktrees: [{ id: 'a', path: '/repo-a', saveKey: 'shared', command: 'codex' }, { id: 'b', path: '/repo-b', saveKey: 'shared', command: 'codex' }] };
    const plan = planMigration(raw, facts([{ realpath: '/repo-a', toplevel: '/repo-a', commonDir: '/repo-a/.git', main: true }, { realpath: '/repo-b', toplevel: '/repo-b', commonDir: '/repo-b/.git', main: true }]));
    expect(plan.keyMaps.notes).toEqual({ shared: 'a' });
    expect(plan.warnings.some(w => w.includes('save key shared spans repositories'))).toBe(true);
  });

  it('falls back to resolve(path) with a warning for a missing checkout', () => {
    const raw = { worktrees: [{ id: 'gone', path: '/gone', command: 'codex' }] };
    const plan = planMigration(raw, facts([{}]));
    expect(plan.keyMaps.worktrees).toEqual({ gone: 'gone:/gone' });
    expect(plan.warnings.some(w => w.includes('worktree gone: path is not a resolvable git checkout'))).toBe(true);
  });

  it('normalizes safe legacy labels and skips unsafe aliases', () => {
    const raw = { worktrees: [{ id: 'a', path: '/a', label: '  Dave  ', command: 'codex' }, { id: 'b', path: '/b', label: 'bad\nname', command: 'codex' }] };
    const plan = planMigration(raw, facts([mainAt('/a'), mainAt('/b')]));
    expect(plan.labels).toEqual({ 'a:/a': 'Dave' });
    expect(plan.warnings.some(warning => warning.includes('invalid label'))).toBe(true);
  });

  it('keeps an operator adapters.codex and drops the legacy keys unresolved', () => {
    const raw = { adapters: { codex: { program: '/opt/codex' } }, newAgentCommand: 'not-real', worktrees: [{ id: 'a', path: '/a', command: 'also-not-real' }] };
    const plan = planMigration(raw, facts([mainAt('/a')], {}));
    expect(plan.errors).toEqual([]);
    expect(plan.newConfig.adapters).toEqual({ codex: { program: '/opt/codex' } });
    expect(plan.newConfig).not.toHaveProperty('newAgentCommand');
    expect(plan.codexProgram).toBe('/opt/codex');
  });

  it('places adapters after projects even when it appeared earlier in the file', () => {
    const raw = { adapters: { claude: { program: '/claude' } }, publicOrigin: 'https://x', worktrees: [{ id: 'a', path: '/a', command: 'codex' }] };
    const plan = planMigration(raw, facts([mainAt('/a')]));
    expect(Object.keys(plan.newConfig)).toEqual(['publicOrigin', 'projects', 'adapters']);
    expect(plan.newConfig.adapters).toEqual({ codex: { program: '/usr/bin/codex' }, claude: { program: '/claude' } });
  });

  it('defaults to resolving codex when no launch key exists', () => {
    const raw = { worktrees: [{ id: 'a', path: '/a' }] };
    const plan = planMigration(raw, facts([mainAt('/a')]));
    expect(plan.newConfig.adapters).toEqual({ codex: { program: '/usr/bin/codex' } });
  });

  it('drops legacy keys carried on a pre-existing projects[] (config-only migration)', () => {
    const raw = { publicOrigin: 'https://x', newAgentCommand: 'codex', command: 'stray', projects: [{ id: 'p', path: '/p', worktreesDirectory: '/wt', command: 'legacy', pinned: true }] };
    const plan = planMigration(raw, facts([]));
    expect(plan.newConfig).not.toHaveProperty('command');
    expect(plan.newConfig).not.toHaveProperty('newAgentCommand');
    // the operator's projects[] survives with its new-schema fields, stray legacy keys stripped
    expect(plan.newConfig.projects).toEqual([{ id: 'p', path: '/p', worktreesDirectory: '/wt' }]);
    expect(plan.newConfig.adapters).toEqual({ codex: { program: '/usr/bin/codex' } });
  });

  // retain new-schema override fields while removing retired agent keys
  it('preserves existing project worktree overrides during a config-only migration', () => {
    const worktreeOverrides = [{ path: '/repo-wt', commands: {}, hostname: null, port: null }];
    const raw = { newAgentCommand: 'codex', projects: [{ id: 'p', path: '/p', command: 'legacy', worktreeOverrides }] };
    const plan = planMigration(raw, facts([]));
    expect(plan.newConfig.projects).toEqual([{ id: 'p', path: '/p', worktreeOverrides }]);
  });
});

describe('planMigration — pins (main/linked × pinned/unpinned)', () => {
  const pinsFor = (main: boolean, pinned: boolean) => planMigration({ worktrees: [{ id: 'w', path: '/w', pinned, command: 'codex' }] }, facts([{ realpath: '/w', toplevel: '/w', commonDir: '/w/.git', main }])).pins;
  it('records only pins that differ from the new default', () => {
    expect(pinsFor(true, true)).toEqual({});                     // main pinned = default
    expect(pinsFor(true, false)).toEqual({ 'w:/w': false });     // main hidden = override
    expect(pinsFor(false, true)).toEqual({ 'w:/w': true });      // linked pinned = override
    expect(pinsFor(false, false)).toEqual({});                   // linked unpinned = default
  });
  it('writes nothing for an absent pin', () => {
    expect(planMigration({ worktrees: [{ id: 'w', path: '/w', command: 'codex' }] }, facts([mainAt('/w')])).pins).toEqual({});
  });
});

describe('planMigration — error classes', () => {
  const bare = (entry: Record<string, unknown>, commands: Record<string, CommandResolution>) => planMigration({ worktrees: [{ id: 'a', path: '/a', ...entry }] }, facts([mainAt('/a')], commands)).errors;
  it('errors on a program missing from PATH', () => {
    expect(bare({ command: 'mycli' }, { mycli: { kind: 'missing' } }).some(e => e.includes('`mycli` was not found on PATH'))).toBe(true);
  });
  it('errors on a program that resolves to an alias', () => {
    expect(bare({ command: 'mycli' }, { mycli: { kind: 'alias', value: 'mycli: aliased to codex' } }).some(e => e.includes('resolves to `mycli: aliased to codex`'))).toBe(true);
  });
  it('errors on a relative launch path', () => {
    expect(bare({ command: './codex' }, {}).some(e => e.includes('relative path'))).toBe(true);
  });
  it('errors on a launch template placeholder', () => {
    expect(bare({ launch: { program: '/c', args: ['--cwd', '{worktreePath}'] } }, {}).some(e => e.includes('per-worktree placeholder'))).toBe(true);
  });
  it('errors when worktree launch commands disagree, listing the values', () => {
    const errors = planMigration({ worktrees: [{ id: 'a', path: '/a', command: 'codex --model o' }, { id: 'b', path: '/b', command: 'codex' }] }, facts([mainAt('/a'), mainAt('/b')])).errors;
    expect(errors.some(e => e.includes('disagree') && e.includes('--model o'))).toBe(true);
  });
  it('errors when both worktrees and projects keys are present, even with an empty projects list', () => {
    const errors = planMigration({ worktrees: [], projects: [], newAgentCommand: 'codex' }, facts([])).errors;
    expect(errors.some(e => e.includes('both `worktrees` and `projects`'))).toBe(true);
  });
  it('passes a bare name through unresolved when its resolution is deferred', () => {
    const plan = planMigration({ worktrees: [{ id: 'a', path: '/a', command: 'codex' }] }, facts([mainAt('/a')], { codex: { kind: 'deferred' } }));
    expect(plan.errors).toEqual([]);
    expect(plan.codexProgram).toBe('codex');
    expect(plan.newConfig.adapters).toEqual({ codex: { program: 'codex' } });
  });
});

describe('data-store rewrites', () => {
  it('re-keys, dedupes and concatenates a list store, leaving unmapped keys untouched', () => {
    const raw = { main: [{ id: 'n1', text: 'a' }], wt: [{ id: 'n2', text: 'b' }, { id: 'n1', text: 'dup' }], scratch_abc: [{ id: 'n3', text: 'c' }] };
    const { value, count } = rewriteListStore(raw, { main: 'proj', wt: 'proj' });
    expect(count).toBe(2);
    expect(value.proj).toEqual([{ id: 'n1', text: 'a' }, { id: 'n2', text: 'b' }]);
    expect(value.scratch_abc).toEqual([{ id: 'n3', text: 'c' }]);
  });
  it('back-fills a missing bookmark kind', () => {
    const raw = { a: [{ id: 'b1', threadId: 't', title: 'x', createdAt: '2026-01-01T00:00:00Z' }, { id: 'b2', threadId: 't2', title: 'y', createdAt: '2026-01-01T00:00:00Z', kind: 'claude' }] };
    const { value } = rewriteBookmarks(raw, { a: 'proj' });
    expect((value.proj as { kind?: string }[])[0]!.kind).toBe('codex');
    expect((value.proj as { kind?: string }[])[1]!.kind).toBe('claude');
  });
  it('keeps the newest review tour when two keys merge, whichever is encountered first', () => {
    const warnings: string[] = [];
    // the newest (wt) is encountered FIRST, so a plain last-wins rewrite would wrongly keep main
    const raw = { wt: { worktreeId: 'wt', branch: 'b', savedAt: '2026-02-01T00:00:00Z', tour: { t: 2 } }, main: { worktreeId: 'main', branch: 'a', savedAt: '2026-01-01T00:00:00Z', tour: { t: 1 } } };
    const { value } = rewriteReviewTours(raw, { wt: 'proj:/repo', main: 'proj:/repo' }, warnings);
    expect(value['proj:/repo']).toEqual({ worktreeId: 'proj:/repo', branch: 'b', savedAt: '2026-02-01T00:00:00Z', tour: { t: 2 } });
    expect(warnings.some(w => w.includes('merge onto'))).toBe(true);
  });
  it('re-keys worktree records and applies config pins and labels, preserving launchProfile', () => {
    const raw = { main: { launchProfile: 'claude' }, scratch: { launchProfile: 'codex' } };
    const { value } = rewriteWorktreeRecords(raw, { main: 'proj:/repo' }, { 'proj:/repo': true, 'proj:/repo-wt': false }, { 'proj:/repo': 'Cora', 'proj:/repo-wt': 'Dave' });
    expect(value['proj:/repo']).toEqual({ launchProfile: 'claude', pinned: true, label: 'Cora' });
    expect(value['proj:/repo-wt']).toEqual({ pinned: false, label: 'Dave' });
    expect(value.scratch).toEqual({ launchProfile: 'codex' });
  });
  it('throws on a non-object data file', () => {
    expect(() => rewriteListStore([1, 2], {})).toThrow(DataFileError);
  });
});
