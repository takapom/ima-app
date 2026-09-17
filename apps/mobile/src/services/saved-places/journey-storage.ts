import type { PublicCard, RetentionMetadata } from '@ima/contracts';
import type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
} from '@mobile/services/saved-places/saved-place-types';
import type {
  SavedReferenceDecideResult,
  SavedReferenceScope,
  SavedReferenceSaveResult,
  SavedReferenceService,
} from '@mobile/services/saved-places/saved-reference-service';

export type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
} from '@mobile/services/saved-places/saved-place-types';

/**
 * Keep public metadata at the storage boundary so the SQLite adapter can
 * inspect evidence/retention before deciding what may be persisted. The action
 * state still stores only candidate IDs and never copies this card.
 */
export type JourneySaveCandidate = PublicCard;

export type JourneyStorageSaveOptions = {
  /** Stable for one logical save retry; the API uses it for idempotency. */
  readonly idempotencyKey?: string;
  /** Cancel only the in-flight request; a completed server save is not undone. */
  readonly signal?: AbortSignal;
};

export type JourneyStorageFailureReason =
  'aborted' | 'api' | 'invalid_input' | 'retention_denied' | 'stale' | 'storage_unavailable';

export type SaveCandidateResult =
  | {
      readonly status: 'saved';
      readonly localSavedEntryId: LocalSavedEntryId;
      readonly serverSavedPlaceRef: ServerSavedPlaceRef | null;
    }
  | {
      readonly status: 'already_saved';
      readonly localSavedEntryId: LocalSavedEntryId;
      readonly serverSavedPlaceRef: ServerSavedPlaceRef | null;
    }
  | {
      readonly status: 'failed';
      readonly reason: JourneyStorageFailureReason;
    };

export type DecideCandidateResult =
  | {
      readonly status: 'decided';
      readonly localSavedEntryId: LocalSavedEntryId;
      readonly serverSavedPlaceRef: ServerSavedPlaceRef | null;
      readonly decidedAt: string;
    }
  | {
      readonly status: 'failed';
      readonly reason: JourneyStorageFailureReason;
    };

export type JourneyStorageService = {
  readonly saveCandidate: (
    candidate: JourneySaveCandidate,
    options?: JourneyStorageSaveOptions,
  ) => Promise<SaveCandidateResult>;
  readonly decideCandidate: (
    candidate: JourneySaveCandidate,
    options?: JourneyStorageSaveOptions,
  ) => Promise<DecideCandidateResult>;
};

/** No storage injection means the UI cannot claim that a candidate was saved. */
export const createUnavailableJourneyStorageService = (): JourneyStorageService => ({
  saveCandidate: () => Promise.resolve({ status: 'failed', reason: 'storage_unavailable' }),
  decideCandidate: () => Promise.resolve({ status: 'failed', reason: 'storage_unavailable' }),
});

export type SavedReferenceJourneyStorageOptions = {
  readonly service: SavedReferenceService;
  /** The host owns the active thread/revision and returns null after expiry. */
  readonly currentScope: () => SavedReferenceScope | null;
  /** Dedicated owner-scoped reference policy; never derive this from card evidence. */
  readonly referenceRetentionFor: (candidate: JourneySaveCandidate) => RetentionMetadata | null;
  /** Host projection of currently visible cards; omitted hosts skip this gate. */
  readonly isCandidateVisible?: (candidate: JourneySaveCandidate) => boolean;
};

const failed = (reason: JourneyStorageFailureReason): SaveCandidateResult => ({
  status: 'failed',
  reason,
});

const mapSavedReferenceResult = (result: SavedReferenceSaveResult): SaveCandidateResult => {
  if (result.status === 'failed') {
    return failed(result.reason);
  }
  return {
    status: result.status,
    localSavedEntryId: result.localSavedEntryId,
    serverSavedPlaceRef: result.serverSavedPlaceRef,
  };
};

/**
 * Adapt the owner-scoped API/SQLite service to the card action boundary. The
 * reference policy and active scope are injected by the host, so a public
 * card's provider/display evidence can never silently authorize persistence.
 */
export const createSavedReferenceJourneyStorage = (
  options: SavedReferenceJourneyStorageOptions,
): JourneyStorageService => ({
  saveCandidate: async (candidate, saveOptions = {}) => {
    if (options.isCandidateVisible !== undefined) {
      let visible: boolean;
      try {
        visible = options.isCandidateVisible(candidate);
      } catch {
        return failed('stale');
      }
      if (!visible) return failed('stale');
    }

    const idempotencyKey = saveOptions.idempotencyKey;
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      return failed('invalid_input');
    }

    let referenceRetention: RetentionMetadata | null;
    try {
      referenceRetention = options.referenceRetentionFor(candidate);
    } catch {
      return failed('retention_denied');
    }
    if (referenceRetention === null) return failed('retention_denied');

    let scope: SavedReferenceScope | null;
    try {
      scope = options.currentScope();
    } catch {
      return failed('stale');
    }
    if (scope === null) return failed('stale');

    try {
      const result = await options.service.save({
        scope,
        candidateId: candidate.candidateId,
        idempotencyKey,
        referenceRetention,
        ...(saveOptions.signal === undefined ? {} : { signal: saveOptions.signal }),
      });
      return mapSavedReferenceResult(result);
    } catch {
      return failed('storage_unavailable');
    }
  },
  decideCandidate: async (candidate, saveOptions = {}) => {
    const fail = (reason: JourneyStorageFailureReason): DecideCandidateResult => ({
      status: 'failed',
      reason,
    });
    if (options.isCandidateVisible !== undefined) {
      let visible: boolean;
      try {
        visible = options.isCandidateVisible(candidate);
      } catch {
        return fail('stale');
      }
      if (!visible) return fail('stale');
    }
    const idempotencyKey = saveOptions.idempotencyKey;
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      return fail('invalid_input');
    }
    let referenceRetention: RetentionMetadata | null;
    try {
      referenceRetention = options.referenceRetentionFor(candidate);
    } catch {
      return fail('retention_denied');
    }
    if (referenceRetention === null) return fail('retention_denied');
    let scope: SavedReferenceScope | null;
    try {
      scope = options.currentScope();
    } catch {
      return fail('stale');
    }
    if (scope === null) return fail('stale');
    try {
      const result = await options.service.decide({
        scope,
        candidateId: candidate.candidateId,
        idempotencyKey,
        referenceRetention,
        ...(saveOptions.signal === undefined ? {} : { signal: saveOptions.signal }),
      });
      return mapDecideResult(result);
    } catch {
      return fail('storage_unavailable');
    }
  },
});

const mapDecideResult = (result: SavedReferenceDecideResult): DecideCandidateResult => {
  if (result.status === 'failed') return { status: 'failed', reason: result.reason };
  return {
    status: 'decided',
    localSavedEntryId: result.localSavedEntryId,
    serverSavedPlaceRef: result.serverSavedPlaceRef,
    decidedAt: result.decidedAt,
  };
};

/** Keep storage failures at the service boundary; only a formal host adapter may report success. */
export const saveJourneyCandidate = async (
  service: JourneyStorageService,
  candidate: JourneySaveCandidate,
  saveOptions?: JourneyStorageSaveOptions,
): Promise<SaveCandidateResult> => {
  try {
    return saveOptions === undefined
      ? await service.saveCandidate(candidate)
      : await service.saveCandidate(candidate, saveOptions);
  } catch {
    return failed('storage_unavailable');
  }
};
