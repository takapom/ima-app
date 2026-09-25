import type { ConversationHistoryNamespace } from '@worker/adapters/out/persistence/conversations/durable-conversation-store';
import { DurableRateLimiter } from '@worker/adapters/out/persistence/security/durable-rate-limiter';
import { createThreadApplicationHandler } from '@worker/adapters/in/http/thread-application';
export { createThreadScopeAuthorizer } from '@worker/adapters/in/http/thread-application';
import type {
  ApplicationHandler,
  EventsSink,
  HandlerDependencies,
  PhotoBodyHandler,
} from '@worker/adapters/in/http/handler';
import { HttpBoundaryError } from '@worker/adapters/in/http/errors';
import {
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  type HttpRouterConfig,
  type ResourceScopeAuthorizer,
} from '@worker/adapters/in/http/router';
import type { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import type {
  RateLimitConfig,
  RateLimitDO,
} from '@worker/adapters/out/persistence/security/rate-limit-do';
import {
  createRuntimeApplicationHandler,
  type RuntimeCancellationClassification,
} from '@worker/adapters/in/http/runtime-handler';
import type { AppIntegrityNamespace } from '@worker/adapters/out/persistence/security/app-integrity-do';
import { createBootstrapAppIntegrityGate } from '@worker/composition/app-integrity-bootstrap';
import { personalPreviewEnabled } from '@worker/composition/personal-preview';
import type { AppIntegrityVerifier } from '@worker/application/ports/app-integrity';
import { createBestEffortEventsSink, createTelemetryEventsSink } from '@worker/telemetry/events';
import {
  createDurableTelemetryStore,
  type TelemetryNamespace,
} from '@worker/adapters/out/persistence/telemetry/telemetry-do';
import type { AppIntegrityGate } from '@worker/adapters/in/http/app-integrity-gate';
import { createConfiguredPhoto } from '@worker/composition/bootstrap-photo';
import { createDurableOwnerStore } from '@worker/adapters/out/persistence/saved-references/durable-owner-store';
import type { SavedReferenceNamespace } from '@worker/adapters/out/persistence/saved-references/saved-reference-rpc';

export { createApplicationScopeAuthorizer } from '@worker/adapters/in/http/saved-reference-refresh';

export type BootstrapEnv = {
  readonly APP_TOKEN?: string;
  readonly IMA_PERSONAL_PREVIEW?: string;
  readonly HOTPEPPER_API_KEY?: string;
  readonly PHOTO_TOKEN_SECRET?: string;
  readonly PLACES_CURSOR_SECRET?: string;
  readonly IMA_RUNTIME_MODE?: string;
  readonly IMA_ENV?: string;
  /** Enforcement mode: disabled/internal/required. */
  readonly APP_ATTEST_MODE?: string;
  /** Apple App Attest environment: development/production. */
  readonly APP_ATTEST_ENVIRONMENT?: string;
  readonly IMA_PROVIDER_PLACES?: string;
  readonly IMA_PROVIDER_HOTPEPPER?: string;
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
  readonly CONVERSATIONS?: ConversationHistoryNamespace;
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
};

const unavailable = (): HttpBoundaryError =>
  new HttpBoundaryError({ status: 502, code: 'PROVIDER_UNAVAILABLE' });

const createApplication = (env: BootstrapEnv, options: BootstrapOptions): ApplicationHandler => {
  const runtime = createRuntimeApplicationHandler({
    threads: env.THREADS,
    ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
    ...(options.onCancellationError === undefined
      ? {}
      : { onCancellationError: options.onCancellationError }),
  });
  const ownerStore =
    env.SAVED_REFERENCES === undefined ? undefined : createDurableOwnerStore(env.SAVED_REFERENCES);
  return createThreadApplicationHandler(env.THREADS, runtime, ownerStore);
};

const createUnavailableEvents = (): EventsSink => ({
  accept() {
    return Promise.reject(unavailable());
  },
});

export const createHttpRouterConfig = (
  env: BootstrapEnv,
  options: BootstrapOptions,
): HttpRouterConfig => {
  const handlers: HandlerDependencies = {
    application: createApplication(env, options),
    photo: options.photo ?? createConfiguredPhoto(env),
    events: createBestEffortEventsSink(
      options.events ??
        (env.TELEMETRY === undefined
          ? createUnavailableEvents()
          : createTelemetryEventsSink(createDurableTelemetryStore(env.TELEMETRY))),
    ),
    rateLimiter: personalPreviewEnabled(env)
      ? { check: () => Promise.resolve({ allowed: true, retryAfterSeconds: null }) }
      : new DurableRateLimiter(env.RATE_LIMITS, options.rateLimit ?? DEFAULT_RATE_LIMIT_CONFIG),
  };
  return {
    ...(env.CONVERSATIONS === undefined ? {} : { conversations: env.CONVERSATIONS }),
    conversationReadsRateLimiter: new DurableRateLimiter(
      env.RATE_LIMITS,
      { windowMs: 3_600_000, devicePerWindow: 3_600, ownerPerWindow: 12_000 },
      'conversation-read-v1',
    ),
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
