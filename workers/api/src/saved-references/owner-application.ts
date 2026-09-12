import type { ApplicationOperation, ApplicationResult, HandlerContext } from '../http/handler';
import { HttpBoundaryError } from '../http/errors';
import type {
  OwnerDecideResult,
  OwnerRegisterResult,
  OwnerStore,
  SavedReferenceDeleteResult,
  SavedReferenceReplayResult,
} from './owner-store';

export type OwnerApplicationOperation = Extract<
  ApplicationOperation,
  {
    readonly kind:
      | 'prefs_read'
      | 'prefs_write'
      | 'saved_reference_list'
      | 'saved_reference_create'
      | 'saved_reference_delete'
      | 'place_decide';
  }
>;

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

export type OwnerSavedCandidateResolver = (input: {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly candidateId: string;
  readonly revision: number;
}) => Promise<OwnerSavedCandidateResult>;

export type OwnerApplicationDependencies = {
  readonly ownerStore: OwnerStore | undefined;
  readonly resolveSavedCandidate: OwnerSavedCandidateResolver;
};

const unavailable = (): HttpBoundaryError =>
  new HttpBoundaryError({ status: 502, code: 'PROVIDER_UNAVAILABLE' });

const ownerStoreFailure = (
  code:
    | Extract<OwnerRegisterResult, { readonly ok: false }>['code']
    | Extract<SavedReferenceReplayResult, { readonly ok: false }>['code']
    | Extract<SavedReferenceDeleteResult, { readonly ok: false }>['code']
    | Extract<OwnerDecideResult, { readonly ok: false }>['code']
    | 'REVISION_CONFLICT',
): HttpBoundaryError =>
  new HttpBoundaryError(
    code === 'INVALID_INPUT'
      ? { status: 400, code: 'INVALID_ARGUMENT' }
      : code === 'FORBIDDEN'
        ? { status: 403, code: 'FORBIDDEN' }
        : code === 'CORRUPT_ROW' || code === 'OWNER_NOT_INITIALIZED'
          ? { status: 500, code: 'INTERNAL' }
          : { status: 409, code: 'CONFLICT' },
  );

const savedCandidateFailure = (
  code: Extract<OwnerSavedCandidateResult, { readonly ok: false }>['code'],
): HttpBoundaryError =>
  new HttpBoundaryError(
    code === 'INVALID_INPUT'
      ? { status: 400, code: 'INVALID_ARGUMENT' }
      : code === 'FORBIDDEN'
        ? { status: 403, code: 'FORBIDDEN' }
        : code === 'NOT_FOUND'
          ? { status: 404, code: 'NOT_FOUND' }
          : code === 'UNKNOWN_CANDIDATE'
            ? { status: 404, code: 'UNKNOWN_CANDIDATE' }
            : { status: 409, code: 'STALE_TURN' },
  );

