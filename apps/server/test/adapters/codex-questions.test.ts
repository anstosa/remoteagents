import { describe, expect, it } from 'vitest';
import { parseChoiceQuestion } from '../../src/adapters/codex-questions.js';
import { codexSubmission, parseCodexQuestion } from '../../src/adapters/codex-tui.js';

// render a menu with a movable highlight and an independent current value
const menu = (selected: number) => [
  'Select Model and Effort',
  // keep the current-value marker distinct from the keyboard cursor
  ...['First model (current)', 'Second model', 'Third model'].map((label, index) => `${index === selected ? '› ' : '  '}${index + 1}. ${label}`),
  'Press enter to confirm or esc to go back'
].join('\n');

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
