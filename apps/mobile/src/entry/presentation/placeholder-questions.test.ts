import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_QUESTIONS,
  questionProgress,
} from '@mobile/entry/presentation/placeholder-questions';

describe('placeholder questions', () => {
  it('asks only conditions the product can search with', () => {
    const text = PLACEHOLDER_QUESTIONS.flatMap((question) => [question.title, ...question.options]);
    expect(PLACEHOLDER_QUESTIONS.length).toBeGreaterThan(0);
    expect(text.some((value) => /徒歩|移動|終電|車|公共交通/.test(value))).toBe(false);
  });

  it('offers a choice for every question', () => {
    expect(PLACEHOLDER_QUESTIONS.every((question) => question.options.length >= 2)).toBe(true);
  });

  it('fills one progress segment per answered question', () => {
    expect(questionProgress(0, 3)).toEqual([false, false, false]);
    expect(questionProgress(2, 3)).toEqual([true, true, false]);
    expect(questionProgress(3, 3)).toEqual([true, true, true]);
  });

  it('clamps progress to the number of questions', () => {
    expect(questionProgress(5, 3)).toEqual([true, true, true]);
    expect(questionProgress(-1, 3)).toEqual([false, false, false]);
  });
});