const savedReferenceFingerprint = async (
  threadId: string,
  candidateId: string,
  revision: number,
): Promise<string> => {
  const encoded = new TextEncoder().encode(
    `saved-reference\u0000${threadId}\u0000${candidateId}\u0000${revision}`,
  );
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const requireOwnerStore = (ownerStore: OwnerStore | undefined): OwnerStore => {
  if (ownerStore === undefined) throw unavailable();
  return ownerStore;
};

export const isOwnerApplicationOperation = (
  operation: ApplicationOperation,
): operation is OwnerApplicationOperation =>
  operation.kind === 'prefs_read' ||
  operation.kind === 'prefs_write' ||
  operation.kind === 'saved_reference_list' ||
  operation.kind === 'saved_reference_create' ||
  operation.kind === 'saved_reference_delete' ||
  operation.kind === 'place_decide';

/** Prefs and saved identity use OwnerStore only; candidate resolution stays a Thread port. */
export const handleOwnerApplication = async (
  operation: OwnerApplicationOperation,
  context: HandlerContext,
  dependencies: OwnerApplicationDependencies,
): Promise<ApplicationResult> => {
  const store = requireOwnerStore(dependencies.ownerStore);
  switch (operation.kind) {
    case 'prefs_read': {
      const result = await store.readPrefs(context.ownerScopeRef);
      if (!result.ok) throw ownerStoreFailure(result.code);
      return {
        kind: 'prefs_read',
        response: {
          schemaVersion: 'v1',
          requestId: context.requestId,
          revision: result.revision,
          prefs: result.prefs,
        },
      };
    }
    case 'prefs_write': {
      const result = await store.putPrefs(context.ownerScopeRef, {
        prefs: operation.input.prefs,
        expectedRevision: operation.input.expectedRevision,
      });
      if (!result.ok) throw ownerStoreFailure(result.code);
      return {
        kind: 'prefs_write',
        response: {
          schemaVersion: 'v1',
          requestId: operation.input.requestId,
          revision: result.revision,
        },
      };
    }
    case 'saved_reference_list': {
      const result = await store.listSaved(context.ownerScopeRef);
      if (!result.ok) throw ownerStoreFailure(result.code);
      return {
        kind: 'saved_reference_list',
        response: {
          schemaVersion: 'v1',
          requestId: context.requestId,
          savedPlaceRefs: result.references.map((reference) => reference.savedPlaceRef),
          decided: [...result.decided],
        },
      };
    }
    case 'saved_reference_create': {
      const fingerprint = await savedReferenceFingerprint(
        operation.path.threadId,
        operation.input.candidateId,
        operation.input.revision,
      );
      const replay = await store.replay(
        context.ownerScopeRef,
        operation.input.idempotencyKey,
        fingerprint,
      );
      if (!replay.ok) throw ownerStoreFailure(replay.code);
      if (replay.found) {
        return {
          kind: 'saved_reference_create',
          response: {
            schemaVersion: 'v1',
            requestId: operation.input.requestId,
            candidateId: operation.input.candidateId,
            savedPlaceRef: replay.reference.savedPlaceRef,
          },
        };
      }
      const candidate = await dependencies.resolveSavedCandidate({
        ownerScopeRef: context.ownerScopeRef,
        threadId: operation.path.threadId,
        candidateId: operation.input.candidateId,
        revision: operation.input.revision,
      });
      if (!candidate.ok) throw savedCandidateFailure(candidate.code);
      const saved = await store.register(
        context.ownerScopeRef,
        { provider: candidate.provider, recordRef: candidate.recordRef },
        {
          idempotencyKey: operation.input.idempotencyKey,
          idempotencyFingerprint: fingerprint,
        },
      );
      if (!saved.ok) throw ownerStoreFailure(saved.code);
      return {
        kind: 'saved_reference_create',
        response: {
          schemaVersion: 'v1',
          requestId: operation.input.requestId,
          candidateId: operation.input.candidateId,
          savedPlaceRef: saved.reference.savedPlaceRef,
        },
      };
    }
    case 'saved_reference_delete': {
      const removed = await store.remove(context.ownerScopeRef, operation.path.savedPlaceRef, {
        idempotencyKey: operation.input.idempotencyKey,
      });
      if (!removed.ok) throw ownerStoreFailure(removed.code);
      return { kind: 'saved_reference_delete', response: null };
    }
    case 'place_decide': {
      const fingerprint = await decideFingerprint(
        operation.path.threadId,
        operation.input.candidateId,
        operation.input.revision,
      );
      const candidate = await dependencies.resolveSavedCandidate({
        ownerScopeRef: context.ownerScopeRef,
        threadId: operation.path.threadId,
        candidateId: operation.input.candidateId,
        revision: operation.input.revision,
      });
      if (!candidate.ok) throw savedCandidateFailure(candidate.code);
      const decided = await store.decide(
        context.ownerScopeRef,
        {
          provider: candidate.provider,
          recordRef: candidate.recordRef,
          decidedAt: context.serverNow,
        },
        {
          idempotencyKey: operation.input.idempotencyKey,
          idempotencyFingerprint: fingerprint,
        },
      );
      if (!decided.ok) throw ownerStoreFailure(decided.code);
      return {
        kind: 'place_decide',
        response: {
          schemaVersion: 'v1',
          requestId: operation.input.requestId,
          candidateId: operation.input.candidateId,
          savedPlaceRef: decided.reference.savedPlaceRef,
          decidedAt: decided.decidedAt,
        },
      };
    }
  }
};

const decideFingerprint = async (
  threadId: string,
  candidateId: string,
  revision: number,
): Promise<string> => {
  const encoded = new TextEncoder().encode(
    `place-decide\u0000${threadId}\u0000${candidateId}\u0000${revision}`,
  );
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};
