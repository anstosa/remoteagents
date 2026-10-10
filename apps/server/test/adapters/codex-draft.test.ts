import { describe, expect, it } from 'vitest';
import { codexDraftState, codexOwnsDraft } from '../../src/adapters/codex-turns.js';
import { codexNewConversation } from '../../src/adapters/codex-new-conversation.js';

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
  // recovery ownership must reject edits while still tolerating terminal wraps
  it('owns exact ordinary, wrapped and multiline drafts', () => {
    expect(codexOwnsDraft(capture('› abc\n  def'), 'abcdef ')).toBe(true);
    expect(codexOwnsDraft(capture('› first paragraph\n\n  second paragraph'), 'first paragraph\n\nsecond paragraph ')).toBe(true);
    expect(codexOwnsDraft(capture('! git status'), '!git status')).toBe(true);
    expect(codexOwnsDraft(capture('› owned draft plus operator changes'), 'owned draft ')).toBe(false);
    expect(codexOwnsDraft(capture('› [Pasted Content 81 chars] plus edits'), `${'😀'.repeat(80)} `)).toBe(false);
    expect(codexOwnsDraft(capture('› unrelated draft'), 'owned draft ')).toBe(false);
  });

  // equal-length rich pastes cannot establish ownership of hidden content
  it('keeps exact collapsed-paste ownership inconclusive', () => {
    const pane = capture('› [Pasted Content 81 chars]');
    expect(codexDraftState(pane, `${'😀'.repeat(80)} `)).toBe('visible');
    expect(codexOwnsDraft(pane, `${'😀'.repeat(80)} `)).toBeUndefined();
    expect(codexOwnsDraft(pane, `${'😎'.repeat(80)} `)).toBeUndefined();
  });

  // maximum-sized drafts must not compile unbounded ownership regexes
  it('bounds ownership matching for cropped and edited large drafts', () => {
    const prompt = `${'x'.repeat(32_000)} `;
    expect(codexOwnsDraft(capture(`› ${'x'.repeat(64)}`), prompt)).toBeUndefined();
    expect(codexOwnsDraft(capture(`› ${prompt} plus operator changes`), prompt)).toBe(false);
    expect(codexOwnsDraft(capture('› [Pasted Content 32001 chars] plus edits'), prompt)).toBe(false);
  });

  // historical quote syntax is not a live native selector
  it('preserves ownership beneath quoted numbered scrollback', () => {
    const pane = ['• prior output', '> 1. old quote', '> 2. another old quote', capture('› owned draft')].join('\n');
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(true);
  });

  // a native selector takes priority over its background composer
  it('keeps background drafts unknown while a native choice dialog owns input', () => {
    const pane = ['Choose an action', '❯ 1. Approve', '  2. Reject', capture('› owned draft')].join('\n');
    expect(codexDraftState(pane, 'owned draft ')).toBe('unknown');
    expect(codexOwnsDraft(pane, 'owned draft ')).toBe(false);
  });

  // accept every animation frame without changing the expected prompt
  it.each(sparkleDots)('recognizes a draft with %s in its blank cells', dot => {
    expect(codexDraftState(capture(animated(`›${dot}review,${dot}commit,${dot}and${dot}push`)), 'review, commit, and push ')).toBe('visible');
  });

  // acknowledge submission even while the empty composer animates
  it.each(sparkleDots)('recognizes a cleared composer with %s after its marker', dot => {
    expect(codexDraftState(capture(animated(`›${dot}Ask Codex to do anything`)), 'review, commit, and push ')).toBe('cleared');
  });

  // reset readiness must share the submission parser's decorative-blank handling
  it.each(sparkleDots)('recognizes an empty post-reset composer decorated with %s', dot => {
    expect(codexNewConversation.composerEmpty(capture(animated(`›${dot}Ask${dot}Codex to do anything`)))).toBe(true);
    expect(codexNewConversation.composerEmpty(capture(animated(`›${dot}`)))).toBe(true);
    expect(codexNewConversation.composerEmpty(capture(animated(`›${dot}draft`)))).toBe(false);
    expect(codexNewConversation.composerEmpty(capture(`› ${dot}`))).toBe(false);
  });

  // preserve visible tails through animated paragraph spacing
  it('matches the tail of a long multiline draft', () => {
    const prompt = 'Please inspect the entire prompt submission path and fix the race.\n\nKeep the change small and add a regression test.';
    const composer = '›⠁Please inspect the entire prompt submission path and fix the race.\n  ⠂\n ⠐Keep the change small⠄and add a regression test.';
    expect(codexDraftState(capture(animated(composer)), prompt)).toBe('visible');
  });

  // reproduce attachment paths wrapped inside a single token
  it.each([24, 40, 60])('matches attachment paths wrapped across %s-column composer rows', width => {
    const path = '@node_modules/.remote-agent-console/attachments/abcdefghijklmnop/notes[final].txt';
    const prompt = `Review this attachment.\n\nAttached files:\n${path} `;
    // preserve row boundaries from the narrow terminal
    const rows = Array.from({ length: Math.ceil(path.length / width) }, (_value, index) => `  ${path.slice(index * width, (index + 1) * width)}`);
    const composer = ['› Review this attachment.', '', '  Attached files:', ...rows].join('\n');
    expect(codexDraftState(capture(composer), prompt)).toBe('visible');
    expect(codexDraftState(capture(composer), prompt.replace('final', 'other'))).toBe('cleared');
    expect(codexDraftState(capture(composer), prompt.replace('notes', 'no tes'))).toBe('cleared');
  });

  // preserve filename spaces and Unicode through multiple visual wraps
  it('matches wrapped attachment filenames containing spaces and emoji', () => {
    const path = '@node_modules/.remote-agent-console/attachments/abcdefghijklmnop/weather 🌤 notes.txt';
    const composer = ['› Read this.', '', '  Attached files:', '  @node_modules/.remote-agent-console/attach', '  ments/abcdefghijklmnop/weather', '  🌤 notes.txt'].join('\n');
    expect(codexDraftState(capture(composer), `Read this.\n\nAttached files:\n${path} `)).toBe('visible');
    expect(codexDraftState(capture(composer), `Read this.\n\nAttached files:\n${path.replace('notes', 'other')} `)).toBe('cleared');
  });

  // distinguish terminal wrapping from authored spaces within tokens
  it('matches wrapped short tokens without accepting different text', () => {
    expect(codexDraftState(capture('› abc\n  def'), 'abcdef ')).toBe('visible');
    expect(codexDraftState(capture('› abc def'), 'abcdef ')).toBe('cleared');
    expect(codexDraftState(capture('› abc\n  deg'), 'abcdef ')).toBe('cleared');
    expect(codexDraftState(capture('› abcdef'), 'abc def ')).toBe('cleared');
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
