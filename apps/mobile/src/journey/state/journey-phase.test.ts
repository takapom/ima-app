import { describe, expect, it } from 'vitest';
import { resolveJourneyPhase } from '@mobile/journey/state/journey-phase';

describe('journey phase projection', () => {
  it('keeps decided as a render phase only while its selected card exists', () => {
    expect(resolveJourneyPhase('idle', 'decided', true, true)).toBe('decided');
    expect(resolveJourneyPhase('idle', 'decided', true, false)).toBe('results');
    expect(resolveJourneyPhase('idle', 'decided', false, false)).toBe('empty');
  });

  it('shows recovery as working even while the previous cards remain mounted', () => {
    expect(resolveJourneyPhase('idle', 'working', true, false)).toBe('working');
  });

  it('moves pending to results when a newer response revision arrives', () => {
    expect(resolveJourneyPhase('pending', 'working', true, false)).toBe('working');
    expect(resolveJourneyPhase('idle', 'working', true, false, true)).toBe('results');
  });

  it('does not let a new card set inherit the old decided phase', () => {
    expect(resolveJourneyPhase('idle', 'results', true, true)).toBe('results');
  });

  it('lets an external failed recovery request own the error phase', () => {
    expect(resolveJourneyPhase('error', 'working', true, false)).toBe('error');
  });

  it('derives results from idle request status and mounted cards', () => {
    expect(resolveJourneyPhase('idle', 'empty', true, false)).toBe('results');
    expect(resolveJourneyPhase('idle', 'results', false, false)).toBe('empty');
  });
});
