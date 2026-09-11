import * as v from 'valibot';
import { IsoTimestampSchema } from '@ima/contracts';
import type { SavedPlaceReference } from '@ima/core';
import { HttpBoundaryError, type BoundaryFailure } from '../http/errors';
import type { ApplicationOperation, ApplicationResult, HandlerContext } from '../http/handler';
import type { ResourceScopeAuthorizer, ResourceScopeDecision } from '../http/router';
import { createGooglePlaceDetailsTransport } from '../providers/places-details/transport';
import {
  GooglePlaceDetailsError,
  type GooglePlaceDetailsTransport,
} from '../providers/places-details/types';
import { operationalFlagEnabled, resolveOperationalFlags } from '../telemetry/flags';
import {
  createOwnerSavedReferenceRpc,
  type OwnerSavedReferenceRpc,
  type SavedReferenceNamespace,
} from './saved-reference-rpc';
import {
  assertPublicResponseUsableAt,
  publicResponseFor,
} from './saved-reference-refresh-projection';
import type {
  SavedReferenceRefreshProjectionDependencies,
  SavedReferenceRefreshRetentionPolicy,
} from './saved-reference-refresh-types';

export type {
  SavedReferenceRefreshIdInput,
  SavedReferenceRefreshProjectionDependencies,
  SavedReferenceRefreshRetentionInput,
  SavedReferenceRefreshRetentionPolicy,
} from './saved-reference-refresh-types';

const GOOGLE_PLACES_PROVIDER = 'google_places';

type SavedReferenceRefreshOperation = Extract<
  ApplicationOperation,
  { readonly kind: 'saved_reference_refresh' }
>;

type SavedReferenceRefreshResult = Extract<
  ApplicationResult,
  { readonly kind: 'saved_reference_refresh' }
>;

export type SavedReferenceRefreshDependencies = SavedReferenceRefreshProjectionDependencies & {
  readonly namespace: SavedReferenceNamespace;
  readonly transport: GooglePlaceDetailsTransport;
  /** A fresh Worker clock is read after each awaited boundary. */
  readonly clock?: () => string;
  readonly timeoutMs?: number;
};

export type SavedReferenceRefreshEnvironment = {
  readonly GOOGLE_PLACES_API_KEY?: string;
  readonly IMA_PROVIDER_PLACES?: string;
  readonly IMA_RUNTIME_MODE?: string;
  readonly IMA_KILL_SWITCH?: string;
  readonly SAVED_REFERENCES?: SavedReferenceNamespace;
};

export type SavedReferenceRefreshBootstrapOptions = {
  readonly transport?: GooglePlaceDetailsTransport;
  readonly fetcher?: typeof fetch;
  readonly retentionFor?: SavedReferenceRefreshRetentionPolicy;
  readonly clock?: () => string;
  readonly timeoutMs?: number;
  readonly candidateIdFactory?: SavedReferenceRefreshDependencies['candidateIdFactory'];
  readonly evidenceIdFactory?: SavedReferenceRefreshDependencies['evidenceIdFactory'];
};

const boundary = (failure: BoundaryFailure): never => {
  throw new HttpBoundaryError(failure);
};

const notFound = (): never => boundary({ status: 404, code: 'NOT_FOUND' });
const internal = (): never => boundary({ status: 500, code: 'INTERNAL' });
const unavailable = (): never => boundary({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
const schemaMismatch = (): never => boundary({ status: 409, code: 'SCHEMA_MISMATCH' });
const cancelled = (): never => boundary({ status: 409, code: 'CANCELLED' });

const REQUEST_TIMEOUT = new Error('saved-reference-refresh-timeout');
const REQUEST_CANCELLED = new Error('saved-reference-refresh-cancelled');
const REQUEST_ABORTED = new Error('saved-reference-refresh-aborted');
const AUTHORIZATION_TIMEOUT = new Error('saved-reference-refresh-authorization-timeout');
const AUTHORIZATION_ABORTED = new Error('saved-reference-refresh-authorization-aborted');

/**
 * Stop waiting at the Worker boundary when the request ends. The underlying
 * RPC/transport promise still receives a rejection handler so a late result
 * cannot become an unhandled rejection; once this function returns, `work`
 * no longer retains its local provider response or reference.
 */
const awaitAbortable = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  operation.catch(() => undefined);
  if (signal.aborted) throw REQUEST_ABORTED;
  let removeAbort = (): void => undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(REQUEST_ABORTED);
    removeAbort = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, abort]);
  } finally {
    removeAbort();
  }
};

