import { describe, expect, it } from 'vitest';
import { inlineQuestionId } from '../../src/adapters/codex-questions.js';

describe('inlineQuestionId', () => {
  it('is a stable 22-char base64url hash of the text and choices', () => {
    // pinned so a constant-id regression (e.g. returning a fixed string) fails here
    expect(inlineQuestionId('a', ['b', 'c'])).toBe('i63eEMdg6bcC3vtLXiJd55');
    expect(inlineQuestionId('a', ['b', 'c'])).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });

  it('separates the text from the choices so a shift between them changes the id', () => {
    // NUL-joining the fields keeps ('a', ['b','c']) distinct from ('a\0b', ['c'])
    expect(inlineQuestionId('a', ['bc'])).not.toBe(inlineQuestionId('a', ['b', 'c']));
    expect(inlineQuestionId('a', ['b', 'c'])).not.toBe(inlineQuestionId('a', ['b', 'd']));
    expect(inlineQuestionId('a', ['b', 'c'])).not.toBe(inlineQuestionId('x', ['b', 'c']));
  });
});
