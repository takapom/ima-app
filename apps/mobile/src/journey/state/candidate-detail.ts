export type CandidateDetailState = { readonly openCandidateId: string | null };

export const candidateDetailInitial: CandidateDetailState = { openCandidateId: null };

export const openCandidateDetail = (
  state: CandidateDetailState,
  candidateId: string,
): CandidateDetailState =>
  state.openCandidateId === candidateId ? state : { openCandidateId: candidateId };

export const closeCandidateDetail = (state: CandidateDetailState): CandidateDetailState =>
  state.openCandidateId === null ? state : candidateDetailInitial;

export const reconcileCandidateDetail = (
  state: CandidateDetailState,
  availableCandidateIds: readonly string[],
): CandidateDetailState =>
  state.openCandidateId === null || availableCandidateIds.includes(state.openCandidateId)
    ? state
    : closeCandidateDetail(state);

/** Even a reused candidate ID must be opened again after its card set is replaced. */
export const reconcileCandidateDetailScope = (
  state: CandidateDetailState,
  openedCardSetId: string | null,
  currentCardSetId: string | null,
  availableCandidateIds: readonly string[],
): CandidateDetailState =>
  reconcileCandidateDetail(
    state,
    openedCardSetId === currentCardSetId ? availableCandidateIds : [],
  );
