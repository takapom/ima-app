import { describe, expect, it } from 'vitest';
import {
  FOOD_LABELS,
  composeQuestionQuery,
  progressSegments,
  questionsFor,
} from '@mobile/entry/presentation/entry-questions';

describe('entry questions', () => {
  it('asks five questions in order', () => {
    expect(questionsFor({}).map((question) => question.id)).toEqual([
      'party',
      'food',
      'style',
      'budget',
      'mood',
    ]);
  });

  it('asks about the style of the chosen food', () => {
    const japanese = questionsFor({ food: '和食' })[2];
    const chinese = questionsFor({ food: '中華' })[2];
    expect(japanese?.title).toBe('和食の系統は？');
    expect(japanese?.options.map((option) => option.label)).toContain('定食');
    expect(chinese?.title).toBe('中華の系統は？');
    expect(chinese?.options.map((option) => option.label)).toContain('ラーメン');
  });

  it('offers a choice for every question whichever food is chosen', () => {
    for (const food of FOOD_LABELS) {
      expect(questionsFor({ food }).every((question) => question.options.length >= 2)).toBe(true);
    }
  });

  it('asks only conditions the product can search with', () => {
    const text = FOOD_LABELS.flatMap((food) =>
      questionsFor({ food }).flatMap((question) => [
        question.title,
        ...question.options.flatMap((option) => [option.label, option.phrase ?? '']),
      ]),
    );
    expect(text.some((value) => /徒歩|移動|終電|車|公共交通|帰宅/.test(value))).toBe(false);
  });
});

describe('question query', () => {
  it('turns the answers into one chat message in question order', () => {
    expect(
      composeQuestionQuery({
        mood: '個室がいい',
        budget: '〜4,000円',
        style: '定食',
        food: '和食',
        party: '友人',
      }),
    ).toBe('友だちと。和食の定食がいい。予算は4,000円くらいまで。個室があるとうれしい。');
  });

  it('falls back to the food when the style does not matter', () => {
    expect(composeQuestionQuery({ party: '家族', food: '和食', style: 'こだわらない' })).toBe(
      '家族と。和食がいい。',
    );
  });

  it('drops a style left over from a food that was changed afterwards', () => {
    expect(composeQuestionQuery({ food: '中華', style: '定食' })).toBe('中華がいい。');
  });

  it('says budget does not matter and leaves out a mood that does not matter', () => {
    expect(composeQuestionQuery({ budget: 'いくらでも', mood: 'こだわらない' })).toBe(
      '予算は気にしない。',
    );
  });

  it('leaves out questions that were not answered or answers it does not know', () => {
    expect(composeQuestionQuery({ party: 'カップル', food: '存在しない' })).toBe('恋人と。');
    expect(composeQuestionQuery({})).toBe('');
  });
});

describe('question progress', () => {
  it('marks answered questions done and the next one current', () => {
    expect(progressSegments(0, 5)).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
    expect(progressSegments(2, 5)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
  });

  it('marks every question done once all are answered', () => {
    expect(progressSegments(5, 5)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('clamps out-of-range counts', () => {
    expect(progressSegments(9, 3)).toEqual(['done', 'done', 'done']);
    expect(progressSegments(-1, 3)).toEqual(['current', 'todo', 'todo']);
  });
});
