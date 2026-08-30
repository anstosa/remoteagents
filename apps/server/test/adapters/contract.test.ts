import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptersUnderTest } from './registry.js';
import type { AttentionState, Submission, SubmissionMode, TmuxKey } from './contract.js';

const fixturesRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
const has = (kind: string, file: string) => existsSync(join(fixturesRoot, kind, file));
const load = <T>(kind: string, file: string): T => JSON.parse(readFileSync(join(fixturesRoot, kind, file), 'utf8')) as T;

type ProcessFixture = { name: string; comm: string; argv: string[] };
type TitleFixture = { title: string; state: AttentionState };
type PromptFixture = { name: string; prompt: string; mode: SubmissionMode; text: string; keys: TmuxKey[] };
type CaptureFixture = {
  name: string;
  lines: string[];
  latestCompletedTurn?: { prompt?: string; text: string } | null;
  lastPrompt?: string;
  latestMessage?: string;
  failed: boolean;
};

// The generic key rules every Adapter must obey (spec §"Generic key rules").
function assertNoForbiddenPairs(keys: readonly TmuxKey[], where: string): void {
  for (let i = 1; i < keys.length; i += 1) {
    const pair = `${keys[i - 1]} ${keys[i]}`;
    expect(pair, `${where}: forbidden ${pair}`).not.toBe('Escape Escape');
    expect(pair, `${where}: forbidden ${pair}`).not.toBe('C-c C-c');
  }
}
function assertEnterHasPaste(submission: Submission, where: string): void {
  if (submission.keys.includes('Enter')) {
    expect(submission.text.length, `${where}: Enter sent without a paste`).toBeGreaterThan(0);
  }
}

describe('Adapter contract suite', () => {
  it('every registered adapter kind has a fixture directory', () => {
    for (const adapter of adaptersUnderTest) {
      expect(existsSync(join(fixturesRoot, adapter.kind)), `missing fixtures for ${adapter.kind}`).toBe(true);
    }
  });

  for (const adapter of adaptersUnderTest) describe(`${adapter.kind} adapter`, () => {
    it('recognizes exactly its own processes', () => {
      const { match, noMatch } = load<{ match: ProcessFixture[]; noMatch: ProcessFixture[] }>(adapter.kind, 'processes.json');
      for (const p of match) expect(adapter.recognizes({ comm: p.comm, argv: p.argv }), p.name).toBe(true);
      for (const p of noMatch) expect(adapter.recognizes({ comm: p.comm, argv: p.argv }), p.name).toBe(false);
    });

    it('infers attention state from pane titles', () => {
      for (const { title, state } of load<TitleFixture[]>(adapter.kind, 'titles.json')) {
        expect(adapter.inferState({ title }), `title ${JSON.stringify(title)}`).toBe(state);
      }
    });

    it('prepares prompt submissions and keeps the key rules', () => {
      for (const c of load<PromptFixture[]>(adapter.kind, 'prompts.json')) {
        const submission = adapter.submission.prepare(c.prompt, c.mode);
        expect(submission.text, c.name).toBe(c.text);
        expect(submission.keys, c.name).toEqual(c.keys);
        assertEnterHasPaste(submission, c.name);
        assertNoForbiddenPairs(submission.keys, c.name);
      }
    });

    it('never emits a forbidden key sequence when interrupting or selecting an option', () => {
      assertNoForbiddenPairs(adapter.submission.interrupt, `${adapter.kind} interrupt`);
      for (let index = 0; index <= 4; index += 1) {
        assertNoForbiddenPairs(adapter.submission.selectOption(index), `${adapter.kind} selectOption(${index})`);
      }
    });

    const turns = adapter.turns;
    if (turns && has(adapter.kind, 'captures.json')) it('reads turns from raw capture-pane snapshots', () => {
      for (const c of load<CaptureFixture[]>(adapter.kind, 'captures.json')) {
        const capture = c.lines.join('\n');
        expect(turns.failed(capture), `${c.name} · failed`).toBe(c.failed);
        if ('latestCompletedTurn' in c) {
          if (c.latestCompletedTurn === null) expect(turns.latestCompleted(capture), `${c.name} · turn`).toBeUndefined();
          else expect(turns.latestCompleted(capture), `${c.name} · turn`).toMatchObject(c.latestCompletedTurn!);
        }
        if ('lastPrompt' in c) expect(turns.lastPrompt(capture), `${c.name} · lastPrompt`).toBe(c.lastPrompt);
        if ('latestMessage' in c) expect(turns.latestMessage(capture), `${c.name} · latestMessage`).toBe(c.latestMessage);
      }
    });

    const conversations = adapter.conversations;
    if (conversations && has(adapter.kind, 'conversations.json')) it('validates conversation ids', () => {
      const { valid, invalid } = load<{ valid: string[]; invalid: string[] }>(adapter.kind, 'conversations.json');
      for (const id of valid) expect(conversations.validId(id), `valid ${JSON.stringify(id)}`).toBe(true);
      for (const id of invalid) expect(conversations.validId(id), `invalid ${JSON.stringify(id)}`).toBe(false);
    });
  });
});
