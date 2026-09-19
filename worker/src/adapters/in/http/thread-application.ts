import type { OwnerStore } from '@worker/application/ports/owner-store';
import type { OwnerSavedCandidateResult } from '@worker/application/ports/owner-candidate';
import type {
  ApplicationHandler,
  ApplicationOperation,
  ApplicationResult,
  HandlerContext,
} from '@worker/adapters/in/http/handler';
import { HttpBoundaryError, type BoundaryFailure } from '@worker/adapters/in/http/errors';
import type {
  ResourceScopeAuthorizer,
  ResourceScopeDecision,
} from '@worker/adapters/in/http/router';
import {
  isThreadConflictError,
  isThreadStateError,
  type ThreadConflictError,
  type ThreadStateError,
  type ThreadDeleteResult,
  type ThreadOperationErrorCode,
  type ThreadSnapshotResult,
  type ThreadState,
  type ThreadAuthorization,
} from '@worker/runtime/threads/thread-types';
import type { RuntimeThreadStub } from '@worker/adapters/in/http/runtime-handler';
import { createThreadId } from '@worker/runtime/threads/thread-id';
import {
  handleOwnerApplication,
  isOwnerApplicationOperation,
} from '@worker/adapters/in/http/owner-application';

export type ThreadApplicationNamespace = {
  readonly getByName: (name: string) => RuntimeThreadStub & {
    initialize(
      owner: string,
      threadId: string,
      requireActiveSession?: boolean,
    ): Promise<ThreadSnapshotResult>;
    applyLifecycle(
      owner: string,
      action: Exclude<ThreadState, 'active'>,
      turnId: string | null,
      revision: number,
      key: string,
    ): Promise<ThreadSnapshotResult>;
    deleteThread(
      owner: string,
      turnId: string | null,
      revision: number,
      key: string,
    ): Promise<ThreadDeleteResult>;
    authorize(owner: string): Promise<ThreadAuthorization>;
    resolveCandidateForSavedReference(
      owner: string,
      candidateId: string,
      revision: number,
    ): Promise<OwnerSavedCandidateResult>;
  };
};

const unavailable = (): HttpBoundaryError =>
  new HttpBoundaryError({ status: 502, code: 'PROVIDER_UNAVAILABLE' });

const threadFailure = (error: ThreadStateError | ThreadConflictError): HttpBoundaryError => {
  const failure: BoundaryFailure = isThreadConflictError(error)
    ? { status: 409, code: 'CONFLICT' }
    : error.code === 'NOT_FOUND'
      ? { status: 404, code: 'NOT_FOUND' }
      : { status: 403, code: 'FORBIDDEN' };
  return new HttpBoundaryError(failure);
};

const threadFailureCode = (code: ThreadOperationErrorCode): HttpBoundaryError =>
  new HttpBoundaryError(
    code === 'NOT_FOUND'
      ? { status: 404, code: 'NOT_FOUND' }
      : code === 'FORBIDDEN'
        ? { status: 403, code: 'FORBIDDEN' }
        : { status: 409, code: 'CONFLICT' },
  );

const requireSnapshot = (result: ThreadSnapshotResult) => {
  if (result.ok) return result.snapshot;
  throw threadFailureCode(result.code);
};

const requireDelete = (result: ThreadDeleteResult): void => {
  if (result.ok) return;
  throw threadFailureCode(result.code);
};

const threadCall = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error: unknown) {
    if (isThreadStateError(error) || isThreadConflictError(error)) {
      throw threadFailure(error);
    }
    throw error;
  }
};

const lifecycleState = (
  action: 'cancel' | 'resume' | 'restart' | 'end',
): Exclude<ThreadState, 'active'> => {
  switch (action) {
    case 'cancel':
      return 'cancelled';
    case 'resume':
      return 'resumed';
    case 'restart':
      return 'restarted';
    case 'end':
      return 'ended';
  }
};

const threadStub = (env: { readonly THREADS: ThreadApplicationNamespace }, threadId: string) =>
  env.THREADS.getByName(threadId);

