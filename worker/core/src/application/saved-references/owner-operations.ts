import type { OwnerStore } from '@core/ports/owner-store';

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

/** Replay precedes candidate resolution so retries do not require the original live candidate. */
export const registerOwnerSavedReference = async (
  input: OwnerReferenceInput,
  dependencies: OwnerReferenceDependencies,
) => {
  const fingerprint = await dependencies.fingerprint('save', input);
  const replay = await dependencies.store.replay(
    input.ownerScopeRef,
    input.idempotencyKey,
    fingerprint,
  );
  if (!replay.ok) return { ...replay, source: 'store' as const };
  if (replay.found) return { ok: true as const, reference: replay.reference };
  const candidate = await dependencies.resolveSavedCandidate({
    ownerScopeRef: input.ownerScopeRef,
    threadId: input.threadId,
    candidateId: input.candidateId,
    revision: input.revision,
  });
  if (!candidate.ok) return { ...candidate, source: 'candidate' as const };
  const saved = await dependencies.store.register(
    input.ownerScopeRef,
    { provider: candidate.provider, recordRef: candidate.recordRef },
    { idempotencyKey: input.idempotencyKey, idempotencyFingerprint: fingerprint },
  );
  if (!saved.ok) return { ...saved, source: 'store' as const };
  return { ok: true as const, reference: saved.reference };
};

/** A decision resolves the current candidate; the store atomically records identity and decision. */
export const decideOwnerPlace = async (
  input: OwnerReferenceInput & { readonly decidedAt: string },
  dependencies: OwnerReferenceDependencies,
) => {
  const fingerprint = await dependencies.fingerprint('decide', input);
  const candidate = await dependencies.resolveSavedCandidate({
    ownerScopeRef: input.ownerScopeRef,
    threadId: input.threadId,
    candidateId: input.candidateId,
    revision: input.revision,
  });
  if (!candidate.ok) return { ...candidate, source: 'candidate' as const };
  const decided = await dependencies.store.decide(
    input.ownerScopeRef,
    { provider: candidate.provider, recordRef: candidate.recordRef, decidedAt: input.decidedAt },
    { idempotencyKey: input.idempotencyKey, idempotencyFingerprint: fingerprint },
  );
  if (!decided.ok) return { ...decided, source: 'store' as const };
  return decided;
};
