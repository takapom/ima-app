import type {
  CandidateRegistration,
  CandidateRecord,
  CancellationToken,
  DetailField,
  HarnessContext,
  RegistryScope,
  SavedPlaceReference,
  SavedPlaceRef,
  ToolExecutionContext,
} from '@ima/core';
export type SavedReferenceProviderRefreshRequest = {
  readonly savedPlaceRef: SavedPlaceRef;
  readonly reference: SavedPlaceReference;
  readonly scope: RegistryScope;
  readonly fields: readonly DetailField[];
  readonly context: HarnessContext;
  readonly execution: ToolExecutionContext;
  readonly cancellation: CancellationToken;
  readonly signal?: AbortSignal;
};

export type SavedReferenceProviderRefresher = {
  /** Provider payload stays inside this Worker-owned boundary. */
  readonly refresh: (input: SavedReferenceProviderRefreshRequest) => Promise<unknown>;
};

export type SavedReferenceHandoffBinding = {
  readonly savedPlaceRef: SavedPlaceRef;
  readonly scope: RegistryScope;
  readonly turnId: string;
  readonly revision: number;
};

/** Narrow adapter used only by the saved-reference resolver's registry wrapper. */
export type SavedReferenceCandidateRegistry = {
  readonly listCandidates: (scope: RegistryScope) => readonly Readonly<CandidateRecord>[];
  readonly registerCandidate: (
    input: CandidateRegistration,
    binding?: SavedReferenceHandoffBinding,
  ) => Readonly<CandidateRecord>;
};