/** Waits for an owner read without pretending that the underlying DO RPC is cancellable. */
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

const providerFailure = (error: GooglePlaceDetailsError): never => {
  switch (error.code) {
    case 'CANCELLED':
      return cancelled();
    case 'TIMEOUT':
      throw new HttpBoundaryError({ status: 504, code: 'TIMEOUT' });
    case 'NOT_FOUND':
      return notFound();
    case 'RATE_LIMITED': {
      const retryAfterSeconds =
        error.retryAfterMs === null
          ? undefined
          : Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
      throw new HttpBoundaryError(
        { status: 429, code: 'RATE_LIMITED' },
        retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
      );
    }
    case 'SCHEMA_MISMATCH':
    case 'INVALID_REQUEST':
      return schemaMismatch();
    case 'MISSING_API_KEY':
    case 'UPSTREAM_UNAVAILABLE':
      return unavailable();
    default:
      return unavailable();
  }
};

const isCancelled = (context: HandlerContext, signal?: AbortSignal): boolean => {
  if (signal?.aborted === true) return true;
  if (context.signal.aborted) return true;
  try {
    return context.cancellation.isCancelled();
  } catch {
    return true;
  }
};

const assertActive = (context: HandlerContext, signal?: AbortSignal): void => {
  if (isCancelled(context, signal)) cancelled();
};

const readReference = async (
  rpc: OwnerSavedReferenceRpc,
  savedPlaceRef: string,
  ownerScopeRef: string,
  signal: AbortSignal,
): Promise<SavedPlaceReference> => {
  let readPromise: ReturnType<OwnerSavedReferenceRpc['read']>;
  try {
    readPromise = rpc.read(savedPlaceRef);
  } catch {
    return internal();
  }
  let result: Awaited<ReturnType<OwnerSavedReferenceRpc['read']>>;
  try {
    result = await awaitAbortable(readPromise, signal);
  } catch (error: unknown) {
    if (error === REQUEST_ABORTED) throw error;
    return internal();
  }
  if (!result.ok) {
    if (result.code === 'CORRUPT_ROW') internal();
    return notFound();
  }
  if (result.reference === null) return notFound();
  if (
    result.reference.ownerScopeRef !== ownerScopeRef ||
    result.reference.savedPlaceRef !== savedPlaceRef
  ) {
    return internal();
  }
  return result.reference;
};

const sameReference = (
  reference: SavedPlaceReference,
  expected: {
    readonly ownerScopeRef: string;
    readonly savedPlaceRef: string;
    readonly provider: string;
    readonly recordRef: string;
  },
): boolean =>
  reference.ownerScopeRef === expected.ownerScopeRef &&
  reference.savedPlaceRef === expected.savedPlaceRef &&
  reference.provider === expected.provider &&
  reference.recordRef === expected.recordRef;

const currentNow = (clock: SavedReferenceRefreshDependencies['clock']): string => {
  let value: string;
  try {
    value = clock?.() ?? new Date().toISOString();
  } catch {
    return internal();
  }
  const parsed = v.safeParse(IsoTimestampSchema, value);
  return parsed.success && Number.isFinite(Date.parse(value)) ? value : internal();
};

const requestStartNow = (context: HandlerContext): string => {
  const parsed = v.safeParse(IsoTimestampSchema, context.serverNow);
  return parsed.success && Number.isFinite(Date.parse(context.serverNow))
    ? context.serverNow
    : internal();
};

