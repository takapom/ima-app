import {
  parseSavedReferencePath,
  type PublicPlaceDetailsData,
  type RetentionMetadata,
} from '@ima/contracts';
import { canPersistOwnerScopedReference } from '@mobile/services/sqlite/retention';
import type { SqliteStore } from '@mobile/services/sqlite/types';
import type { ApiError, ApiRequestOptions, JourneyApiClient } from '@mobile/services/api/api';
import { parseSavedReferenceRefreshResponse } from '@mobile/services/api/saved-reference-refresh';
import type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
} from '@mobile/services/saved-places/saved-place-types';

export type SavedReferenceScope = {
  readonly threadId: string;
  readonly revision: number;
};

export type SavedReferenceSaveInput = {
  readonly scope: SavedReferenceScope;
  readonly candidateId: string;
  readonly idempotencyKey: string;
  readonly referenceRetention: RetentionMetadata;
  readonly signal?: AbortSignal;
};

export type SavedReferenceDeleteInput = {
  readonly savedPlaceRef: ServerSavedPlaceRef;
  readonly idempotencyKey: string;
  /** Omit only for saved-list deletion that is independent of the active turn. */
  readonly scope?: SavedReferenceScope;
  readonly localSavedEntryId?: LocalSavedEntryId;
  readonly signal?: AbortSignal;
};

export type SavedReferenceRefreshInput = {
  /** A threadless refresh is independent of the active conversation scope. */
  readonly savedPlaceRef: ServerSavedPlaceRef;
  readonly signal?: AbortSignal;
};

type SavedReferenceFailureReason =
  'aborted' | 'api' | 'invalid_input' | 'retention_denied' | 'stale' | 'storage_unavailable';

type SavedReferenceFailure = {
  readonly status: 'failed';
  readonly reason: SavedReferenceFailureReason;
  readonly error?: ApiError;
};

export type SavedReferenceSaveResult =
  | {
      readonly status: 'saved' | 'already_saved';
      readonly localSavedEntryId: LocalSavedEntryId;
      readonly serverSavedPlaceRef: ServerSavedPlaceRef;
    }
  | SavedReferenceFailure;

export type SavedReferenceDeleteResult =
  { readonly status: 'deleted' | 'already_deleted' } | SavedReferenceFailure;

export type SavedReferenceRefreshResult =
  | {
      readonly status: 'refreshed';
      readonly savedPlaceRef: ServerSavedPlaceRef;
      readonly candidateId: string;
      readonly evidenceIds: readonly string[];
      readonly data: PublicPlaceDetailsData;
    }
  | SavedReferenceFailure;

export type SavedReferenceServiceOptions = {
  readonly api: Pick<
    JourneyApiClient,
    'createSavedReference' | 'decidePlace' | 'deleteSavedReference' | 'refreshSavedReference'
  >;
  readonly sqlite: Pick<
    SqliteStore,
    'savePlace' | 'listSavedPlaces' | 'deleteSavedPlace' | 'markDecided'
  >;
  readonly requestIdFactory: () => string;
  /**
   * The host changes this scope when a new thread or revision becomes active and returns null
   * after the session expires. The service does not derive expiry from a local clock.
   */
  readonly currentScope: () => SavedReferenceScope | null;
};

export type SavedReferenceDecideResult =
  | {
      readonly status: 'decided';
      readonly localSavedEntryId: LocalSavedEntryId;
      readonly serverSavedPlaceRef: ServerSavedPlaceRef;
      readonly decidedAt: string;
    }
  | SavedReferenceFailure;

export type SavedReferenceService = {
  readonly save: (input: SavedReferenceSaveInput) => Promise<SavedReferenceSaveResult>;
  readonly decide: (input: SavedReferenceSaveInput) => Promise<SavedReferenceDecideResult>;
  readonly remove: (input: SavedReferenceDeleteInput) => Promise<SavedReferenceDeleteResult>;
  readonly refresh: (input: SavedReferenceRefreshInput) => Promise<SavedReferenceRefreshResult>;
};

const failure = (reason: SavedReferenceFailureReason, error?: ApiError): SavedReferenceFailure =>
  error === undefined ? { status: 'failed', reason } : { status: 'failed', reason, error };

const requestIdFor = (factory: () => string): string | null => {
  try {
    const requestId = factory();
    return typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
  } catch {
    return null;
  }
};

const isServerSavedPlaceRef = (value: string): value is ServerSavedPlaceRef =>
  parseSavedReferencePath({ savedPlaceRef: value }).success;

const isMatchingScope = (
  expected: SavedReferenceScope,
  currentScope: SavedReferenceServiceOptions['currentScope'],
): boolean => {
  try {
    const current = currentScope();
    return (
      current !== null &&
      current.threadId === expected.threadId &&
      current.revision === expected.revision
    );
  } catch {
    return false;
  }
};

