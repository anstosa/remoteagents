import { describe, expect, it } from 'vitest';
import { parseChoiceQuestion, queuedCodexQuestion } from '../../src/adapters/codex-questions.js';
import { codexSubmission, parseCodexQuestion } from '../../src/adapters/codex-tui.js';

// render a menu with a movable highlight and an independent current value
const menu = (selected: number) => [
  'Select Model and Effort',
  // keep the current-value marker distinct from the keyboard cursor
  ...['First model (current)', 'Second model', 'Third model'].map((label, index) => `${index === selected ? '› ' : '  '}${index + 1}. ${label}`),
  'Press enter to confirm or esc to go back'
].join('\n');

// match only Codex's collapsed native question entry point
describe('queued Codex questions', () => {
  const banner = '• Queued follow-up inputs\n  ? 2 questions · 15s\n    alt + ↑ to answer';
  // honor the shortcut actually advertised by the current keymap
  it.each([['alt + ↑', 'M-Up'], ['⌥ + ↑', 'M-Up'], ['shift + ←', 'S-Left']])('opens with %s', (hint, key) => {
    const capture = banner.replace('alt + ↑', hint) + '\n\n› Ask Codex to do anything\n  gpt-6-astra xhigh · /repo · main';
    expect(queuedCodexQuestion(capture)).toEqual({ key });
  });
  // tolerate styled singular summaries without a countdown
  it('reads styled singular footers', () => {
    expect(queuedCodexQuestion('\x1b[2m• Queued follow-up inputs\n  ? 1 question\n    alt + ↑ to answer\x1b[0m')).toEqual({ key: 'M-Up' });
  });
  // preserve the default composer help footer
  it('allows the shortcut and context footer', () => {
    expect(queuedCodexQuestion(`${banner}\n› Ask Codex to do anything\n? for shortcuts            100% context left`)).toEqual({ key: 'M-Up' });
  });
  // keep expanded native questions distinct from an empty queue
  it('recognizes an expanded editor without an opening key', () => {
    expect(queuedCodexQuestion('• Queued follow-up inputs\nWhich approach?\n› 1. Small\n  2. Other\nenter submit   ctrl + ] skip   shift + → main prompt')).toEqual({});
    expect(queuedCodexQuestion('• Queued follow-up inputs\nWhich approach?\n› 1. Small\n  2. Other\nenter submit   ctrl + ] skip\nshift + → main prompt')).toEqual({});
  });
  // never treat messages, old output, open dialogs, or unknown bindings as an opener
  it.each([
    '• Queued follow-up inputs\n  ↳ follow up\n  alt + ↑ edit last queued message',
    'Here is a queued question: ? 2 questions\nalt + ↑ to answer',
    banner.replace('2 questions', '0 questions'),
    banner.replace('alt + ↑', 'ctrl + g'),
    `${banner}\n› next prompt\n• Working`,
    `${banner}\n› next prompt\n• Working (0s • esc to interrupt) · Running hook`,
    `${banner}\nChoose a model\n› 1. First\n  2. Second`,
    `${banner}\n• Queued follow-up inputs\n  ↳ ordinary message`
  ])('ignores non-live or unsupported footer %s', capture => {
    expect(queuedCodexQuestion(capture)).toBeUndefined();
  });
});

// lock cursor-aware parsing without changing question identity
describe('Codex menu highlight', () => {
  // keep the displayed cursor position separate from the choice labels
  it('retains the highlighted choice and keeps the id stable when it moves', () => {
    const first = parseChoiceQuestion(menu(0));
    const second = parseChoiceQuestion(menu(1));
    expect(first).toMatchObject({ selectedIndex: 0 });
    expect(second).toMatchObject({ selectedIndex: 1, choices: ['First model (current)', 'Second model', 'Third model'] });
    expect(second?.id).toBe(first?.id);
  });

  // parse colored reasoning menus without treating a checked box as the cursor
  it('uses the caret rather than a checked option', () => {
    const question = parseChoiceQuestion('Choose reasoning\n  [x] 1. Low\n\x1b[32m❯ [ ] 2. High\x1b[0m\n  [ ] 3. Extra high');
    expect(question).toMatchObject({ selectedIndex: 1, choices: ['Low', 'High', 'Extra high'] });
  });

  // preserve the existing fallback for noninteractive numbered lists
  it('leaves the cursor unspecified when there is no highlight', () => {
    expect(parseChoiceQuestion('Which environment?\n1. Staging\n2. Production')).not.toHaveProperty('selectedIndex');
  });

  // quoted or malformed lists do not identify a unique keyboard cursor
  it.each(['>', '›', '❯'])('ignores ambiguous %s markers on multiple rows', marker => {
    const question = parseChoiceQuestion(`Which environment?\n${marker} 1. Staging\n${marker} 2. Production\n${marker} 3. Cancel`);
    expect(question).toMatchObject({ choices: ['Staging', 'Production', 'Cancel'] });
    expect(question).not.toHaveProperty('selectedIndex');
  });
});

// exercise the shared menu once; adapter contracts cover Codex and OMX wiring
describe('Codex menu navigation', () => {
  // navigate from every highlighted row to every requested row
  it.each([
    { selected: 1, index: 0, keys: ['Up', 'Enter'] },
    { selected: 1, index: 1, keys: ['Enter'] },
    { selected: 1, index: 2, keys: ['Down', 'Enter'] },
    { selected: 2, index: 0, keys: ['Up', 'Up', 'Enter'] },
    { selected: 0, index: 2, keys: ['Down', 'Down', 'Enter'] }
  ])('selects index $index from highlighted index $selected', ({ selected, index, keys }) => {
    const question = parseCodexQuestion(menu(selected));
    expect(question).toMatchObject({ selectedIndex: selected });
    expect(codexSubmission.selectOption(index, question?.selectedIndex)).toEqual(keys);
  });
});
