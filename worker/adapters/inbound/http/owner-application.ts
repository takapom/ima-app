import {
  registerOwnerSavedReference,
  decideOwnerPlace,
  type OwnerSavedCandidateResult,
  type OwnerSavedCandidateResolver,
  type OwnerReferenceFingerprint,
} from '@ima/core';
export type { OwnerSavedCandidateResult, OwnerSavedCandidateResolver } from '@ima/core';

import type {
  ApplicationOperation,
  ApplicationResult,
  HandlerContext,
} from '@worker/adapters/inbound/http/handler';
import { HttpBoundaryError } from '@worker/adapters/inbound/http/errors';
import type {
  OwnerDecideResult,
  OwnerRegisterResult,
  OwnerStore,
  SavedReferenceDeleteResult,
  SavedReferenceReplayResult,
} from '@ima/core';

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

const fingerprintOwnerReference: OwnerReferenceFingerprint = async (operation, input) => {
  const prefix = operation === 'save' ? 'saved-reference' : 'place-decide';
  const encoded = new TextEncoder().encode(
    `${prefix}\u0000${input.threadId}\u0000${input.candidateId}\u0000${input.revision}`,
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
      const saved = await registerOwnerSavedReference(
        {
          ownerScopeRef: context.ownerScopeRef,
          threadId: operation.path.threadId,
          candidateId: operation.input.candidateId,
          revision: operation.input.revision,
          idempotencyKey: operation.input.idempotencyKey,
        },
        {
          store,
          resolveSavedCandidate: dependencies.resolveSavedCandidate,
          fingerprint: fingerprintOwnerReference,
        },
      );
      if (!saved.ok)
        throw saved.source === 'candidate'
          ? savedCandidateFailure(saved.code)
          : ownerStoreFailure(saved.code);
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
      const decided = await decideOwnerPlace(
        {
          ownerScopeRef: context.ownerScopeRef,
          threadId: operation.path.threadId,
          candidateId: operation.input.candidateId,
          revision: operation.input.revision,
          idempotencyKey: operation.input.idempotencyKey,
          decidedAt: context.serverNow,
        },
        {
          store,
          resolveSavedCandidate: dependencies.resolveSavedCandidate,
          fingerprint: fingerprintOwnerReference,
        },
      );
      if (!decided.ok)
        throw decided.source === 'candidate'
          ? savedCandidateFailure(decided.code)
          : ownerStoreFailure(decided.code);
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
