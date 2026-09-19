import { describe, expect, it } from 'vitest';
import {
  createJourneyActionState,
  journeyActionReducer,
  reconcileJourneyActionContext,
  selectJourneyCandidateOrder,
  type JourneyActionContext,
} from '@mobile/journey/state/journey-actions';

const context: JourneyActionContext = {
  candidateIds: ['hero', 'alt-1', 'alt-2'],
  query: '  恵比寿で静かに話したい  ',
};

describe('journey candidate actions', () => {
  it('promotes an existing alternative without copying card data', () => {
    const result = journeyActionReducer(
      createJourneyActionState(),
      { type: 'promote', candidateId: 'alt-1' },
      context,
    );

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.state.promotedCandidateId).toBe('alt-1');
    expect(
      selectJourneyCandidateOrder(context.candidateIds, result.state.promotedCandidateId),
    ).toEqual(['alt-1', 'hero', 'alt-2']);
  });

  it('rejects a candidate absent from the current response', () => {
    const initial = createJourneyActionState();
    const result = journeyActionReducer(
      initial,
      { type: 'decide', candidateId: 'missing' },
      context,
    );

    expect(result).toEqual({
      accepted: false,
      state: initial,
      reason: 'candidate_not_found',
    });
  });

  it('keeps a save idempotent in local action state', () => {
    const first = journeyActionReducer(
      createJourneyActionState(),
      { type: 'save', candidateId: 'hero' },
      context,
    );
    if (!first.accepted) throw new Error('save should be accepted');
    const second = journeyActionReducer(
      first.state,
      { type: 'save', candidateId: 'hero' },
      context,
    );

    expect(second.accepted).toBe(true);
    if (!second.accepted) return;
    expect(second.state.savedCandidateIds).toEqual(['hero']);
  });

  it('records a tonight-only skip without a permanent never label', () => {
    const promoted = journeyActionReducer(
      createJourneyActionState(),
      { type: 'promote', candidateId: 'hero' },
      context,
    );
    if (!promoted.accepted) throw new Error('promote should be accepted');
    const result = journeyActionReducer(
      promoted.state,
      { type: 'skipTonight', candidateId: 'hero' },
      context,
    );

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.state.tonightExcludedCandidateIds).toEqual(['hero']);
    expect(result.state.promotedCandidateId).toBeNull();
    expect(result.state.recoverIntent).toBeNull();
    expect(result.state).not.toHaveProperty('never');
  });

  it('keeps another selected candidate when skipping a different alternative', () => {
    const decided = journeyActionReducer(
      createJourneyActionState(),
      { type: 'decide', candidateId: 'hero' },
      context,
    );
    if (!decided.accepted) throw new Error('decide should be accepted');
    const skipped = journeyActionReducer(
      decided.state,
      { type: 'skipTonight', candidateId: 'alt-1' },
      context,
    );

    expect(skipped.accepted).toBe(true);
    if (!skipped.accepted) return;
    expect(skipped.state.decidedCandidateId).toBe('hero');
    expect(
      selectJourneyCandidateOrder(
        context.candidateIds,
        skipped.state.promotedCandidateId,
        skipped.state.tonightExcludedCandidateIds,
      ),
    ).toEqual(['hero', 'alt-2']);
  });

  it('rejects promote and decide for a candidate already skipped tonight', () => {
    const skipped = journeyActionReducer(
      createJourneyActionState(),
      { type: 'skipTonight', candidateId: 'alt-1' },
      context,
    );
    if (!skipped.accepted) throw new Error('skip should be accepted');
    const promoted = journeyActionReducer(
      skipped.state,
      { type: 'promote', candidateId: 'alt-1' },
      context,
    );
    const decided = journeyActionReducer(
      skipped.state,
      { type: 'decide', candidateId: 'alt-1' },
      context,
    );

    expect(promoted).toEqual({
      accepted: false,
      state: skipped.state,
      reason: 'already_excluded',
    });
    expect(decided).toEqual({
      accepted: false,
      state: skipped.state,
      reason: 'already_excluded',
    });
  });

  it('keeps an explicit save intent after a tonight-only skip', () => {
    const skipped = journeyActionReducer(
      createJourneyActionState(),
      { type: 'skipTonight', candidateId: 'hero' },
      context,
    );
    if (!skipped.accepted) throw new Error('skip should be accepted');

    const saved = journeyActionReducer(
      skipped.state,
      { type: 'save', candidateId: 'hero' },
      context,
    );

    expect(saved.accepted).toBe(true);
    if (!saved.accepted) return;
    expect(saved.state.tonightExcludedCandidateIds).toEqual(['hero']);
    expect(saved.state.savedCandidateIds).toEqual(['hero']);
  });

  it('creates recover with the raw query and the selected exclusion', () => {
    const decided = journeyActionReducer(
      createJourneyActionState(),
      { type: 'decide', candidateId: 'hero' },
      context,
    );
    if (!decided.accepted) throw new Error('decide should be accepted');
    const recovered = journeyActionReducer(
      decided.state,
      { type: 'recover', candidateId: 'hero' },
      context,
    );

    expect(recovered.accepted).toBe(true);
    if (!recovered.accepted || recovered.effect.type !== 'recover') return;
    expect(recovered.effect.intent).toEqual({
      mode: 'recover',
      query: context.query,
      excludeCandidateIds: ['hero'],
    });
    expect(recovered.state.decidedCandidateId).toBeNull();
  });

  it('does not create recover from a blank query or an unselected candidate', () => {
    const initial = createJourneyActionState();
    const notDecided = journeyActionReducer(
      initial,
      { type: 'recover', candidateId: 'hero' },
      context,
    );
    expect(notDecided.accepted).toBe(false);
    if (notDecided.accepted) return;
    expect(notDecided.reason).toBe('candidate_not_decided');

    const decided = journeyActionReducer(
      createJourneyActionState(),
      { type: 'decide', candidateId: 'hero' },
      context,
    );
    if (!decided.accepted) throw new Error('decide should be accepted');
    const blank = journeyActionReducer(
      decided.state,
      { type: 'recover', candidateId: 'hero' },
      { ...context, query: '  ' },
    );
    expect(blank.accepted).toBe(false);
    if (!blank.accepted) expect(blank.reason).toBe('blank_query');
  });

  it('returns the existing order when no promoted candidate is available', () => {
    expect(selectJourneyCandidateOrder(context.candidateIds, null)).toEqual(context.candidateIds);
    expect(selectJourneyCandidateOrder(context.candidateIds, 'missing')).toEqual(
      context.candidateIds,
    );
  });

  it('keeps a selected candidate for a retained card set and drops missing candidates on replace', () => {
    const promoted = journeyActionReducer(
      createJourneyActionState(),
      { type: 'promote', candidateId: 'alt-1' },
      context,
    );
    if (!promoted.accepted) throw new Error('promote should be accepted');
    const decided = journeyActionReducer(
      promoted.state,
      { type: 'decide', candidateId: 'alt-1' },
      context,
    );
    if (!decided.accepted) throw new Error('decide should be accepted');

    expect(reconcileJourneyActionContext(decided.state, context.candidateIds)).toEqual(
      decided.state,
    );
    expect(reconcileJourneyActionContext(decided.state, ['hero', 'alt-2'])).toMatchObject({
      promotedCandidateId: null,
      decidedCandidateId: null,
    });
  });

  it('applies a late save result to the latest selection without replacing it', () => {
    const promoted = journeyActionReducer(
      createJourneyActionState(),
      { type: 'promote', candidateId: 'alt-1' },
      context,
    );
    if (!promoted.accepted) throw new Error('promote should be accepted');

    const saved = journeyActionReducer(
      promoted.state,
      { type: 'save', candidateId: 'hero' },
      context,
    );

    expect(saved.accepted).toBe(true);
    if (!saved.accepted) return;
    expect(saved.state.promotedCandidateId).toBe('alt-1');
    expect(saved.state.savedCandidateIds).toEqual(['hero']);
  });

  it('keeps completed saves while a response is retained or replaced', () => {
    const saved = journeyActionReducer(
      createJourneyActionState(),
      { type: 'save', candidateId: 'hero' },
      context,
    );
    if (!saved.accepted) throw new Error('save should be accepted');

    expect(
      reconcileJourneyActionContext(saved.state, context.candidateIds).savedCandidateIds,
    ).toEqual(['hero']);
    expect(reconcileJourneyActionContext(saved.state, ['new-hero']).savedCandidateIds).toEqual([
      'hero',
    ]);
  });
});
