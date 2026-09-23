import { sessionExpiryAt } from '@worker/runtime/retention/session-expiry-policy';
export { sessionExpiryAt } from '@worker/runtime/retention/session-expiry-policy';
import * as v from 'valibot';
import type { ThreadTurnRequest } from '@ima/contracts';
import type {
  CapabilitySnapshot,
  ClockPort,
  ExecutionBudget,
  HarnessContext,
  RegistryIdPort,
} from '@worker/application/ports/context';
import type { CommitHashPort } from '@worker/application/ports/commit';
import type { ObservationRegistration } from '@worker/domain/candidates/registry';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import type { RegistryScope } from '@worker/domain/evidence/freshness';
import type { SubmitValidationContext } from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';
import { IsoTimestampSchema } from '@worker/domain/primitives';
import { RetentionMetadataSchema } from '@worker/domain/evidence/retention';
import { DEFAULT_RUNTIME_BUDGET } from '@worker/runtime/budget/runtime-budget';
import type { RuntimeRetentionContext } from '@worker/runtime/retention/runtime-retention';

const CURSOR_SECRET = 'PLACES_CURSOR_SECRET';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const productionSecret = (env: unknown, name: string): string | undefined => {
  const value = isRecord(env) ? env[name] : undefined;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
};

export const placesCursorSecret = (env: unknown): string | undefined =>
  productionSecret(env, CURSOR_SECRET);

export const productionClock = (): string => new Date().toISOString();

export const productionMonotonicNow = (): number => performance.now();

export type ProductionCapabilityOptions = {
  readonly placesEnabled: boolean;
};

export type ProductionRetentionSource = RetentionMetadata | (() => RetentionMetadata);

export type ProductionObservationPolicyInput = {
  readonly now: string;
  readonly observation: unknown;
};

export type ProductionObservationPolicyResult = Pick<
  ObservationRegistration,
  'freshUntil' | 'expiresAt' | 'retention'
>;

/** Provider payload is denied until an explicit, bounded policy is injected by the Host. */
export const denyByDefaultRetention = (serverNow: string) => ({
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: sessionExpiryAt(serverNow),
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only' as const,
  policyStatus: 'disabled_m35' as const,
  displayPolicyStatus: 'disabled_m35' as const,
});

const denyRetentionAt = (sessionExpiresAt: string): RetentionMetadata => ({
  ...denyByDefaultRetention(
    v.safeParse(IsoTimestampSchema, sessionExpiresAt).success
      ? sessionExpiresAt
      : '1970-01-01T00:00:00.000Z',
  ),
  sessionExpiresAt: v.safeParse(IsoTimestampSchema, sessionExpiresAt).success
    ? sessionExpiresAt
    : '1970-01-01T00:00:00.000Z',
});

const boundedTime = (value: string, cap: string): string =>
  Date.parse(value) <= Date.parse(cap) ? value : cap;

const boundedNullableTime = (value: string | null, cap: string): string | null =>
  value === null ? null : boundedTime(value, cap);

export const boundProductionRetention = (
  retention: RetentionMetadata,
  sessionExpiresAt: string,
): RetentionMetadata => {
  const parsedSession = v.safeParse(IsoTimestampSchema, sessionExpiresAt);
  if (!parsedSession.success) return denyRetentionAt(sessionExpiresAt);
  const bounded = {
    ...retention,
    sessionExpiresAt: boundedTime(retention.sessionExpiresAt, parsedSession.output),
    freshUntil: boundedNullableTime(retention.freshUntil, parsedSession.output),
    displayUntil: boundedNullableTime(retention.displayUntil, parsedSession.output),
    retentionUntil: boundedNullableTime(retention.retentionUntil, parsedSession.output),
    deletionScheduledAt: boundedNullableTime(retention.deletionScheduledAt, parsedSession.output),
  };
  const parsed = v.safeParse(RetentionMetadataSchema, bounded);
  return parsed.success ? parsed.output : denyRetentionAt(parsedSession.output);
};

export const defaultProductionObservationPolicy =
  (clock: () => string, fixedSessionExpiresAt?: string) =>
  (_input: ProductionObservationPolicyInput) => {
    const retention =
      fixedSessionExpiresAt === undefined
        ? denyByDefaultRetention(clock())
        : denyRetentionAt(fixedSessionExpiresAt);
    return {
      freshUntil: retention.sessionExpiresAt,
      expiresAt: retention.sessionExpiresAt,
      retention,
    };
  };

export const capProductionObservationPolicy =
  <Input extends ProductionObservationPolicyInput>(
    policy: (input: Input) => ProductionObservationPolicyResult | undefined,
    fixedSessionExpiresAt: string,
  ): ((input: Input) => ProductionObservationPolicyResult | undefined) =>
  (input) => {
    let result: ProductionObservationPolicyResult | undefined;
    try {
      result = policy(input);
    } catch {
      return undefined;
    }
    if (result === undefined) return undefined;
    const parsedFresh = v.safeParse(IsoTimestampSchema, result.freshUntil);
    const parsedExpires = v.safeParse(IsoTimestampSchema, result.expiresAt);
    const parsedRetention = v.safeParse(RetentionMetadataSchema, result.retention);
    if (!parsedFresh.success || !parsedExpires.success || !parsedRetention.success)
      return undefined;
    const freshUntil = boundedTime(parsedFresh.output, fixedSessionExpiresAt);
    const expiresAt = boundedTime(parsedExpires.output, fixedSessionExpiresAt);
    if (Date.parse(freshUntil) > Date.parse(expiresAt)) return undefined;
    return {
      freshUntil,
      expiresAt,
      retention: boundProductionRetention(parsedRetention.output, fixedSessionExpiresAt),
    };
  };

