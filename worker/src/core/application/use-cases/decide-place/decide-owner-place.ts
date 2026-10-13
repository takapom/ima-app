import type {
  OwnerReferenceInput,
  OwnerReferenceDependencies,
} from '@worker/core/application/ports/owner-candidate';

/**
 * 現在の候補を owner の決定として記録する。
 * 店の実体は渡さず、解決した provider と recordRef だけをストアの1回の decide に任せる。身元と決定時刻はそこでまとめて残る。
 */
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
