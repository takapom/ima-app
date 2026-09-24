import type {
  ModelContextSource,
  ProjectedModelContext,
} from '@worker/application/model-context/model-context';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import type { RuntimePresentedInputs } from '@worker/runtime/response/runtime-presented-inputs';

/**
 * Records the context the model receives in one step. Only what the projection passes on counts:
 * withheld, stale and policy-denied values are not shown, so they do not bound the text.
 */
export const recordPresentedContext = (
  presented: RuntimePresentedInputs,
  projected: ProjectedModelContext,
  source: Pick<ModelContextSource, 'evidence'>,
  historyRetention: readonly RetentionMetadata[],
): void => {
  const evidenceById = new Map(source.evidence.map((item) => [item.observationId, item]));
  for (const evidence of projected.evidence) {
    if (evidence.status !== 'known') continue;
    const item = evidenceById.get(evidence.observationId);
    if (item === undefined) presented.unresolved();
    else presented.retention(item.retention);
  }
  // A shown store name is provider data even when its identity evidence is no longer shown.
  for (const candidate of projected.cardSet?.candidates ?? []) {
    if (candidate.displayName === '[withheld]') continue;
    const identities = source.evidence.filter(
      (item) => item.candidateId === candidate.candidateId && item.field === 'identity',
    );
    if (identities.length === 0) presented.unresolved();
    for (const identity of identities) presented.retention(identity.retention);
  }
  // Quoted history keeps its display and storage limits; its freshness belonged to that turn.
  if (projected.history.length > 0) {
    for (const retention of historyRetention)
      presented.retention({ ...retention, freshUntil: null });
  }
  for (const entry of projected.conversationMemory?.entries ?? []) {
    if (entry.expiresAt !== null) presented.deadline(entry.expiresAt);
  }
};