export const createSavedReferenceRefreshHandler = (
  dependencies: SavedReferenceRefreshDependencies,
): {
  readonly handle: (
    operation: SavedReferenceRefreshOperation,
    context: HandlerContext,
  ) => Promise<SavedReferenceRefreshResult>;
} => ({
  async handle(operation, context) {
    const timeoutMs = dependencies.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      return internal();
    }
    const controller = new AbortController();
    let timedOut = false;
    let cancelledByRequest = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = (): void => undefined;
    const work = async (signal: AbortSignal): Promise<SavedReferenceRefreshResult> => {
      // A Worker clock must never move before the request's admission timestamp.
      const policyNow = requestStartNow(context);
      let lastNowMs = Date.parse(policyNow);
      const readNow = (): string => {
        const value = currentNow(dependencies.clock);
        const valueMs = Date.parse(value);
        if (valueMs < lastNowMs) return internal();
        lastNowMs = valueMs;
        return value;
      };
      assertActive(context, signal);
      // The session anchor belongs to request admission; a slow owner/provider read
      // must not move it into the next 05:00 window.
      const rpc = createOwnerSavedReferenceRpc(dependencies.namespace, context.ownerScopeRef);
      const reference = await readReference(
        rpc,
        operation.path.savedPlaceRef,
        context.ownerScopeRef,
        signal,
      );
      if (reference.provider !== GOOGLE_PLACES_PROVIDER) unavailable();
      assertActive(context, signal);

      let providerResponse: Awaited<ReturnType<GooglePlaceDetailsTransport['read']>>;
      let providerPromise: ReturnType<GooglePlaceDetailsTransport['read']>;
      try {
        providerPromise = dependencies.transport.read(
          { placeId: reference.recordRef, fields: ['identity'] },
          signal,
        );
        providerResponse = await awaitAbortable(providerPromise, signal);
      } catch (error: unknown) {
        if (error === REQUEST_ABORTED) throw error;
        if (error instanceof HttpBoundaryError) throw error;
        if (error instanceof GooglePlaceDetailsError) return providerFailure(error);
        return unavailable();
      }

      assertActive(context, signal);
      const afterRead = await readReference(
        rpc,
        operation.path.savedPlaceRef,
        context.ownerScopeRef,
        signal,
      );
      if (!sameReference(afterRead, reference)) notFound();
      assertActive(context, signal);
      const now = readNow();
      const response = publicResponseFor(
        providerResponse,
        reference,
        context,
        dependencies,
        operation.path.savedPlaceRef,
        now,
        policyNow,
      );
      const finalNow = readNow();
      assertPublicResponseUsableAt(response, finalNow, policyNow);
      assertActive(context, signal);
      return { kind: 'saved_reference_refresh', response };
    };
    const operationPromise = Promise.resolve().then(() => work(controller.signal));
    operationPromise.catch(() => undefined);
    try {
      return await new Promise<SavedReferenceRefreshResult>((resolve, reject) => {
        const onAbort = (): void => {
          cancelledByRequest = true;
          controller.abort();
          reject(REQUEST_CANCELLED);
        };
        removeAbort = (): void => context.signal.removeEventListener('abort', onAbort);
        if (context.signal.aborted) {
          onAbort();
          return;
        }
        context.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(REQUEST_TIMEOUT);
        }, timeoutMs);
        operationPromise.then(resolve, reject);
      }).catch((error: unknown) => {
        if (error === REQUEST_CANCELLED || cancelledByRequest) return cancelled();
        if (error === REQUEST_TIMEOUT || timedOut)
          throw new HttpBoundaryError({ status: 504, code: 'TIMEOUT' });
        throw error;
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort();
    }
  },
});

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

const providerIsConfigured = (environment: SavedReferenceRefreshEnvironment): boolean => {
  const flags = resolveOperationalFlags(environment);
  const apiKey = environment.GOOGLE_PLACES_API_KEY?.trim();
  return operationalFlagEnabled(flags, 'places') && apiKey !== undefined && apiKey.length > 0;
};

/** Production composition remains unavailable until a verified display policy is explicitly supplied. */
export const createConfiguredSavedReferenceRefresh = (
  environment: SavedReferenceRefreshEnvironment,
  options: SavedReferenceRefreshBootstrapOptions,
): ReturnType<typeof createSavedReferenceRefreshHandler> | undefined => {
  const flags = resolveOperationalFlags(environment);
  if (
    environment.SAVED_REFERENCES === undefined ||
    !providerIsConfigured(environment) ||
    options.retentionFor === undefined ||
    (flags.mode === 'fixture' && options.transport === undefined && options.fetcher === undefined)
  ) {
    return undefined;
  }
  const apiKey = environment.GOOGLE_PLACES_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  const transport =
    options.transport ??
    createGooglePlaceDetailsTransport({
      apiKey,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    });
  return createSavedReferenceRefreshHandler({
    namespace: environment.SAVED_REFERENCES,
    transport,
    retentionFor: options.retentionFor,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.candidateIdFactory === undefined
      ? {}
      : { candidateIdFactory: options.candidateIdFactory }),
    ...(options.evidenceIdFactory === undefined
      ? {}
      : { evidenceIdFactory: options.evidenceIdFactory }),
  });
};
