import type {
  OwnerReferenceInput,
  OwnerReferenceDependencies,
} from '@worker/core/application/ports/owner-candidate';

/**
 * owner の保存参照を登録する。
 * 再送は候補の解決より先に照合する。元の候補がもうライブでなくても、同じ指紋の保存を返せるようにするため。
 * ストアへ残すのは provider と recordRef だけで、店名・住所・写真は埋め込まない。
 */
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
