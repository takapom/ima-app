import type {
  OwnerReferenceInput,
  OwnerReferenceDependencies,
} from '@worker/application/ports/owner-candidate';

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
