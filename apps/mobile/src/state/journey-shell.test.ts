import { describe, expect, it } from 'vitest';
import { createJourneyShellState, journeyShellReducer } from './journey-shell';
import { selectAssistantMessages } from './assistant-response';

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
    expect(next.requestState).toBe('pending');
    expect(next.query).toBe('  恵比寿で静かに話したい。  ');
    expect(next.draft).toBe('恵比寿で静かに話したい。');
  });

  it('cancels a pending request without dropping the editable draft', () => {
    const initial = journeyShellReducer(createJourneyShellState('thread-1'), {
      type: 'draftChanged',
      value: '  恵比寿で静かに話したい。  ',
    });
    const working = journeyShellReducer(initial, {
      type: 'beginRequest',
      query: initial.draft,
    });
    const cancelled = journeyShellReducer(working, { type: 'cancelRequest' });

    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.requestState).toBe('cancelled');
    expect(cancelled.draft).toBe(initial.draft);
    expect(cancelled.query).toBe(initial.draft);
  });

  it('keeps retry in the same raw query and records explicit chip removal', () => {
    const working = journeyShellReducer(createJourneyShellState('thread-1'), {
      type: 'beginRequest',
      query: '  静か。徒歩10分  ',
    });
    const failed = journeyShellReducer(working, {
      type: 'requestFailed',
      message: 'timeout',
    });
    const removed = journeyShellReducer(failed, { type: 'chipRemoved', label: '徒歩10分' });
    const retried = journeyShellReducer(removed, {
      type: 'beginRequest',
      query: removed.query,
    });

    expect(removed.removedChipLabels).toEqual(['徒歩10分']);
    expect(retried.requestState).toBe('pending');
    expect(retried.query).toBe('  静か。徒歩10分  ');
    expect(retried.chips).not.toContain('徒歩10分');
  });

  it('keeps thread conditions separate from saved settings', () => {
    const initial = createJourneyShellState('thread-1');
    const thread = journeyShellReducer(initial, {
      type: 'conditionChanged',
      scope: 'thread',
      changes: { stationLabel: '渋谷', maxWalkMinutes: 10 },
    });
    const saved = journeyShellReducer(thread, {
      type: 'conditionChanged',
      scope: 'saved',
      changes: { budget: 'cheap' },
    });

    expect(thread.conditions.stationLabel).toBe('渋谷');
    expect(saved.savedConditions.budget).toBe('cheap');
    expect(saved.conditions.budget).toBe('any');
  });

  it('preserves saved settings through reset and can seed a new thread', () => {
    const savedSettings = {
      ...createJourneyShellState('seed').savedConditions,
      stationLabel: '渋谷',
      maxWalkMinutes: 10,
    };
    const initial = createJourneyShellState('thread-1', savedSettings);
    const reset = journeyShellReducer(initial, { type: 'reset' });
    const nextThread = createJourneyShellState('thread-2', reset.savedConditions);

    expect(reset.savedConditions).toEqual(savedSettings);
    expect(reset.conditions).toEqual(savedSettings);
    expect(nextThread.conditions).toEqual(savedSettings);
  });

  it('removes a preference chip from effective conditions as well as from the UI list', () => {
    const withConditions = journeyShellReducer(createJourneyShellState('thread-1'), {
      type: 'conditionChanged',
      scope: 'thread',
      changes: { maxWalkMinutes: 10 },
    });
    const searching = journeyShellReducer(withConditions, {
      type: 'beginRequest',
      query: '静か',
    });
    const removed = journeyShellReducer(searching, { type: 'chipRemoved', label: '徒歩10分' });

    expect(removed.conditions.maxWalkMinutes).toBeNull();
    expect(removed.chips).not.toContain('徒歩10分');
    expect(removed.removedChipLabels).toContain('徒歩10分');
    const restored = journeyShellReducer(removed, {
      type: 'conditionChanged',
      scope: 'thread',
      changes: { maxWalkMinutes: 10 },
    });
    expect(restored.chips).toContain('徒歩10分');
    expect(restored.removedChipLabels).not.toContain('徒歩10分');
  });

  it('moves a completed message response out of working', () => {
    const working = journeyShellReducer(createJourneyShellState('thread-1'), {
      type: 'beginRequest',
      query: '近くで探して',
    });
    const responseState = {
      ...working.responseState,
      revision: 1,
      responseRecords: [
        {
          responseId: 'response-1',
          turnId: 'turn-1',
          revision: 1,
          kind: 'message' as const,
          presentation: 'keep' as const,
          declaredCardSetId: null,
          effectiveCardSetId: null,
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
        },
      ],
    };
    const next = journeyShellReducer(working, { type: 'responseApplied', responseState });

    expect(next.phase).toBe('results');
    expect(selectAssistantMessages(next.responseState)).toHaveLength(1);
  });

  it('does not decide a candidate that is absent from the response', () => {
    const initial = createJourneyShellState('thread-1');
    const next = journeyShellReducer(initial, { type: 'decided', candidateId: 'missing' });

    expect(next).toBe(initial);
  });
});
