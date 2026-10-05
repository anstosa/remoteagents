import { describe, expect, it } from 'vitest';
import { messageAsksQuestion, parseReportedAttention, resolveAttention } from '../../src/adapters/attention.js';

// recognize prose questions without treating code or urls as requests for input
describe('messageAsksQuestion', () => {
  // retain questions in paragraphs and markdown emphasis
  it.each([
    'Should I proceed?',
    'The change is ready. **Which target should I use?**\nI can use either.',
    'Choose a target?\n1. Staging\n2. Production',
    '可以继续吗？',
    'Use `value?.enabled` here. Does that match your intent?'
  ])('recognizes a question in %s', message => {
    expect(messageAsksQuestion(message)).toBe(true);
  });

  // exclude non-prose question marks and quoted history
  it.each([
    undefined,
    'Finished the requested changes.',
    'Use `value?.enabled ?? false`.',
    'See https://example.test/?q=ready for the result.',
    '[Preview](https://example.test/?q=ready)',
    '```ts\nconst x = ready ? one : two;\n```\nDone.',
    '~~~\nShould I proceed?\n~~~\nDone.',
    'Example:\n\n    const x = ready ? one : two;',
    '> Should I proceed?\nThat earlier question is resolved.',
    '```\nAn unfinished code block?'
  ])('ignores non-question content in %s', message => {
    expect(messageAsksQuestion(message)).toBe(false);
  });
});

describe('resolveAttention precedence', () => {
  // reported → question → inferred → finished
  it('honors a valid reported state above everything else', () => {
    expect(resolveAttention({ kind: 'codex', title: 'Ready', reported: 'working', hasQuestion: true })).toBe('working');
    expect(resolveAttention({ kind: 'codex', title: '⠋ Working', reported: 'finished', hasQuestion: true })).toBe('finished');
  });

  it('falls to a pending question when there is no reported state', () => {
    expect(resolveAttention({ kind: 'codex', title: 'Ready', hasQuestion: true })).toBe('question');
    // a question outranks the inferred working title
    expect(resolveAttention({ kind: 'codex', title: '⠋ Working', hasQuestion: true })).toBe('question');
  });

  it('falls to the adapter inferred title state when neither reported nor a question apply', () => {
    expect(resolveAttention({ kind: 'codex', title: '⠋ Working', hasQuestion: false })).toBe('working');
    expect(resolveAttention({ kind: 'codex', title: 'action required', hasQuestion: false })).toBe('question');
    expect(resolveAttention({ kind: 'codex', title: 'Ready', hasQuestion: false })).toBe('finished');
  });

  it('falls to finished when the adapter infers nothing (and for an unregistered kind)', () => {
    expect(resolveAttention({ kind: 'claude', title: 'anything', hasQuestion: false })).toBe('finished');
  });
});

describe('parseReportedAttention', () => {
  it('accepts only the three known state words', () => {
    expect(parseReportedAttention('working')).toBe('working');
    expect(parseReportedAttention('finished')).toBe('finished');
    expect(parseReportedAttention('question')).toBe('question');
  });

  it('rejects unknown, empty, or missing values', () => {
    expect(parseReportedAttention('busy')).toBeUndefined();
    expect(parseReportedAttention('')).toBeUndefined();
    expect(parseReportedAttention(undefined)).toBeUndefined();
  });
});
