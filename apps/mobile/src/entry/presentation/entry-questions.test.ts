import { describe, expect, it } from 'vitest';
import {
  ENTRY_QUESTIONS,
  composeQuestionQuery,
  questionProgress,
} from '@mobile/entry/presentation/entry-questions';

describe('entry questions', () => {
  it('asks only conditions the product can search with', () => {
    const text = ENTRY_QUESTIONS.flatMap((question) => [
      question.title,
      ...question.options.flatMap((option) => [option.label, option.phrase]),
    ]);
    expect(ENTRY_QUESTIONS.length).toBeGreaterThan(0);
    expect(text.some((value) => /徒歩|移動|終電|車|公共交通|帰宅/.test(value))).toBe(false);
  });

  it('offers a choice for every question', () => {
    expect(ENTRY_QUESTIONS.every((question) => question.options.length >= 2)).toBe(true);
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

describe('question query', () => {
  it('turns the answers into one chat message in question order', () => {
    expect(composeQuestionQuery({ budget: '〜4,000円', party: '友人', food: '和食' })).toBe(
      '友だちと。和食がいい。予算は4,000円くらいまで。',
    );
  });

  it('says budget does not matter when any budget is fine', () => {
    expect(composeQuestionQuery({ party: '家族', food: '中華', budget: 'いくらでも' })).toBe(
      '家族と。中華がいい。予算は気にしない。',
    );
  });

  it('leaves out questions that were not answered or answers it does not know', () => {
    expect(composeQuestionQuery({ party: 'カップル', food: '存在しない' })).toBe('恋人と。');
    expect(composeQuestionQuery({})).toBe('');
  });
});
