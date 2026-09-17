import { describe, expect, it } from 'vitest';
import {
  applyTurnConstraintsForTurn,
  TurnConstraintError,
  validateModelActionMetadata,
  validateTurnConstraintsProposal,
} from '@core/application/turn-constraints';

const context = {
  threadId: 'thread-1',
  originalTurns: [
    { threadId: 'thread-1', turnId: 'turn-1', text: '徒歩15分以内で静かな店' },
    { threadId: 'thread-1', turnId: 'turn-2', text: '渋谷駅に帰りたい。二つ目の理由は？' },
  ],
};

const validProposal = {
  changes: [
    { maxWalkMinutes: 15, sourceTurnId: 'turn-1', quote: '徒歩15分以内' },
    { homeStationRef: 'station-shibuya', sourceTurnId: 'turn-2', quote: '渋谷駅に帰りたい' },
  ],
};

function expectConstraintError(action: () => unknown, code: TurnConstraintError['code']): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TurnConstraintError);
  if (error instanceof TurnConstraintError) expect(error.code).toBe(code);
}

describe('turn constraint proposals', () => {
  it('accepts source-turn exact quotes and leaves saved preferences outside the proposal', () => {
    const result = validateTurnConstraintsProposal(validProposal, context);
    expect(result).toEqual(validProposal);

    const metadata = validateModelActionMetadata({ turnConstraints: validProposal }, context);
    expect(metadata).toEqual({ turnConstraints: validProposal });
  });

  it('rejects a quote that is not an exact substring of the original turn', () => {
    expectConstraintError(
      () =>
        validateTurnConstraintsProposal(
          {
            changes: [{ maxWalkMinutes: 10, sourceTurnId: 'turn-1', quote: '徒歩10分以内' }],
          },
          context,
        ),
      'QUOTE_NOT_FOUND',
    );
  });

  it('rejects a source turn from another thread, duplicate source, and missing value', () => {
    expectConstraintError(
      () =>
        validateTurnConstraintsProposal(
          { changes: [{ maxWalkMinutes: 10, sourceTurnId: 'turn-foreign', quote: '条件' }] },
          context,
        ),
      'SOURCE_TURN_NOT_FOUND',
    );
    expectConstraintError(
      () =>
        validateTurnConstraintsProposal(
          { changes: [{ maxWalkMinutes: 10, sourceTurnId: 'turn-foreign', quote: '条件' }] },
          {
            ...context,
            originalTurns: [
              ...context.originalTurns,
              { threadId: 'thread-foreign', turnId: 'turn-foreign', text: '条件' },
            ],
          },
        ),
      'SOURCE_THREAD_MISMATCH',
    );
    expectConstraintError(
      () =>
        validateTurnConstraintsProposal(
          {
            changes: [
              { maxWalkMinutes: 10, sourceTurnId: 'turn-1', quote: '徒歩15分以内' },
              { minimumStayMinutes: 20, sourceTurnId: 'turn-1', quote: '徒歩15分以内' },
            ],
          },
          context,
        ),
      'INVALID_PROPOSAL',
    );
    expectConstraintError(
      () =>
        validateTurnConstraintsProposal(
          { changes: [{ sourceTurnId: 'turn-1', quote: '徒歩15分以内' }] },
          context,
        ),
      'INVALID_PROPOSAL',
    );
  });

  it('rejects unknown properties instead of treating preference mutation as accepted', () => {
    expectConstraintError(
      () =>
        validateModelActionMetadata(
          {
            turnConstraints: validProposal,
            savedPreferences: { maxWalkMinutes: 5 },
          },
          context,
        ),
      'INVALID_PROPOSAL',
    );
    expect(validateModelActionMetadata({}, context)).toEqual({});
  });

  it('applies validated changes to a copied current-turn condition set only', () => {
    const current = {
      maxWalkMinutes: 30,
      homeStationRef: 'station-shinjuku',
      minimumStayMinutes: 20,
    };
    const next = applyTurnConstraintsForTurn(current, validProposal, context);

    expect(next).toEqual({
      maxWalkMinutes: 15,
      homeStationRef: 'station-shibuya',
      minimumStayMinutes: 20,
    });
    expect(current).toEqual({
      maxWalkMinutes: 30,
      homeStationRef: 'station-shinjuku',
      minimumStayMinutes: 20,
    });
    expect(() =>
      applyTurnConstraintsForTurn(
        current,
        { changes: [{ maxWalkMinutes: 10, sourceTurnId: 'turn-1', quote: '存在しない条件' }] },
        context,
      ),
    ).toThrowError(TurnConstraintError);
  });
});
