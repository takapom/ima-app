import * as v from 'valibot';
import type { ThreadTurnRequest } from '@ima/contracts';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { ModelContextSource } from '@worker/application/model-context/model-context';
import type { RegistryScope } from '@worker/domain/evidence/freshness';
import { CardSetRecordSchema } from '@worker/domain/candidates/continuity';

type CardSetSource = NonNullable<ModelContextSource['cardSet']>;
type LegacyStage = () => CardSetSource | null;

export class RuntimeProductionDisplayContextError extends Error {
  readonly code = 'REVISION_CONFLICT' as const;

  constructor(reason: string) {
    super(`RUNTIME_CONTEXT_CARD_SET_${reason}`);
    this.name = 'RuntimeProductionDisplayContextError';
  }
}

/** A bounded owner/thread exclusion history cannot be extended implicitly. */
export class RuntimeProductionContextLimitError extends Error {
  readonly code = 'INVALID_ARGUMENT' as const;

  constructor() {
    super('RUNTIME_CONTEXT_EXCLUSION_LIMIT');
    this.name = 'RuntimeProductionContextLimitError';
  }
}

export const hasDisplayContext = (request: ThreadTurnRequest): boolean =>
  request.cardSetId !== undefined ||
  request.promotedCandidateId !== undefined ||
  request.selectedCandidateId !== undefined ||
  request.candidateOrder !== undefined;

const sameScope = (left: RegistryScope, right: RegistryScope): boolean =>
  left.ownerScopeRef === right.ownerScopeRef && left.threadId === right.threadId;

const cardSetContextError = (reason: string): RuntimeProductionDisplayContextError =>
  new RuntimeProductionDisplayContextError(reason);

const unique = (items: readonly string[]): readonly string[] => [...new Set(items)];

const candidateSourceFor = (
  registry: CandidateObservationRegistryPort,
  scope: RegistryScope,
  record: CardSetSource['record'],
): CardSetSource['candidates'] | undefined => {
  const excluded = new Set(record.excludedCandidateIds);
  const candidates = record.entries.map((entry) =>
    registry.readCandidate(scope, entry.candidateId),
  );
  if (candidates.some((candidate) => candidate === undefined)) return undefined;
  return candidates.map((candidate) => {
    if (candidate === undefined) throw new Error('candidate disappeared while projecting context');
    if (candidate.ownerScopeRef !== scope.ownerScopeRef || candidate.threadId !== scope.threadId) {
      throw new Error('candidate scope changed while projecting context');
    }
    return {
      candidateId: candidate.candidateId,
      ownerScopeRef: candidate.ownerScopeRef,
      threadId: candidate.threadId,
      displayName: candidate.displayName,
      status: candidate.status,
      excluded: excluded.has(candidate.candidateId) || candidate.excluded,
    };
  });
};

export const cardSetFor = (
  registry: CandidateObservationRegistryPort,
  scope: RegistryScope,
  record: CardSetSource['record'],
): CardSetSource | null => {
  const candidates = candidateSourceFor(registry, scope, record);
  if (candidates === undefined) return null;
  const excluded = unique([
    ...record.excludedCandidateIds,
    ...candidates
      .filter((candidate) => candidate.excluded)
      .map((candidate) => candidate.candidateId),
  ]);
  const selectedCandidateId =
    record.selectedCandidateId !== null && excluded.includes(record.selectedCandidateId)
      ? null
      : record.selectedCandidateId;
  const parsed = v.safeParse(CardSetRecordSchema, {
    ...record,
    selectedCandidateId,
    excludedCandidateIds: excluded,
  });
  return parsed.success ? { record: parsed.output, candidates } : null;
};

export const stagedCardSetFor = (
  registry: CandidateObservationRegistryPort,
  scope: RegistryScope,
  previous: CardSetSource | null,
  excludedCandidateIds: readonly string[],
  referenceOnly = false,
): CardSetSource | null => {
  if (previous === null) return null;
  const entryIds = new Set(previous.record.entries.map((entry) => entry.candidateId));
  const excluded = unique([
    ...previous.record.excludedCandidateIds,
    ...excludedCandidateIds.filter((candidateId) => entryIds.has(candidateId)),
  ]);
  const selectedCandidateId =
    previous.record.selectedCandidateId !== null &&
    excluded.includes(previous.record.selectedCandidateId)
      ? null
      : previous.record.selectedCandidateId;
  const parsed = v.safeParse(CardSetRecordSchema, {
    ...previous.record,
    selectedCandidateId,
    excludedCandidateIds: excluded,
  });
  if (!parsed.success) return null;
  const resolved = cardSetFor(registry, scope, parsed.output);
  if (resolved !== null || !referenceOnly) return resolved;
  return {
    record: parsed.output,
    candidates: previous.candidates.map((candidate) => ({
      ...candidate,
      excluded: excluded.includes(candidate.candidateId) || candidate.excluded,
    })),
  };
};

