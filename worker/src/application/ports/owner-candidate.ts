import type { OwnerStore } from '@worker/application/ports/owner-store';

export type OwnerSavedCandidateResult =
  | {
      readonly ok: true;
      readonly candidateId: string;
      readonly provider: string;
      readonly recordRef: string;
    }
  | {
      readonly ok: false;
      readonly code:
        'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'STALE_TURN' | 'UNKNOWN_CANDIDATE';
    };

export type OwnerCandidateInput = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly candidateId: string;
  readonly revision: number;
};

export type OwnerSavedCandidateResolver = (
  input: OwnerCandidateInput,
) => Promise<OwnerSavedCandidateResult>;

export type OwnerReferenceFingerprint = (
  operation: 'save' | 'decide',
  input: OwnerCandidateInput,
) => Promise<string>;

export type OwnerReferenceDependencies = {
  readonly store: OwnerStore;
  readonly resolveSavedCandidate: OwnerSavedCandidateResolver;
  readonly fingerprint: OwnerReferenceFingerprint;
};

export type OwnerReferenceInput = OwnerCandidateInput & { readonly idempotencyKey: string };
