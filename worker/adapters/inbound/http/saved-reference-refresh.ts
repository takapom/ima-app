import type {
  ResourceScopeAuthorizer,
  ResourceScopeDecision,
} from '@worker/adapters/inbound/http/router';
import {
  createOwnerSavedReferenceRpc,
  type OwnerSavedReferenceRpc,
  type SavedReferenceNamespace,
} from '@worker/adapters/outbound/persistence/saved-references/saved-reference-rpc';
const AUTHORIZATION_TIMEOUT = new Error('saved-reference-authorization-timeout');
const AUTHORIZATION_ABORTED = new Error('saved-reference-authorization-aborted');
const awaitAuthorization = async <T>(
  operation: Promise<T>,
  timeoutPromise: Promise<never>,
  signal?: AbortSignal,
): Promise<T> => {
  operation.catch(() => undefined);
  if (signal?.aborted === true) throw AUTHORIZATION_ABORTED;
  let removeAbort = (): void => undefined;
  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => reject(AUTHORIZATION_ABORTED);
          removeAbort = (): void => signal.removeEventListener('abort', onAbort);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
  try {
    return abortPromise === undefined
      ? await Promise.race([operation, timeoutPromise])
      : await Promise.race([operation, timeoutPromise, abortPromise]);
  } finally {
    removeAbort();
  }
};

const savedReferenceDecision = async (
  namespace: SavedReferenceNamespace,
  ownerScopeRef: string,
  savedPlaceRef: string,
  signal?: AbortSignal,
): Promise<ResourceScopeDecision> => {
  if (signal?.aborted === true) {
    return { allowed: false, failure: { status: 409, code: 'CANCELLED' } };
  }
  const timeout = 10_000;
  let authorizationTimer: ReturnType<typeof setTimeout> | undefined;
  let readPromise: Promise<Awaited<ReturnType<OwnerSavedReferenceRpc['read']>>>;
  try {
    readPromise = createOwnerSavedReferenceRpc(namespace, ownerScopeRef).read(savedPlaceRef);
  } catch {
    return { allowed: false, failure: { status: 500, code: 'INTERNAL' } };
  }
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    authorizationTimer = setTimeout(() => reject(AUTHORIZATION_TIMEOUT), timeout);
  });
  // A late RPC rejection must remain handled after the bounded authorizer returns.
  try {
    const result = await awaitAuthorization(readPromise, timeoutPromise, signal);
    if (
      result.ok &&
      result.reference !== null &&
      result.reference.ownerScopeRef === ownerScopeRef &&
      result.reference.savedPlaceRef === savedPlaceRef
    ) {
      return { allowed: true };
    }
    if (result.ok && result.reference !== null) {
      return { allowed: false, failure: { status: 500, code: 'INTERNAL' } };
    }
    if (!result.ok && result.code === 'CORRUPT_ROW') {
      return { allowed: false, failure: { status: 500, code: 'INTERNAL' } };
    }
    return { allowed: false, failure: { status: 404, code: 'NOT_FOUND' } };
  } catch (error: unknown) {
    if (error === AUTHORIZATION_TIMEOUT) {
      return { allowed: false, failure: { status: 504, code: 'TIMEOUT' } };
    }
    if (error === AUTHORIZATION_ABORTED) {
      return { allowed: false, failure: { status: 409, code: 'CANCELLED' } };
    }
    return { allowed: false, failure: { status: 500, code: 'INTERNAL' } };
  } finally {
    if (authorizationTimer !== undefined) clearTimeout(authorizationTimer);
  }
};

/** Authorizes saved refs by reading the owner shard; it never creates a ThreadDO. */
export const createSavedReferenceScopeAuthorizer = (
  namespace: SavedReferenceNamespace,
): ResourceScopeAuthorizer => ({
  authorize(input) {
    if (input.resource.kind !== 'saved_reference') {
      return Promise.resolve({ allowed: false, failure: { status: 404, code: 'NOT_FOUND' } });
    }
    return savedReferenceDecision(namespace, input.ownerScopeRef, input.resource.id, input.signal);
  },
});

export const createApplicationScopeAuthorizer = (
  threadAuthorizer: ResourceScopeAuthorizer,
  savedReferences?: SavedReferenceNamespace,
): ResourceScopeAuthorizer => {
  const savedAuthorizer =
    savedReferences === undefined
      ? undefined
      : createSavedReferenceScopeAuthorizer(savedReferences);
  return {
    authorize(input) {
      return input.resource.kind === 'saved_reference' && savedAuthorizer !== undefined
        ? savedAuthorizer.authorize(input)
        : threadAuthorizer.authorize(input);
    },
  };
};
