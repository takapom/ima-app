import { describe, expect, it } from 'vitest';
import { createJourneyActionState, journeyActionReducer } from '../state/journey-actions';
import { submitContextFor } from './journey-screen-model';
import { createJourneyApiRequestFactory } from '../services/runtime/mobile-runtime';
import { createDefaultJourneyConditions } from '../state/journey-input';

describe('candidate feedback request', () => {
  it('sends the just-skipped candidate and preserves the thread and remaining cards', () => {
    const previous = {
      ...createJourneyActionState(),
      promotedCandidateId: 'hero',
      decidedCandidateId: 'hero',
    };
    const skipped = journeyActionReducer(
      previous,
      { type: 'skipTonight', candidateId: 'hero' },
      {
        query: '恵比寿のカフェ',
        candidateIds: ['hero', 'alt'],
      },
    );
    if (!skipped.accepted) throw new Error('skip was rejected');
    const context = submitContextFor(
      {
        conditions: createDefaultJourneyConditions(),
        removedChipLabels: [],
        cardSetId: 'cards',
        savedPlaceRefs: [],
      },
      skipped.state,
      ['hero', 'alt'],
    );
    const requests = createJourneyApiRequestFactory({
      now: () => '2026-09-10T00:00:00Z',
      idFactory: (kind) => `test-${kind}`,
    });
    const body = requests.turn({
      threadId: 'current-thread',
      revision: 3,
      turnId: 'current-turn',
      query: 'この候補はちがう。',
      context,
    });
    expect(body).toMatchObject({
      revision: 3,
      turnId: 'current-turn',
      text: 'この候補はちがう。',
      cardSetId: 'cards',
      excludeCandidateIds: ['hero'],
      candidateOrder: ['alt'],
      promotedCandidateId: null,
      selectedCandidateId: null,
    });
    expect(previous.tonightExcludedCandidateIds).toEqual([]);
    expect(
      journeyActionReducer(
        skipped.state,
        { type: 'skipTonight', candidateId: 'hero' },
        { query: '', candidateIds: ['hero', 'alt'] },
      ).accepted,
    ).toBe(false);
  });
});