export class ProductionIds implements RegistryIdPort {
  private readonly instanceId = crypto.randomUUID();
  private sequence = 0;

  private next(prefix: string): string {
    this.sequence += 1;
    return `runtime-${prefix}-${this.instanceId}-${this.sequence}`;
  }

  readonly nextCallId = (): string => this.next('call');

  readonly nextCandidateId = (): string => this.next('candidate');

  readonly nextObservationId = (): string => this.next('observation');

  readonly nextPlaceRef = (): string => this.next('place');

  readonly nextResponseId = (): string => this.next('response');

  readonly nextSearchId = (): string => this.next('search');

  readonly nextCardSetId = (): string => this.next('card-set');
}

export const productionBudget = (): ExecutionBudget => ({
  wallClockMs: DEFAULT_RUNTIME_BUDGET.wholeTurnMs,
  finalReserveMs: DEFAULT_RUNTIME_BUDGET.finalReserveMs,
  modelCallsRemaining: DEFAULT_RUNTIME_BUDGET.maxModelSteps,
  readCallsRemaining: DEFAULT_RUNTIME_BUDGET.maxReadCalls,
  providerHttpRequestsRemaining: DEFAULT_RUNTIME_BUDGET.maxProviderHttpRequests,
  retriesRemaining: DEFAULT_RUNTIME_BUDGET.maxReadRetries,
});

export const productionCapabilities = ({
  placesEnabled,
}: ProductionCapabilityOptions): CapabilitySnapshot => ({
  version: 'runtime-production-v1',
  detailFields: placesEnabled ? ['identity', 'opening_hours', 'price'] : [],
  supportedScopes: placesEnabled ? ['runtime-production'] : [],
});

export const productionRetentionFor = (
  source: ProductionRetentionSource | undefined,
  serverNow: string,
  fixedSessionExpiresAt?: string,
): RetentionMetadata => {
  let candidate: RetentionMetadata;
  try {
    candidate =
      source === undefined
        ? denyByDefaultRetention(serverNow)
        : typeof source === 'function'
          ? source()
          : source;
  } catch {
    return fixedSessionExpiresAt === undefined
      ? denyByDefaultRetention(serverNow)
      : denyRetentionAt(fixedSessionExpiresAt);
  }
  const parsed = v.safeParse(RetentionMetadataSchema, candidate);
  if (!parsed.success) {
    return fixedSessionExpiresAt === undefined
      ? denyByDefaultRetention(serverNow)
      : denyRetentionAt(fixedSessionExpiresAt);
  }
  return fixedSessionExpiresAt === undefined
    ? parsed.output
    : boundProductionRetention(parsed.output, fixedSessionExpiresAt);
};

/** Provider capability is a separate Host gate; retention controls each field's data use. */
export const productionPlacesEnabled = (options: {
  readonly prepareTurn?: unknown;
  /** Separate capability gate; retention policy controls data use, not tool availability. */
  readonly placesEnabled?: boolean;
}): boolean => {
  if (options.placesEnabled !== undefined) return options.placesEnabled;
  return options.prepareTurn !== undefined;
};

export type ProductionContextOptions = {
  readonly locationRevision?: number;
  readonly capabilities?: CapabilitySnapshot;
};

export const harnessContextFor = (
  request: {
    readonly ownerScopeRef: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly revision: number;
  },
  input: ThreadTurnRequest,
  serverNow: string,
  options: ProductionContextOptions = {},
): HarnessContext => {
  const coordinates =
    input.location.lat === null || input.location.lng === null
      ? null
      : { lat: input.location.lat, lng: input.location.lng };
  return {
    ownerScopeRef: request.ownerScopeRef,
    threadId: request.threadId,
    turnId: request.turnId,
    revision: request.revision,
    serverNow,
    location: {
      status: input.location.status,
      coordinates,
      accuracyMeters: input.location.accuracyMeters,
      precise: input.location.precise,
      capturedAt: input.location.capturedAt,
      revision: options.locationRevision ?? request.revision,
    },
    preferences: input.prefs,
    budget: productionBudget(),
    capabilities: options.capabilities ?? productionCapabilities({ placesEnabled: false }),
  };
};

export const validationContextFor = (
  context: HarnessContext,
  now: string,
): SubmitValidationContext => ({
  scope: { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
  serverNow: now,
  expectedObservationContext: {
    ownerScopeRef: context.ownerScopeRef,
    threadId: context.threadId,
    capabilityVersion: context.capabilities.version,
    locationRevision: context.location.revision,
    timeContext: 'now',
  },
  requireLastOrderAtArrival: false,
});

export const productionHash: CommitHashPort = {
  digest: async (value: string): Promise<string> => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  },
};

export const productionClockPort = (now: () => string): ClockPort => ({ now });

export const productionScopeFor = (context: HarnessContext): RegistryScope => ({
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
});

export type ProductionRetention = RuntimeRetentionContext['retention'];
