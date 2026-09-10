/**
 * Pure state for explicit candidate actions.
 *
 * The response cards remain owned by assistant-response state. This module only
 * keeps the user's selection and the IDs that should be sent with a later turn.
 */

export type RecoverIntent = {
  readonly mode: 'recover';
  readonly query: string;
  readonly excludeCandidateIds: readonly string[];
};

export type JourneyActionState = {
  readonly promotedCandidateId: string | null;
  readonly decidedCandidateId: string | null;
  readonly savedCandidateIds: readonly string[];
  readonly tonightExcludedCandidateIds: readonly string[];
  readonly recoverIntent: RecoverIntent | null;
};

export type JourneyActionContext = {
  readonly candidateIds: readonly string[];
  readonly query: string;
};

export type JourneyAction =
  | { readonly type: 'promote'; readonly candidateId: string }
  | { readonly type: 'decide'; readonly candidateId: string }
  | { readonly type: 'save'; readonly candidateId: string }
  | { readonly type: 'skipTonight'; readonly candidateId: string }
  | { readonly type: 'recover'; readonly candidateId: string };

export type JourneyActionEffect =
  { readonly type: 'none' } | { readonly type: 'recover'; readonly intent: RecoverIntent };

export type JourneyActionResult =
  | {
      readonly accepted: true;
      readonly state: JourneyActionState;
      readonly effect: JourneyActionEffect;
    }
  | {
      readonly accepted: false;
      readonly state: JourneyActionState;
      readonly reason:
        'candidate_not_found' | 'blank_query' | 'already_excluded' | 'candidate_not_decided';
    };

export const createJourneyActionState = (): JourneyActionState => ({
  promotedCandidateId: null,
  decidedCandidateId: null,
  savedCandidateIds: [],
  tonightExcludedCandidateIds: [],
  recoverIntent: null,
});

/** Keep tonight exclusions/saves while a new response reconciles its selection. */
export const reconcileJourneyActionContext = (
  state: JourneyActionState,
  candidateIds: readonly string[],
): JourneyActionState => ({
  ...state,
  promotedCandidateId:
    state.promotedCandidateId !== null && candidateIds.includes(state.promotedCandidateId)
      ? state.promotedCandidateId
      : null,
  decidedCandidateId:
    state.decidedCandidateId !== null && candidateIds.includes(state.decidedCandidateId)
      ? state.decidedCandidateId
      : null,
  recoverIntent: null,
});

export const resetJourneyActionContext = (): JourneyActionState => createJourneyActionState();

const accepted = (state: JourneyActionState, effect: JourneyActionEffect): JourneyActionResult => ({
  accepted: true,
  state,
  effect,
});

const rejected = (
  state: JourneyActionState,
  reason: Exclude<JourneyActionResult, { readonly accepted: true }>['reason'],
): JourneyActionResult => ({
  accepted: false,
  state,
  reason,
});

const hasCandidate = (context: JourneyActionContext, candidateId: string): boolean =>
  context.candidateIds.includes(candidateId);

const appendOnce = (values: readonly string[], value: string): readonly string[] =>
  values.includes(value) ? values : [...values, value];

export const journeyActionReducer = (
  state: JourneyActionState,
  action: JourneyAction,
  context: JourneyActionContext,
): JourneyActionResult => {
  if (!hasCandidate(context, action.candidateId)) {
    return rejected(state, 'candidate_not_found');
  }
  if (action.type !== 'save' && state.tonightExcludedCandidateIds.includes(action.candidateId)) {
    return rejected(state, 'already_excluded');
  }

  switch (action.type) {
    case 'promote':
      return accepted(
        { ...state, promotedCandidateId: action.candidateId, recoverIntent: null },
        { type: 'none' },
      );
    case 'decide':
      return accepted(
        {
          ...state,
          promotedCandidateId: action.candidateId,
          decidedCandidateId: action.candidateId,
          recoverIntent: null,
        },
        { type: 'none' },
      );
    case 'save':
      return accepted(
        {
          ...state,
          savedCandidateIds: appendOnce(state.savedCandidateIds, action.candidateId),
        },
        { type: 'none' },
      );
    case 'skipTonight':
      return accepted(
        {
          ...state,
          promotedCandidateId:
            state.promotedCandidateId === action.candidateId ? null : state.promotedCandidateId,
          decidedCandidateId:
            state.decidedCandidateId === action.candidateId ? null : state.decidedCandidateId,
          tonightExcludedCandidateIds: appendOnce(
            state.tonightExcludedCandidateIds,
            action.candidateId,
          ),
          recoverIntent: null,
        },
        { type: 'none' },
      );
    case 'recover': {
      if (state.decidedCandidateId !== action.candidateId) {
        return rejected(state, 'candidate_not_decided');
      }
      if (context.query.trim().length === 0) {
        return rejected(state, 'blank_query');
      }
      const excludeCandidateIds = appendOnce(state.tonightExcludedCandidateIds, action.candidateId);
      const intent: RecoverIntent = {
        mode: 'recover',
        query: context.query,
        excludeCandidateIds,
      };
      return accepted(
        {
          ...state,
          promotedCandidateId: null,
          decidedCandidateId: null,
          tonightExcludedCandidateIds: excludeCandidateIds,
          recoverIntent: intent,
        },
        { type: 'recover', intent },
      );
    }
  }
};

/**
 * Keep the cards in the response store and expose only the display order.
 */
export const selectJourneyCandidateOrder = (
  candidateIds: readonly string[],
  promotedCandidateId: string | null,
  tonightExcludedCandidateIds: readonly string[] = [],
): readonly string[] => {
  const availableCandidateIds = candidateIds.filter(
    (candidateId) => !tonightExcludedCandidateIds.includes(candidateId),
  );
  if (promotedCandidateId === null || !availableCandidateIds.includes(promotedCandidateId)) {
    return availableCandidateIds;
  }
  return [promotedCandidateId, ...availableCandidateIds.filter((id) => id !== promotedCandidateId)];
};
