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
  ThreadSavedCandidateResult,
  ThreadDO,
  ThreadState,
} from './thread-do';
import {
  createRuntimeApplicationHandler,
  type RuntimeCancellationClassification,
} from './bootstrap-runtime';
import type { AppIntegrityNamespace } from './security/app-integrity-do';
import { createBootstrapAppIntegrityGate } from './security/app-integrity-bootstrap';
import type { AppIntegrityVerifier } from './security/app-integrity';
import { createBestEffortEventsSink, createTelemetryEventsSink } from './telemetry/events';
import { createDurableTelemetryStore, type TelemetryNamespace } from './telemetry/telemetry-do';
import type { AppIntegrityGate } from './security/app-integrity';
import { createThreadId } from './thread-id';
import { createConfiguredPhoto } from './bootstrap-photo';
import {
  createOwnerSavedReferenceRpc,
  type SavedReferenceNamespace,
  type SavedReferenceRpcDeleteResult,
  type SavedReferenceRpcRegistrationResult,
} from './saved-references/saved-reference-rpc';
import {
  createSavedReferenceRefreshForBootstrap,
  type SavedReferenceRefreshBootstrapOptions,
} from './saved-references/saved-reference-refresh-bootstrap';

export { createApplicationScopeAuthorizer } from './saved-references/saved-reference-refresh';

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
  /** Optional C2 durable challenge/key store; C3 wires it into the HTTP gate. */
  readonly APP_INTEGRITY?: AppIntegrityNamespace;
  readonly TELEMETRY?: TelemetryNamespace;
  readonly SAVED_REFERENCES?: SavedReferenceNamespace;
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
  /** Native verifier injection; absent means the default gate remains fail-closed. */
  readonly appIntegrityVerifier?: AppIntegrityVerifier;
} & Omit<SavedReferenceRefreshBootstrapOptions, 'clock'>;

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

const savedReferenceFailure = (
  code:
    | Extract<SavedReferenceRpcRegistrationResult, { readonly ok: false }>['code']
    | Extract<SavedReferenceRpcDeleteResult, { readonly ok: false }>['code']
    | 'OWNER_CONFLICT',
): HttpBoundaryError =>
  new HttpBoundaryError(
    code === 'INVALID_INPUT'
      ? { status: 400, code: 'INVALID_ARGUMENT' }
      : code === 'FORBIDDEN'
        ? { status: 403, code: 'FORBIDDEN' }
        : code === 'CORRUPT_ROW' || code === 'OWNER_NOT_INITIALIZED' || code === 'OWNER_CONFLICT'
          ? { status: 500, code: 'INTERNAL' }
          : { status: 409, code: 'CONFLICT' },
  );

const savedCandidateFailure = (
  code: Extract<ThreadSavedCandidateResult, { readonly ok: false }>['code'],
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

const requireSavedReferenceRpc = (
  env: BootstrapEnv,
  ownerScopeRef: string,
): ReturnType<typeof createOwnerSavedReferenceRpc> => {
  if (env.SAVED_REFERENCES === undefined) throw unavailable();
  return createOwnerSavedReferenceRpc(env.SAVED_REFERENCES, ownerScopeRef);
};

const requireSavedReferenceOwner = async (
  rpc: ReturnType<typeof createOwnerSavedReferenceRpc>,
): Promise<void> => {
  const initialized = await rpc.initialize();
  if (!initialized.ok) throw savedReferenceFailure(initialized.code);
};

const requireSavedCandidate = async (
  env: BootstrapEnv,
  ownerScopeRef: string,
  threadId: string,
  candidateId: string,
  revision: number,
): Promise<{
  readonly ok: true;
  readonly candidateId: string;
  readonly provider: string;
  readonly recordRef: string;
}> => {
  const result: ThreadSavedCandidateResult = await threadCall(
    async () =>
      await threadStub(env, threadId).resolveCandidateForSavedReference(
        ownerScopeRef,
        candidateId,
        revision,
      ),
  );
  if (!result.ok) throw savedCandidateFailure(result.code);
  return {
    ok: true,
    candidateId: result.candidateId,
    provider: result.provider,
    recordRef: result.recordRef,
  };
};

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
  savedReferenceRefresh: ReturnType<typeof createSavedReferenceRefreshForBootstrap>,
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
    case 'saved_reference_create': {
      const rpc = requireSavedReferenceRpc(env, context.ownerScopeRef);
      await requireSavedReferenceOwner(rpc);
      const fingerprint = await savedReferenceFingerprint(
        operation.path.threadId,
        operation.input.candidateId,
        operation.input.revision,
      );
      const replay = await rpc.replay(operation.input.idempotencyKey, fingerprint);
      if (!replay.ok) throw savedReferenceFailure(replay.code);
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
      const candidate = await requireSavedCandidate(
        env,
        context.ownerScopeRef,
        operation.path.threadId,
        operation.input.candidateId,
        operation.input.revision,
      );
      const saved = await rpc.register(
        { provider: candidate.provider, recordRef: candidate.recordRef },
        { idempotencyKey: operation.input.idempotencyKey, idempotencyFingerprint: fingerprint },
      );
      if (!saved.ok) throw savedReferenceFailure(saved.code);
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
      const rpc = requireSavedReferenceRpc(env, context.ownerScopeRef);
      await requireSavedReferenceOwner(rpc);
      const removed = await rpc.remove(operation.path.savedPlaceRef, {
        idempotencyKey: operation.input.idempotencyKey,
      });
      if (!removed.ok) throw savedReferenceFailure(removed.code);
      return { kind: 'saved_reference_delete', response: null };
    }
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
      throw unavailable();
    case 'saved_reference_refresh':
      if (savedReferenceRefresh === undefined) throw unavailable();
      return savedReferenceRefresh.handle(operation, context);
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
  const savedReferenceRefresh = createSavedReferenceRefreshForBootstrap(env, options);
  return {
    handle(operation, context) {
      return handleApplication(env, runtime, savedReferenceRefresh, operation, context);
    },
  };
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
    photo: options.photo ?? createConfiguredPhoto(env, options),
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
      options.appIntegrity ?? createBootstrapAppIntegrityGate(env, options.appIntegrityVerifier),
    now: options.clock ?? (() => new Date().toISOString()),
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES,
  };
};
