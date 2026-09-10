import type {
  CandidateId,
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
import type { GooglePlaceDetailsField, GooglePlaceDetailsResponse } from './types';

export type SavedReferenceHandoffStage = {
  readonly savedPlaceRef: SavedPlaceRef;
  readonly scope: RegistryScope;
  readonly turnId: string;
  readonly revision: number;
  readonly provider: string;
  /** Google fields requested by Core; an empty list still covers the identity fetch. */
  readonly fields: readonly GooglePlaceDetailsField[];
  /** This response is held only in the current Worker turn, never persisted or model projected. */
  readonly response: GooglePlaceDetailsResponse;
  /** Server clock captured after the provider response was received. */
  readonly observedAt: string;
  readonly expiresAt: string;
};

export type SavedReferenceHandoffTakeInput = {
  readonly candidateId: CandidateId;
  readonly scope: RegistryScope;
  readonly turnId: string;
  readonly revision: number;
  readonly fields: readonly GooglePlaceDetailsField[];
  readonly now: string;
};

export type SavedReferenceHandoffTakeResult =
  | {
      readonly status: 'ready';
      readonly response: GooglePlaceDetailsResponse;
      readonly observedAt: string;
    }
  | { readonly status: 'expired' | 'invalid' };

export type SavedReferenceHandoffCoverage = 'covered' | 'expired';

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

export type SavedReferenceDetailsHandoff = {
  readonly stage: (input: SavedReferenceHandoffStage) => void;
  /** Checks the complete binding before the registry can create a candidate. */
  readonly canBindCandidate: (input: {
    readonly binding: SavedReferenceHandoffBinding;
    readonly candidate: Pick<
      CandidateRegistration,
      'ownerScopeRef' | 'threadId' | 'provider' | 'recordRef'
    >;
  }) => boolean;
  readonly bindCandidate: (input: {
    readonly binding: SavedReferenceHandoffBinding;
    readonly candidate: Pick<
      CandidateRecord,
      'candidateId' | 'ownerScopeRef' | 'threadId' | 'provider' | 'recordRef'
    >;
  }) => boolean;
  readonly takeForCandidate: (
    input: SavedReferenceHandoffTakeInput,
  ) => SavedReferenceHandoffTakeResult | undefined;
  /** Used by cost admission to count a provider fetch exactly once. */
  readonly coverageForCandidate: (input: {
    readonly candidateId: CandidateId;
    readonly scope: RegistryScope;
    readonly turnId: string;
    readonly revision: number;
    readonly fields: readonly GooglePlaceDetailsField[];
  }) => SavedReferenceHandoffCoverage | undefined;
  readonly discardForReference: (input: {
    readonly savedPlaceRef: SavedPlaceRef;
    readonly scope: RegistryScope;
    readonly turnId: string;
    readonly revision: number;
  }) => void;
  readonly discardForCandidate: (input: {
    readonly candidateId: CandidateId;
    readonly scope: RegistryScope;
    readonly turnId: string;
    readonly revision: number;
  }) => void;
  readonly clear: () => void;
};

/** Narrow adapter used only by the saved-reference resolver's registry wrapper. */
export type SavedReferenceCandidateRegistry = {
  readonly listCandidates: (scope: RegistryScope) => readonly Readonly<CandidateRecord>[];
  readonly registerCandidate: (
    input: CandidateRegistration,
    binding?: SavedReferenceHandoffBinding,
  ) => Readonly<CandidateRecord>;
};

/** Returns the Google-owned subset while preserving the model's field order. */
export const googleFieldsFor = (
  fields: readonly DetailField[],
): readonly GooglePlaceDetailsField[] =>
  fields.filter(
    (field): field is GooglePlaceDetailsField =>
      field === 'identity' ||
      field === 'opening_hours' ||
      field === 'price' ||
      field === 'photos' ||
      field === 'contact',
  );