const preflight = (
  signal: AbortSignal | undefined,
  scope: SavedReferenceScope | undefined,
  currentScope: SavedReferenceServiceOptions['currentScope'],
): SavedReferenceFailure | null => {
  if (signal?.aborted) return failure('aborted');
  if (scope !== undefined && !isMatchingScope(scope, currentScope)) return failure('stale');
  return null;
};

const mapApiFailure = (error: ApiError): SavedReferenceFailure => {
  if (error.kind === 'aborted') return failure('aborted', error);
  if (error.kind === 'timeout') return failure('api', error);
  if (error.kind === 'contract') return failure('invalid_input', error);
  if (
    error.kind === 'http' &&
    (error.publicError.code === 'STALE_TURN' || error.publicError.code === 'CONFLICT')
  ) {
    return failure('stale', error);
  }
  if (error.kind === 'http' && error.publicError.code === 'CANCELLED') {
    return failure('aborted', error);
  }
  return failure('api', error);
};

const apiOptions = (signal: AbortSignal | undefined): ApiRequestOptions =>
  signal === undefined ? {} : { signal };

export const createSavedReferenceService = (
  options: SavedReferenceServiceOptions,
): SavedReferenceService => {
  const save = async (input: SavedReferenceSaveInput): Promise<SavedReferenceSaveResult> => {
    if (!canPersistOwnerScopedReference(input.referenceRetention)) {
      return failure('retention_denied');
    }
    const before = preflight(input.signal, input.scope, options.currentScope);
    if (before !== null) return before;
    const requestId = requestIdFor(options.requestIdFactory);
    if (requestId === null) return failure('invalid_input');

    let result: Awaited<ReturnType<SavedReferenceServiceOptions['api']['createSavedReference']>>;
    try {
      result = await options.api.createSavedReference(
        input.scope.threadId,
        {
          schemaVersion: 'v1',
          requestId,
          candidateId: input.candidateId,
          revision: input.scope.revision,
          idempotencyKey: input.idempotencyKey,
        },
        apiOptions(input.signal),
      );
    } catch {
      return failure('api');
    }
    if (!result.ok) return mapApiFailure(result.error);
    if (
      result.data.candidateId !== input.candidateId ||
      !isServerSavedPlaceRef(result.data.savedPlaceRef)
    ) {
      return failure('invalid_input');
    }
    const after = preflight(input.signal, input.scope, options.currentScope);
    if (after !== null) return after;

    let stored: ReturnType<SavedReferenceServiceOptions['sqlite']['savePlace']>;
    try {
      stored = options.sqlite.savePlace({
        serverSavedPlaceRef: result.data.savedPlaceRef,
        referenceRetention: input.referenceRetention,
        display: null,
      });
    } catch {
      return failure('storage_unavailable');
    }
    if (stored.status === 'rejected') {
      return failure(stored.reason === 'retention_denied' ? 'retention_denied' : 'invalid_input');
    }
    if (stored.place.serverSavedPlaceRef !== result.data.savedPlaceRef) {
      return failure('invalid_input');
    }
    return {
      status: stored.status,
      localSavedEntryId: stored.place.localSavedEntryId,
      serverSavedPlaceRef: result.data.savedPlaceRef,
    };
  };

  const decide = async (input: SavedReferenceSaveInput): Promise<SavedReferenceDecideResult> => {
    if (!canPersistOwnerScopedReference(input.referenceRetention)) {
      return failure('retention_denied');
    }
    const before = preflight(input.signal, input.scope, options.currentScope);
    if (before !== null) return before;
    const requestId = requestIdFor(options.requestIdFactory);
    if (requestId === null) return failure('invalid_input');

    let result: Awaited<ReturnType<SavedReferenceServiceOptions['api']['decidePlace']>>;
    try {
      result = await options.api.decidePlace(
        input.scope.threadId,
        {
          schemaVersion: 'v1',
          requestId,
          candidateId: input.candidateId,
          revision: input.scope.revision,
          idempotencyKey: input.idempotencyKey,
        },
        apiOptions(input.signal),
      );
    } catch {
      return failure('api');
    }
    if (!result.ok) return mapApiFailure(result.error);
    if (
      result.data.candidateId !== input.candidateId ||
      !isServerSavedPlaceRef(result.data.savedPlaceRef)
    ) {
      return failure('invalid_input');
    }
    const after = preflight(input.signal, input.scope, options.currentScope);
    if (after !== null) return after;

    let stored: ReturnType<SavedReferenceServiceOptions['sqlite']['savePlace']>;
    try {
      stored = options.sqlite.savePlace({
        serverSavedPlaceRef: result.data.savedPlaceRef,
        referenceRetention: input.referenceRetention,
        display: null,
      });
    } catch {
      return failure('storage_unavailable');
    }
    if (stored.status === 'rejected') {
      return failure(stored.reason === 'retention_denied' ? 'retention_denied' : 'invalid_input');
    }
    if (stored.place.serverSavedPlaceRef !== result.data.savedPlaceRef) {
      return failure('invalid_input');
    }
    try {
      if (!options.sqlite.markDecided(stored.place.localSavedEntryId, result.data.decidedAt)) {
        return failure('storage_unavailable');
      }
    } catch {
      return failure('storage_unavailable');
    }
    return {
      status: 'decided',
      localSavedEntryId: stored.place.localSavedEntryId,
      serverSavedPlaceRef: result.data.savedPlaceRef,
      decidedAt: result.data.decidedAt,
    };
  };

  const remove = async (input: SavedReferenceDeleteInput): Promise<SavedReferenceDeleteResult> => {
    if (!isServerSavedPlaceRef(input.savedPlaceRef)) return failure('invalid_input');
    const before = preflight(input.signal, input.scope, options.currentScope);
    if (before !== null) return before;

    if (input.localSavedEntryId !== undefined) {
      try {
        const localPlace = options.sqlite
          .listSavedPlaces()
          .find((place) => place.localSavedEntryId === input.localSavedEntryId);
        if (localPlace !== undefined && localPlace.serverSavedPlaceRef !== input.savedPlaceRef) {
          return failure('invalid_input');
        }
      } catch {
        return failure('storage_unavailable');
      }
    }

    const requestId = requestIdFor(options.requestIdFactory);
    if (requestId === null) return failure('invalid_input');

    let result: Awaited<ReturnType<SavedReferenceServiceOptions['api']['deleteSavedReference']>>;
    try {
      result = await options.api.deleteSavedReference(
        input.savedPlaceRef,
        { schemaVersion: 'v1', requestId, idempotencyKey: input.idempotencyKey },
        apiOptions(input.signal),
      );
    } catch {
      return failure('api');
    }
    if (!result.ok) return mapApiFailure(result.error);
    const after = preflight(input.signal, input.scope, options.currentScope);
    if (after !== null) return after;

    let localSavedEntryId = input.localSavedEntryId;
    try {
      const localPlaces = options.sqlite.listSavedPlaces();
      const providedPlace =
        localSavedEntryId === undefined
          ? undefined
          : localPlaces.find((place) => place.localSavedEntryId === localSavedEntryId);
      if (localSavedEntryId !== undefined && providedPlace === undefined) {
        return { status: 'already_deleted' };
      }
      if (
        providedPlace !== undefined &&
        providedPlace.serverSavedPlaceRef !== input.savedPlaceRef
      ) {
        return failure('invalid_input');
      }
      if (localSavedEntryId === undefined) {
        localSavedEntryId = localPlaces.find(
          (place) => place.serverSavedPlaceRef === input.savedPlaceRef,
        )?.localSavedEntryId;
      }
      if (localSavedEntryId === undefined) return { status: 'already_deleted' };
      return options.sqlite.deleteSavedPlace(localSavedEntryId)
        ? { status: 'deleted' }
        : { status: 'already_deleted' };
    } catch {
      return failure('storage_unavailable');
    }
  };

  const refresh = async (
    input: SavedReferenceRefreshInput,
  ): Promise<SavedReferenceRefreshResult> => {
    if (!isServerSavedPlaceRef(input.savedPlaceRef)) return failure('invalid_input');
    const before = preflight(input.signal, undefined, options.currentScope);
    if (before !== null) return before;

    let result: Awaited<ReturnType<SavedReferenceServiceOptions['api']['refreshSavedReference']>>;
    try {
      result = await options.api.refreshSavedReference(
        input.savedPlaceRef,
        apiOptions(input.signal),
      );
    } catch {
      return input.signal?.aborted ? failure('aborted') : failure('api');
    }
    if (!result.ok) return mapApiFailure(result.error);
    const after = preflight(input.signal, undefined, options.currentScope);
    if (after !== null) return after;
    const parsedRefresh = parseSavedReferenceRefreshResponse(result.data, input.savedPlaceRef);
    if (!parsedRefresh.success) {
      return failure('invalid_input');
    }
    const response = parsedRefresh.data;

    return {
      status: 'refreshed',
      savedPlaceRef: input.savedPlaceRef,
      candidateId: response.candidate.candidateId,
      evidenceIds: response.candidate.evidenceIds,
      data: response.data,
    };
  };

  return { save, decide, remove, refresh };
};
