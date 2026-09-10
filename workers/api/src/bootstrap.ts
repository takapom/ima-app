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
import {
  createRuntimeApplicationHandler,
  type RuntimeCancellationClassification,
} from './bootstrap-runtime';
import { createPhotoBodyHandler } from './providers/photo/http';
import { PhotoProviderError } from './providers/photo/media';
import { createGooglePhotoMediaTransport } from './providers/photo/transport';
import { createPhotoTokenCodec } from './providers/photo/token';
import { createPhotoReferenceStoreResolver } from './providers/photo/rpc';
import type { PhotoTokenCodec } from './providers/photo/types';
import { createBestEffortEventsSink, createTelemetryEventsSink } from './telemetry/events';
import { createDurableTelemetryStore, type TelemetryNamespace } from './telemetry/telemetry-do';
import {
  createAppIntegrityGate,
  resolveAppIntegrityPolicy,
  type AppIntegrityGate,
} from './security/app-integrity';
import { resolveRuntimeOperationalGate } from './runtime/runtime-operational-gate';
import { createThreadId } from './thread-id';

export type BootstrapEnv = {
  readonly APP_TOKEN?: string;
  readonly GOOGLE_PLACES_API_KEY?: string;
  readonly PHOTO_TOKEN_SECRET?: string;
  readonly IMA_RUNTIME_MODE?: string;
  readonly IMA_ENV?: string;
  /** Enforcement mode: disabled/internal/required. */
  readonly APP_ATTEST_MODE?: string;
  /** Apple App Attest environment: development/production. */
  readonly APP_ATTEST_ENVIRONMENT?: string;
  readonly IMA_PROVIDER_PLACES?: string;
  readonly IMA_PROVIDER_HOTPEPPER?: string;
  readonly IMA_PROVIDER_LAST_TRAIN?: string;
  readonly IMA_PROVIDER_ROUTES?: string;
  readonly IMA_PROVIDER_OPENAI?: string;
  readonly IMA_SHARE_LINE_SCHEME?: string;
  readonly IMA_KILL_SWITCH?: string;
  readonly IMA_QUALITY_ENVELOPE?: string;
  readonly THREADS: DurableObjectNamespace<ThreadDO>;
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitDO>;
  readonly TELEMETRY?: TelemetryNamespace;
};

/** 30 device requests and 100 owner requests per hour follows the M05 design ceiling. */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = Object.freeze({
  windowMs: 60 * 60 * 1_000,
  devicePerWindow: 30,
  ownerPerWindow: 100,
});

export type BootstrapOptions = {
  readonly ownership: ResourceScopeAuthorizer;
  /** Optional event collector; its failure is isolated from product operations. */
  readonly events?: EventsSink;
  /** Production composition injects the authenticated, token-bound photo adapter. */
  readonly photo?: PhotoBodyHandler;
  /** Test/runtime composition may provide the already-scoped upstream fetcher. */
  readonly photoFetcher?: typeof fetch;
  readonly clock?: () => string;
  readonly requestIdFactory?: () => string;
  readonly maxBodyBytes?: number;
  readonly rateLimit?: RateLimitConfig;
  readonly waitUntil?: (promise: Promise<void>) => void;
  readonly onCancellationError?: (classification: RuntimeCancellationClassification) => void;
  /** External distribution may inject the verified App Attest store/verifier boundary. */
  readonly appIntegrity?: AppIntegrityGate;
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

const handleApplication = async (
  env: BootstrapEnv,
  runtime: ApplicationHandler,
  operation: ApplicationOperation,
  context: HandlerContext,
): Promise<ApplicationResult> => {
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
    case 'place':
    case 'saved_reference_refresh':
      throw unavailable();
  }
};

const createApplication = (env: BootstrapEnv, options: BootstrapOptions): ApplicationHandler => {
  const runtime = createRuntimeApplicationHandler({
    threads: env.THREADS,
    ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
    ...(options.onCancellationError === undefined
      ? {}
      : { onCancellationError: options.onCancellationError }),
  });
  return {
    handle(operation, context) {
      return handleApplication(env, runtime, operation, context);
    },
  };
};

const createUnavailablePhoto = (tokenCodec?: PhotoTokenCodec): PhotoBodyHandler => {
  if (tokenCodec === undefined) {
    return {
      read() {
        return Promise.reject(unavailable());
      },
    };
  }
  return createPhotoBodyHandler({
    tokenCodec,
    transport: {
      read: () => Promise.reject(new PhotoProviderError('UPSTREAM_UNAVAILABLE')),
    },
  });
};

const createConfiguredPhoto = (
  env: BootstrapEnv,
  photoFetcher?: typeof fetch,
): PhotoBodyHandler => {
  const operational = resolveRuntimeOperationalGate(env);
  const tokenSecret = env.PHOTO_TOKEN_SECRET?.trim();
  if (tokenSecret === undefined || tokenSecret.length === 0) return createUnavailablePhoto();
  const tokenCodec = createPhotoTokenCodec({
    secret: tokenSecret,
    referenceResolver: createPhotoReferenceStoreResolver((threadId) =>
      env.THREADS.getByName(threadId),
    ),
  });
  if (!operational.enabled('places')) return createUnavailablePhoto(tokenCodec);
  if (operational.mode === 'fixture' && photoFetcher === undefined) {
    // Fixture mode must receive an injected fetcher; it never falls through to global fetch.
    return createUnavailablePhoto(tokenCodec);
  }
  const apiKey = env.GOOGLE_PLACES_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) return createUnavailablePhoto(tokenCodec);
  const transport = createGooglePhotoMediaTransport({ apiKey, fetcher: photoFetcher ?? fetch });
  return createPhotoBodyHandler({ tokenCodec, transport });
};

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
    application: createApplication(env, options),
    photo: options.photo ?? createConfiguredPhoto(env, options.photoFetcher),
    events: createBestEffortEventsSink(
      options.events ??
        (env.TELEMETRY === undefined
          ? createUnavailableEvents()
          : createTelemetryEventsSink(createDurableTelemetryStore(env.TELEMETRY))),
    ),
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
    appIntegrity:
      options.appIntegrity ??
      (() => {
        const policy = resolveAppIntegrityPolicy({
          ...(env.IMA_ENV === undefined ? {} : { deploymentEnvironment: env.IMA_ENV }),
          ...(env.APP_ATTEST_ENVIRONMENT === undefined
            ? {}
            : { environment: env.APP_ATTEST_ENVIRONMENT }),
          ...(env.APP_ATTEST_MODE === undefined ? {} : { enforcement: env.APP_ATTEST_MODE }),
        });
        return createAppIntegrityGate(policy);
      })(),
    now: options.clock ?? (() => new Date().toISOString()),
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES,
  };
};
