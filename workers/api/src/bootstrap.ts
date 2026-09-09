import type {
  ApplicationHandler,
  ApplicationOperation,
  ApplicationResult,
  EventsSink,
  HandlerContext,
  HandlerDependencies,
  PhotoBodyHandler,
  RateLimiter,
} from './http/handler';
import { HttpBoundaryError, type BoundaryFailure } from './http/errors';
import {
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  type HttpRouterConfig,
  type ResourceScopeAuthorizer,
  type ResourceScopeDecision,
} from './http/router';
import {
  isThreadConflictError,
  isThreadStateError,
  type ThreadConflictError,
  type ThreadStateError,
} from './thread-do';
import type {
  RateLimitCheckResult,
  RateLimitConfig,
  RateLimitDO,
  ThreadDeleteResult,
  ThreadOperationErrorCode,
  ThreadSnapshotResult,
  ThreadDO,
  ThreadState,
} from './thread-do';

export type BootstrapEnv = {
  readonly APP_TOKEN?: string;
  readonly THREADS: DurableObjectNamespace<ThreadDO>;
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitDO>;
};

/** 30 device requests and 100 owner requests per hour follows the M05 design ceiling. */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = Object.freeze({
  windowMs: 60 * 60 * 1_000,
  devicePerWindow: 30,
  ownerPerWindow: 100,
});

export type BootstrapOptions = {
  readonly ownership: ResourceScopeAuthorizer;
  readonly clock?: () => string;
  readonly requestIdFactory?: () => string;
  readonly maxBodyBytes?: number;
  readonly rateLimit?: RateLimitConfig;
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

const threadStub = (env: BootstrapEnv, threadId: string) => env.THREADS.getByName(threadId);

const readThread = async (
  env: BootstrapEnv,
  operation: Extract<ApplicationOperation, { kind: 'read_thread' | 'replay_thread' }>,
  context: HandlerContext,
): Promise<ApplicationResult> => {
  const snapshot = requireSnapshot(
    await threadCall(
      async () => await threadStub(env, operation.path.threadId).read(context.ownerScopeRef),
    ),
  );
  return {
    kind: operation.kind,
    response: {
      schemaVersion: 'v1',
      requestId: context.requestId,
      threadId: snapshot.threadId,
      revision: snapshot.revision,
      active: snapshot.active,
      responses: [],
    },
  };
};

const handleApplication = async (
  env: BootstrapEnv,
  operation: ApplicationOperation,
  context: HandlerContext,
): Promise<ApplicationResult> => {
  switch (operation.kind) {
    case 'create_thread': {
      const threadId = crypto.randomUUID();
      const snapshot = requireSnapshot(
        await threadCall(
          async () => await threadStub(env, threadId).initialize(context.ownerScopeRef, threadId),
        ),
      );
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
      return readThread(env, operation, context);
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
    case 'turn':
      requireSnapshot(
        await threadCall(
          async () => await threadStub(env, operation.path.threadId).read(context.ownerScopeRef),
        ),
      );
      throw unavailable();
    case 'search':
      requireSnapshot(
        await threadCall(
          async () => await threadStub(env, operation.input.threadId).read(context.ownerScopeRef),
        ),
      );
      throw unavailable();
    case 'place':
    case 'saved_reference_refresh':
      throw unavailable();
  }
};

const createApplication = (env: BootstrapEnv): ApplicationHandler => ({
  handle(operation, context) {
    return handleApplication(env, operation, context);
  },
});

const createUnavailablePhoto = (): PhotoBodyHandler => ({
  read() {
    return Promise.reject(unavailable());
  },
});

const createUnavailableEvents = (): EventsSink => ({
  accept() {
    return Promise.reject(unavailable());
  },
});

class DurableRateLimiter implements RateLimiter {
  private static readonly bucketName = 'm05-rate-limit-v1';

  constructor(
    private readonly namespace: DurableObjectNamespace<RateLimitDO>,
    private readonly config: RateLimitConfig,
  ) {}

  check(input: Parameters<RateLimiter['check']>[0]): Promise<RateLimitCheckResult> {
    // One durable bucket keeps the device ceiling effective across owner scopes.
    return this.namespace.getByName(DurableRateLimiter.bucketName).check({
      ...input,
      config: this.config,
    });
  }
}

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
  namespace: DurableObjectNamespace<ThreadDO>,
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

export const createHttpRouterConfig = (
  env: BootstrapEnv,
  options: BootstrapOptions,
): HttpRouterConfig => {
  const handlers: HandlerDependencies = {
    application: createApplication(env),
    photo: createUnavailablePhoto(),
    events: createUnavailableEvents(),
    rateLimiter: new DurableRateLimiter(
      env.RATE_LIMITS,
      options.rateLimit ?? DEFAULT_RATE_LIMIT_CONFIG,
    ),
  };
  return {
    auth: {
      appToken: env.APP_TOKEN ?? '',
      requestIdFactory: options.requestIdFactory ?? (() => crypto.randomUUID()),
    },
    handlers,
    ownership: options.ownership,
    now: options.clock ?? (() => new Date().toISOString()),
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES,
  };
};
