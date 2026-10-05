import { describe, expect, it } from 'vitest';
import { initialEntryStage, reduceEntryStage } from '@mobile/entry/state/entry-flow';

describe('entry flow', () => {
  it('starts every launch on the splash', () => {
    expect(initialEntryStage).toBe('splash');
  });

  it('asks how to start once the splash finishes', () => {
    expect(reduceEntryStage('splash', { type: 'splashFinished' })).toBe('choosing');
  });

  it('opens chat or questions from the choice', () => {
    expect(reduceEntryStage('choosing', { type: 'choose', route: 'chat' })).toBe('chat');
    expect(reduceEntryStage('choosing', { type: 'choose', route: 'questions' })).toBe('questions');
  });

  it('returns from questions to the choice', () => {
    expect(reduceEntryStage('questions', { type: 'questionsBack' })).toBe('choosing');
  });

  it('enters chat when the questions finish', () => {
    expect(reduceEntryStage('questions', { type: 'questionsFinished' })).toBe('chat');
  });

  it('keeps chat once entered', () => {
    expect(reduceEntryStage('chat', { type: 'questionsBack' })).toBe('chat');
    expect(reduceEntryStage('chat', { type: 'splashFinished' })).toBe('chat');
    expect(reduceEntryStage('chat', { type: 'choose', route: 'questions' })).toBe('chat');
  });

  it('ignores events that do not belong to the current stage', () => {
    expect(reduceEntryStage('splash', { type: 'choose', route: 'chat' })).toBe('splash');
    expect(reduceEntryStage('choosing', { type: 'questionsFinished' })).toBe('choosing');
    expect(reduceEntryStage('questions', { type: 'splashFinished' })).toBe('questions');
  });
});
