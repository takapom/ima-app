import type {
  OwnerReferenceInput,
  OwnerReferenceDependencies,
} from '@worker/application/ports/owner-candidate';

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