/** Applies the explicit display snapshot, while the callback preserves old clients. */
export const cardSetForDisplayContext = (input: {
  readonly registry: CandidateObservationRegistryPort;
  readonly scope: RegistryScope;
  readonly previous: CardSetSource | null;
  readonly request: ThreadTurnRequest;
  readonly referenceOnly: boolean;
  readonly knownExcludedCandidateIds: readonly string[];
  readonly legacyStage: LegacyStage;
}): CardSetSource | null => {
  const { registry, scope, previous, request, referenceOnly } = input;
  if (!hasDisplayContext(request)) return input.legacyStage();

  if (request.cardSetId === null) {
    if (request.excludeCandidateIds.length > 0) {
      throw cardSetContextError('EXCLUSION_WITHOUT_CARD_SET');
    }
    if (request.promotedCandidateId !== undefined && request.promotedCandidateId !== null) {
      throw cardSetContextError('PROMOTION_WITHOUT_CARD_SET');
    }
    if (request.selectedCandidateId !== undefined && request.selectedCandidateId !== null) {
      throw cardSetContextError('SELECTION_WITHOUT_CARD_SET');
    }
    if (request.candidateOrder !== undefined && request.candidateOrder.length > 0) {
      throw cardSetContextError('ORDER_WITHOUT_CARD_SET');
    }
    return null;
  }

  if (request.cardSetId === undefined || previous === null) {
    throw cardSetContextError('MISSING_CURRENT_CARD_SET');
  }
  if (previous.record.cardSetId !== request.cardSetId) {
    throw cardSetContextError('STALE_CARD_SET');
  }
  if (!sameScope(previous.record.scope, scope)) {
    throw cardSetContextError('SCOPE_MISMATCH');
  }

  const entryIds = previous.record.entries.map((entry) => entry.candidateId);
  const entryIdSet = new Set(entryIds);
  const requestedExclusions = request.excludeCandidateIds;
  for (const candidateId of requestedExclusions) {
    if (entryIdSet.has(candidateId)) continue;
    const inherited = registry.readCandidate(scope, candidateId);
    if (inherited === undefined && !input.knownExcludedCandidateIds.includes(candidateId)) {
      throw cardSetContextError('EXCLUSION_OUTSIDE_CARD_SET');
    }
    if (inherited !== undefined && !inherited.excluded) {
      throw cardSetContextError('EXCLUSION_OUTSIDE_CARD_SET');
    }
  }
  const currentExclusions = requestedExclusions.filter((candidateId) =>
    entryIdSet.has(candidateId),
  );
  const registryExclusions = entryIds.filter(
    (candidateId) => registry.readCandidate(scope, candidateId)?.excluded === true,
  );
  const excluded = unique([
    ...previous.record.excludedCandidateIds,
    ...currentExclusions,
    ...registryExclusions,
  ]);
  const excludedSet = new Set(excluded);
  const visibleIds = entryIds.filter((candidateId) => !excludedSet.has(candidateId));
  const order =
    request.candidateOrder ??
    (() => {
      const visibleOrder = previous.record.entries
        .filter((entry) => !excludedSet.has(entry.candidateId))
        .map((entry) => entry.candidateId);
      if (
        request.promotedCandidateId === undefined ||
        request.promotedCandidateId === null ||
        !visibleOrder.includes(request.promotedCandidateId)
      ) {
        return visibleOrder;
      }
      return [
        request.promotedCandidateId,
        ...visibleOrder.filter((candidateId) => candidateId !== request.promotedCandidateId),
      ];
    })();
  if (new Set(order).size !== order.length || order.length !== visibleIds.length) {
    throw cardSetContextError('INVALID_ORDER');
  }
  if (order.some((candidateId) => !entryIdSet.has(candidateId) || excludedSet.has(candidateId))) {
    throw cardSetContextError('INVALID_ORDER');
  }
  if (visibleIds.some((candidateId) => !order.includes(candidateId))) {
    throw cardSetContextError('INCOMPLETE_ORDER');
  }
  if (request.promotedCandidateId !== undefined && request.promotedCandidateId !== null) {
    if (!entryIdSet.has(request.promotedCandidateId)) {
      throw cardSetContextError('PROMOTION_OUTSIDE_CARD_SET');
    }
    if (excludedSet.has(request.promotedCandidateId)) {
      throw cardSetContextError('PROMOTION_EXCLUDED');
    }
    if (order[0] !== request.promotedCandidateId) {
      throw cardSetContextError('PROMOTION_ORDER_MISMATCH');
    }
  }

  const orderedIds = [...order, ...entryIds.filter((candidateId) => excludedSet.has(candidateId))];
  const entries = orderedIds.map((candidateId, displayOrder) => {
    const previousEntry = previous.record.entries.find(
      (entry) => entry.candidateId === candidateId,
    );
    if (previousEntry === undefined) throw cardSetContextError('UNKNOWN_CANDIDATE');
    return {
      candidateId,
      displayOrder,
      role: displayOrder === 0 ? ('hero' as const) : ('alt' as const),
    };
  });
  const selectedCandidateId =
    request.selectedCandidateId === undefined
      ? previous.record.selectedCandidateId
      : request.selectedCandidateId;
  if (selectedCandidateId !== null) {
    if (!entryIdSet.has(selectedCandidateId)) {
      throw cardSetContextError('SELECTION_OUTSIDE_CARD_SET');
    }
    if (excludedSet.has(selectedCandidateId)) {
      throw cardSetContextError('SELECTION_EXCLUDED');
    }
  }
  const parsed = v.safeParse(CardSetRecordSchema, {
    ...previous.record,
    entries,
    selectedCandidateId,
    excludedCandidateIds: excluded,
  });
  if (!parsed.success) throw cardSetContextError('INVALID_RECORD');
  const resolved = cardSetFor(registry, scope, parsed.output);
  if (resolved !== null) return resolved;
  if (!referenceOnly) throw cardSetContextError('CANDIDATE_SCOPE_MISMATCH');
  return {
    record: parsed.output,
    candidates: previous.candidates.map((candidate) => ({
      ...candidate,
      excluded: excludedSet.has(candidate.candidateId) || candidate.excluded,
    })),
  };
};
