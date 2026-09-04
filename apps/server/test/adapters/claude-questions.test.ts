import { describe, expect, it } from 'vitest';
import { reportedClaudeQuestion } from '../../src/adapters/claude-questions.js';
import { inlineQuestionId } from '../../src/adapters/inline-questions.js';

type Option = { label: string; description?: string };
type Question = { question: string; header?: string; options?: Option[]; multiSelect?: boolean };

// encode a PreToolUse AskUserQuestion body the way the reporter stores it on the pane
const encode = (questions: Question[], overrides: Record<string, unknown> = {}): string =>
  Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions }, ...overrides })).toString('base64');

const deploy: Question = {
  question: 'Which environment should I deploy this build to, given that the staging database was refreshed this morning and production is under load?',
  header: 'Deploy target',
  options: [
    { label: 'Staging', description: 'Rehearse first' },
    { label: 'Production', description: 'Ship to live' },
    { label: 'Neither, hold the build until the smoke tests finish', description: 'Wait' },
  ],
};

// the dialog Claude draws for `deploy` at the given caret row (1-based), wide
const wideDialog = (caret = 1): string => [
  '❯ Read the file spec-single.json and call AskUserQuestion',
  '  Read 1 file (ctrl+o to expand)',
  '────────────────────────────────────────────────────────────',
  ' ☐ Deploy target',
  '',
  `│ ${deploy.question}`,
  '',
  `${caret === 1 ? '❯' : ' '} 1. Staging`,
  '     Rehearse first',
  `${caret === 2 ? '❯' : ' '} 2. Production`,
  '     Ship to live',
  '  3. Neither, hold the build until the smoke tests finish',
  '     Wait',
  '  4. Type something.',
  '────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

describe('reportedClaudeQuestion', () => {
  it('renders a single reported question with the option labels as its choices', () => {
    const choices = ['Staging', 'Production', 'Neither, hold the build until the smoke tests finish'];
    expect(reportedClaudeQuestion(encode([deploy]), wideDialog())).toEqual({
      id: inlineQuestionId(deploy.question, choices),
      text: deploy.question,
      choices,
      source: 'structured',
    });
  });

  it('matches the same question when the pane wraps it at a narrow width', () => {
    const choices = ['Staging', 'Production', 'Neither, hold the build until the smoke tests finish'];
    const narrow = [
      '  Read 1 file (ctrl+o to expand)',
      '──────────────────────────────',
      ' ☐ Deploy target',
      '',
      '│ Which environment should I deploy this build to, given',
      '│ that the staging database was refreshed this morning and',
      '│ production is under load?',
      '',
      '❯ 1. Staging',
      '     Rehearse first',
      '  2. Production',
      '  3. Neither, hold the build until the smoke tests finish',
      '     and then ask me again later today',
      '  4. Type something.',
    ].join('\n');
    // choices come from the payload (its id is width-independent), so the wrapped
    // capture must still be recognised as the same live question
    expect(reportedClaudeQuestion(encode([deploy]), narrow)).toEqual({
      id: inlineQuestionId(deploy.question, choices), text: deploy.question, choices, source: 'structured',
    });
  });

  it('still matches when the caret sits on another option', () => {
    const choices = ['Staging', 'Production', 'Neither, hold the build until the smoke tests finish'];
    expect(reportedClaudeQuestion(encode([deploy]), wideDialog(2))).toEqual({
      id: inlineQuestionId(deploy.question, choices), text: deploy.question, choices, source: 'structured',
    });
  });

  it('falls back to the first 48 characters when a narrow pane truncates the question', () => {
    const truncated = [
      ' ☐ Deploy target',
      '│ Which environment should I deploy this build to, gi…',
      '❯ 1. Staging',
      '  2. Production',
    ].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), truncated)?.text).toBe(deploy.question);
  });

  it('returns undefined once the dialog is answered (text on screen, no numbered row)', () => {
    const answered = [
      '● User answered Claude\'s questions:',
      `  ⎿  · ${deploy.question} → Production`,
      '',
      '● done',
      '❯ ',
    ].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), answered)).toBeUndefined();
  });

  it('returns undefined after an Esc cancel (the declined summary repeats the text)', () => {
    const declined = [
      '● User declined to answer questions',
      `  ⎿  · ${deploy.question} (Staging / Production / Neither...)`,
      '',
      '❯ ',
    ].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), declined)).toBeUndefined();
  });

  it('only considers the last 80 lines, so a dialog scrolled out of the window does not match', () => {
    const scrolledOut = [wideDialog(), ...Array.from({ length: 90 }, () => 'idle output line')].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), scrolledOut)).toBeUndefined();
  });

  it('requires the numbered row even when the question text is present', () => {
    const noRow = [' ☐ Deploy target', `│ ${deploy.question}`, '  (no options drawn)'].join('\n');
    expect(reportedClaudeQuestion(encode([deploy]), noRow)).toBeUndefined();
  });

  it('skips a multiSelect question even when its rows would otherwise match', () => {
    const multi: Question = { question: 'Which checks should run?', options: [{ label: 'Lint' }, { label: 'Unit tests' }], multiSelect: true };
    // a row-check-passing capture (no checkbox glyph) so the multiSelect guard, not
    // the row miss, is the sole reason this renders nothing
    const dialog = ['Which checks should run?', '❯ 1. Lint', '  2. Unit tests'].join('\n');
    expect(reportedClaudeQuestion(encode([multi]), dialog)).toBeUndefined();
  });

  it('skips an option-less text-kind question', () => {
    const text: Question = { question: 'What should this be called?' };
    const dialog = ['What should this be called?', '❯ 1. Type something.'].join('\n');
    expect(reportedClaudeQuestion(encode([text]), dialog)).toBeUndefined();
  });

  it('skips a call carrying several questions', () => {
    const region: Question = { question: 'Which region should host the deploy?', options: [{ label: 'us-east' }, { label: 'eu-west' }] };
    const rollout: Question = { question: 'How should the rollout proceed?', options: [{ label: 'Canary' }, { label: 'All at once' }] };
    const dialog = ['Which region should host the deploy?', '❯ 1. us-east', '  2. eu-west'].join('\n');
    expect(reportedClaudeQuestion(encode([region, rollout]), dialog)).toBeUndefined();
  });

  it('rejects fewer than two or more than sixteen options', () => {
    const one: Question = { question: 'Pick?', options: [{ label: 'Only' }] };
    const many: Question = { question: 'Pick?', options: Array.from({ length: 17 }, (_, i) => ({ label: `Option ${i}` })) };
    expect(reportedClaudeQuestion(encode([one]), 'Pick?\n❯ 1. Only')).toBeUndefined();
    expect(reportedClaudeQuestion(encode([many]), 'Pick?\n❯ 1. Option 0')).toBeUndefined();
  });

  it('rejects an option whose label is missing or not a string', () => {
    // three options, one label-less: two valid labels remain (so the < 2 guard does
    // not fire), and the completeness check is the sole reason this is rejected
    const holed = { question: 'Pick?', options: [{ label: 'Staging' }, { description: 'no label' }, { label: 'Production' }] } as unknown as Question;
    expect(reportedClaudeQuestion(encode([holed]), 'Pick?\n❯ 1. Staging\n  2. Production')).toBeUndefined();
  });

  it('rejects a non-PreToolUse or non-AskUserQuestion payload', () => {
    expect(reportedClaudeQuestion(encode([deploy], { hook_event_name: 'PostToolUse' }), wideDialog())).toBeUndefined();
    expect(reportedClaudeQuestion(encode([deploy], { tool_name: 'Bash' }), wideDialog())).toBeUndefined();
  });

  it('rejects a payload that is not valid base64 JSON', () => {
    expect(reportedClaudeQuestion('not+valid+base64+json', wideDialog())).toBeUndefined();
    expect(reportedClaudeQuestion(Buffer.from('not json').toString('base64'), wideDialog())).toBeUndefined();
    expect(reportedClaudeQuestion(Buffer.from('[]').toString('base64'), wideDialog())).toBeUndefined();
  });
});