const handleApplication = async (
  env: { readonly THREADS: ThreadApplicationNamespace },
  runtime: ApplicationHandler,
  ownerStore: OwnerStore | undefined,
  operation: ApplicationOperation,
  context: HandlerContext,
): Promise<ApplicationResult> => {
  if (isOwnerApplicationOperation(operation)) {
    return handleOwnerApplication(operation, context, {
      ownerStore,
      resolveSavedCandidate: (input) =>
        threadCall(async () =>
          threadStub(env, input.threadId).resolveCandidateForSavedReference(
            input.ownerScopeRef,
            input.candidateId,
            input.revision,
          ),
        ),
    });
  }
  switch (operation.kind) {
    case 'create_thread': {
      const threadId = await createThreadId(context.ownerScopeRef, operation.input.idempotencyKey);
      const snapshot = requireSnapshot(
        await threadCall(
          async () =>
            await threadStub(env, threadId).initialize(context.ownerScopeRef, threadId, true),
        ),
      );
      if (!snapshot.active) throw new HttpBoundaryError({ status: 409, code: 'CONFLICT' });
      return {
        kind: 'create_thread',
        response: {
          schemaVersion: 'v1',
          requestId: operation.input.requestId,
          threadId: snapshot.threadId,
          revision: snapshot.revision,
          state: 'active',
        },
      };
    }
    case 'read_thread':
    case 'replay_thread':
    case 'turn':
    case 'search':
      return runtime.handle(operation, context);
    case 'lifecycle': {
      const snapshot = requireSnapshot(
        await threadCall(
          async () =>
            await threadStub(env, operation.path.threadId).applyLifecycle(
              context.ownerScopeRef,
              lifecycleState(operation.action),
              operation.input.turnId,
              operation.input.revision,
              operation.input.idempotencyKey,
            ),
        ),
      );
      return {
        kind: 'lifecycle',
        response: {
          schemaVersion: 'v1',
          requestId: context.requestId,
          threadId: snapshot.threadId,
          turnId: operation.input.turnId,
          revision: snapshot.revision,
          state: snapshot.state,
        },
      };
    }
    case 'delete_thread':
      requireDelete(
        await threadCall(
          async () =>
            await threadStub(env, operation.path.threadId).deleteThread(
              context.ownerScopeRef,
              operation.input.turnId,
              operation.input.revision,
              operation.input.idempotencyKey,
            ),
        ),
      );
      return { kind: 'delete_thread', response: null };
    case 'saved_reference_refresh':
      throw unavailable();
  }
};

export const createThreadApplicationHandler = (
  threads: ThreadApplicationNamespace,
  runtime: ApplicationHandler,
  ownerStore: OwnerStore | undefined,
): ApplicationHandler => ({
  handle: (operation, context) =>
    handleApplication({ THREADS: threads }, runtime, ownerStore, operation, context),
});

const threadScopeFailure = (error: unknown): ResourceScopeDecision => {
  if (isThreadStateError(error)) {
    return {
      allowed: false,
      failure:
        error.code === 'NOT_FOUND'
          ? { status: 404, code: 'NOT_FOUND' }
          : { status: 403, code: 'FORBIDDEN' },
    };
  }
  return { allowed: false, failure: { status: 500, code: 'INTERNAL' } };
};

/** Thread ownership is resolvable here; unknown provider resources remain denied. */
export const createThreadScopeAuthorizer = (
  namespace: ThreadApplicationNamespace,
): ResourceScopeAuthorizer => ({
  authorize(input) {
    if (input.resource.kind !== 'thread') {
      return Promise.resolve({ allowed: false, failure: { status: 404, code: 'NOT_FOUND' } });
    }
    return namespace
      .getByName(input.resource.id)
      .authorize(input.ownerScopeRef)
      .then((decision): ResourceScopeDecision =>
        decision.allowed
          ? decision
          : {
              allowed: false,
              failure:
                decision.reason === 'NOT_FOUND'
                  ? { status: 404, code: 'NOT_FOUND' }
                  : { status: 403, code: 'FORBIDDEN' },
            },
      )
      .catch((error: unknown) => threadScopeFailure(error));
  },
});
