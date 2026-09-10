import { describe, expect, it } from 'vitest';
import { createJourneyShellState, journeyShellReducer } from './journey-shell';

describe('journey shell state', () => {
  it('ignores a blank request and keeps the draft available', () => {
    const initial = createJourneyShellState('thread-1');
    const drafted = journeyShellReducer(initial, { type: 'draftChanged', value: '  ' });
    const next = journeyShellReducer(drafted, { type: 'beginRequest', query: '  ' });

    expect(next).toBe(drafted);
    expect(next.phase).toBe('empty');
    expect(next.draft).toBe('  ');
  });

  it('keeps the original query and draft while a real request is pending', () => {
    const initial = journeyShellReducer(createJourneyShellState('thread-1'), {
      type: 'draftChanged',
      value: '恵比寿で静かに話したい。',
    });
    const next = journeyShellReducer(initial, {
      type: 'beginRequest',
      query: '  恵比寿で静かに話したい。  ',
    });

    expect(next.phase).toBe('working');
    expect(next.query).toBe('  恵比寿で静かに話したい。  ');
    expect(next.draft).toBe('恵比寿で静かに話したい。');
  });

  it('moves a completed message response out of working', () => {
    const working = journeyShellReducer(createJourneyShellState('thread-1'), {
      type: 'beginRequest',
      query: '近くで探して',
    });
    const responseState = {
      ...working.responseState,
      revision: 1,
      messages: [
        {
          text: '条件に合う候補はありませんでした。',
          evidenceIds: [],
          evidence: [],
          basis: 'conversational' as const,
          retention: {
            retentionDecision: 'deny' as const,
            retentionMode: 'session_only' as const,
            sessionExpiresAt: '2026-09-10T00:00:00Z',
            freshUntil: '2026-09-10T00:00:00Z',
            displayUntil: '2026-09-10T00:00:00Z',
            retentionUntil: null,
            deletionScheduledAt: null,
            attribution: null,
            restoreMode: 'reference_only' as const,
            policyStatus: 'policy_withheld' as const,
            displayPolicyStatus: 'available' as const,
          },
        },
      ],
    };
    const next = journeyShellReducer(working, { type: 'responseApplied', responseState });

    expect(next.phase).toBe('results');
    expect(next.responseState.messages).toHaveLength(1);
  });

  it('does not decide a candidate that is absent from the response', () => {
    const initial = createJourneyShellState('thread-1');
    const next = journeyShellReducer(initial, { type: 'decided', candidateId: 'missing' });

    expect(next).toBe(initial);
  });
});
