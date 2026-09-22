import { describe, expect, it } from 'vitest';
import { codexDraftState } from '../../src/adapters/codex-turns.js';

// reproduce the single-dot animation that Codex draws over blank composer cells
const sparkleDots = [...'⠁⠂⠄⠈⠐⠠⡀⢀'];
// reproduce per-cell truecolor decoration over the composer background
const animated = (value: string) => `\x1b[48;2;30;30;30m${value.replace(/[⠁⠂⠄⠈⠐⠠⡀⢀]/gu, dot => `\x1b[38;2;20;20;20m${dot}\x1b[39m`)}\x1b[49m`;
// include animated padding and the real status footer
const capture = (composer: string) => [
  animated('    ⠈        ⡀'),
  composer,
  animated('       ⢀⠐'),
  '  gpt-6-astra xhigh fast · ~/repo · main                  Goal paused (/goal resume)'
].join('\n');

// keep composer acknowledgements independent of decorative animation
describe('Codex draft observation', () => {
  // accept every animation frame without changing the expected prompt
  it.each(sparkleDots)('recognizes a draft with %s in its blank cells', dot => {
    expect(codexDraftState(capture(animated(`›${dot}review,${dot}commit,${dot}and${dot}push`)), 'review, commit, and push ')).toBe('visible');
  });

  // acknowledge submission even while the empty composer animates
  it.each(sparkleDots)('recognizes a cleared composer with %s after its marker', dot => {
    expect(codexDraftState(capture(animated(`›${dot}Ask Codex to do anything`)), 'review, commit, and push ')).toBe('cleared');
  });

  // preserve visible tails through animated paragraph spacing
  it('matches the tail of a long multiline draft', () => {
    const prompt = 'Please inspect the entire prompt submission path and fix the race.\n\nKeep the change small and add a regression test.';
    const composer = '›⠁Please inspect the entire prompt submission path and fix the race.\n  ⠂\n ⠐Keep the change small⠄and add a regression test.';
    expect(codexDraftState(capture(animated(composer)), prompt)).toBe('visible');
  });

  // recognize the same animated blanks in collapsed paste labels and shell mode
  it('matches collapsed drafts and shell commands', () => {
    expect(codexDraftState(capture(animated('›⠁[Pasted⠂Content⠄80⠈chars]')), 'x'.repeat(80))).toBe('visible');
    expect(codexDraftState(capture(animated('›⠁[Pasted⠂Content⠄80⠈chars]')), '😀'.repeat(80))).toBe('visible');
    expect(codexDraftState(capture(animated('!⠁git⠂status')), '!git status')).toBe('visible');
    expect(codexDraftState('! ', '!')).toBe('visible');
  });

  // retain literal Braille and regex punctuation supplied by the user
  it('does not erase prompt characters or interpret them as regex syntax', () => {
    expect(codexDraftState(capture(`${animated('›⠁Explain⠂')}⠁⠂⠄⠈⠐⠠⡀⢀${animated('⠐and⠠[a-z]+.')}`), 'Explain ⠁⠂⠄⠈⠐⠠⡀⢀ and [a-z]+.')).toBe('visible');
    expect(codexDraftState(capture(animated('›⠁Explain⠂and⠠[a-z]+.')), 'Explain ⠁⠂⠄⠈⠐⠠⡀⢀ and [a-z]+.')).toBe('cleared');
    expect(codexDraftState(capture(animated('›⠁Explain⠂aaaa')), 'Explain [a-z]+.')).toBe('cleared');
    expect(codexDraftState(capture(`${animated('›⠁')}⠂literal${animated('⠄text')}`), '⠂literal text')).toBe('visible');
    expect(codexDraftState(capture(animated('›⠁Explain⠂🌤️⠄weather')), 'Explain 🌤️ weather')).toBe('visible');
  });

  // never split an emoji at the visible-tail boundary
  it('matches Unicode characters at the start of the visible tail', () => {
    const prompt = `${'Long context '.repeat(10)}🌤${'x'.repeat(63)}`;
    expect(codexDraftState(capture(animated(`›⠁${prompt}`)), prompt)).toBe('visible');
    const shortPrompt = `😀${'x'.repeat(63)}`;
    expect(codexDraftState(capture(animated(`›⠁${shortPrompt}`)), shortPrompt)).toBe('visible');
    expect(codexDraftState(capture(animated(`›⠁Unrelated ${shortPrompt}`)), shortPrompt)).toBe('cleared');
  });

  // never substitute arbitrary characters or match old output and footer text
  it('keeps unrelated content out of the live draft', () => {
    expect(codexDraftState(capture(animated('›⠁review,xcommit, and push')), 'review, commit, and push')).toBe('cleared');
    expect(codexDraftState(capture(animated('›⠁Ask Codex to do anything')), 'gpt-6-astra')).toBe('cleared');
    expect(codexDraftState(animated('›⠁review, commit, and push\n\n• Working'), 'review, commit, and push')).toBe('unknown');
    expect(codexDraftState(capture('›xreview, commit, and push'), 'review, commit, and push')).toBe('unknown');
  });

  // keep authored or ambiguously styled dots out of the whitespace match
  it.each([
    ['default foreground', '\x1b[48;2;30;30;30m'],
    ['palette foreground', '\x1b[48;2;30;30;30;38;5;20m'],
    ['palette background', '\x1b[48;5;20;38;2;20;20;20m'],
    ['bold text', '\x1b[48;2;30;30;30;38;2;20;20;20;1m'],
    ['dim text', '\x1b[48;2;30;30;30;38;2;20;20;20;2m'],
    ['underlined text', '\x1b[48;2;30;30;30;38;2;20;20;20;4m'],
    ['reset background', '\x1b[48;2;30;30;30;38;2;20;20;20;49m'],
    ['reset style', '\x1b[48;2;30;30;30;38;2;20;20;20m\x1b[0m']
  ])('preserves Braille with %s', (_name, style) => {
    const composer = `${style}› a⠁b\x1b[0m`;
    expect(codexDraftState(capture(composer), 'a b')).toBe('cleared');
    expect(codexDraftState(capture(composer), 'a⠁b')).toBe('visible');
  });

  // follow persistent and combined SGR state without depending on theme colors
  it('normalizes only decorated cells across style transitions', () => {
    const composer = '\x1b[48;2;240;241;242;38;2;1;2;3;1m› a\x1b[22m⠁b⠂c\x1b[39m⠄d\x1b[0m';
    expect(codexDraftState(capture(composer), 'a b c⠄d')).toBe('visible');
    expect(codexDraftState(capture(composer), 'a b c d')).toBe('cleared');
  });
});
