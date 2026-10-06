import { describe, expect, it } from 'vitest';
import {
  chatReadiness,
  entryCovers,
  initialEntryStage,
  introMayStart,
  reduceEntryStage,
} from '@mobile/entry/state/entry-flow';

describe('chat readiness', () => {
  it('is ready once the chat has a connected binding', () => {
    expect(chatReadiness({ connected: true, status: 'ready' })).toBe('ready');
    expect(chatReadiness({ connected: true, status: 'loading' })).toBe('ready');
  });

  it('is preparing while the runtime is still loading', () => {
    expect(chatReadiness({ connected: false, status: 'loading' })).toBe('preparing');
  });

  it('is unavailable when the runtime failed or produced no binding', () => {
    expect(chatReadiness({ connected: false, status: 'error' })).toBe('unavailable');
    expect(chatReadiness({ connected: false, status: 'ready' })).toBe('unavailable');
  });
});

describe('entry coverage', () => {
  it('keeps the splash up while the chat is preparing, but does not move on', () => {
    expect(entryCovers('splash', 'preparing')).toBe(true);
    expect(introMayStart('preparing')).toBe(false);
  });

  it('plays the splash and the choice once the chat is ready', () => {
    expect(entryCovers('splash', 'ready')).toBe(true);
    expect(entryCovers('choosing', 'ready')).toBe(true);
    expect(entryCovers('questions', 'ready')).toBe(true);
    expect(entryCovers('complete', 'ready')).toBe(true);
    expect(introMayStart('ready')).toBe(true);
  });

  it('gets out of the way of the connection and error screens', () => {
    expect(entryCovers('splash', 'unavailable')).toBe(false);
    expect(entryCovers('choosing', 'unavailable')).toBe(false);
    expect(entryCovers('questions', 'unavailable')).toBe(false);
    expect(introMayStart('unavailable')).toBe(false);
  });

  it('stops covering once the chat has been entered', () => {
    expect(entryCovers('chat', 'ready')).toBe(false);
  });
});

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

  it('shows the completion once the questions finish, then enters chat', () => {
    expect(reduceEntryStage('questions', { type: 'questionsFinished' })).toBe('complete');
    expect(reduceEntryStage('complete', { type: 'completionFinished' })).toBe('chat');
  });

  it('cannot go back from the completion', () => {
    expect(reduceEntryStage('complete', { type: 'questionsBack' })).toBe('complete');
    expect(reduceEntryStage('complete', { type: 'choose', route: 'chat' })).toBe('complete');
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
    expect(reduceEntryStage('questions', { type: 'completionFinished' })).toBe('questions');
  });
});
