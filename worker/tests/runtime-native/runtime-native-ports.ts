import * as v from 'valibot';
import {
  CandidateObservationRegistry,
  ObservationSchema,
  OpeningHoursSchema,
  PlaceIdentitySchema,
  type CandidateId,
  type CandidateRegistration,
  type CommitHashPort,
  type CommitPort,
  type CommitPortResult,
  type CommitRequest,
  type FieldResult,
  type GetPlaceDetailsInput,
  type GetPlaceDetailsOutput,
  type HarnessContext,
  type Observation,
  type PlaceDetailsPort,
  type PlaceSearchPort,
  type RegistryIdPort,
  type RegistryJsonValue,
  type RegistryScope,
  type Result,
  type SearchPlacesOutput,
  type SubmitCardsInput,
  type SubmitCardsPort,
  type SubmitCardsPortResult,
  type SubmitValidationContext,
  type ToolExecutionContext,
} from '@ima/core';
import type { RuntimeRetentionContext } from '@worker/infrastructure/runtime/retention/runtime-retention';

export const RUNTIME_NATIVE_NOW = '2026-09-10T12:00:00Z';
export const RUNTIME_NATIVE_OWNER = 'owner-runtime-native';

const retention = {
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-10T23:59:00Z',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
} as const;

type RuntimeNativeFixtureOptions = {
  readonly ownerScopeRef?: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly serverNow?: string;
};

type NativeObservationIds = {
  readonly identity: string;
  readonly opening: string;
};

class NativeIds implements RegistryIdPort {
  private candidate = 0;
  private observation = 0;
  private place = 0;

  nextCallId(): string {
    return 'runtime-native-call';
  }

  nextCandidateId(): CandidateId {
    this.candidate += 1;
    return `candidate-${this.candidate}`;
  }

  nextObservationId(): string {
    this.observation += 1;
    return `native-observation-${this.observation}`;
  }

  nextPlaceRef(): string {
    this.place += 1;
    return `native-place-${this.place}`;
  }

  nextResponseId(): string {
    return 'runtime-native-response';
  }
}

const error = <T>(message: string): Result<T> => ({
  status: 'error',
  error: {
    code: 'UPSTREAM_UNAVAILABLE',
    path: null,
    retryable: false,
    retryAfterMs: null,
    message,
    missingFields: [],
  },
});

const nativeContext = (
  scope: RegistryScope,
  turnId: string,
  revision: number,
  serverNow: string,
): HarnessContext => ({
  ...scope,
  turnId,
  revision,
  serverNow,
  location: {
    status: 'unavailable',
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision: 1,
  },
  preferences: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: 'runtime native fixture',
    budget: 'normal',
  },
  budget: {
    wallClockMs: 12_000,
    finalReserveMs: 2_000,
    modelCallsRemaining: 6,
    readCallsRemaining: 8,
    providerHttpRequestsRemaining: 20,
    retriesRemaining: 0,
  },
  capabilities: {
    version: 'runtime-native-v1',
    detailFields: ['identity', 'opening_hours', 'price'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['runtime-native'],
  },
});

const validationContext = (scope: RegistryScope, serverNow: string): SubmitValidationContext => ({
  scope,
  serverNow,
  departureAt: serverNow,
  expectedObservationContext: {
    ownerScopeRef: scope.ownerScopeRef,
    threadId: scope.threadId,
    capabilityVersion: 'runtime-native-v1',
    locationRevision: 1,
    originRef: null,
    homeStationRef: null,
    minimumStayMinutes: null,
    timeContext: 'now',
  },
  preferences: {
    maxWalkMinutes: null,
    homeStationRef: null,
    minimumStayMinutes: null,
  },
  travel: [],
  requireLastOrderAtArrival: false,
});

const registerObservation = (
  registry: CandidateObservationRegistry,
  scope: RegistryScope,
  candidateId: CandidateId,
  field: string,
  value: RegistryJsonValue,
  context: SubmitValidationContext,
): string =>
  registry.registerObservation({
    scope,
    candidateId,
    field,
    value,
    basis: 'provider_reported',
    sourceUpdatedAt: null,
    freshUntil: '2026-09-10T18:00:00Z',
    expiresAt: '2026-09-10T20:00:00Z',
    context: context.expectedObservationContext,
    sources: [
      {
        provider: 'runtime-native-fixture',
        recordRef: `${candidateId}-${field}`,
        attribution: 'runtime native fixture',
        publicUrl: null,
      },
    ],
    retention,
  }).observationId;

const typedObservation = <T>(
  registry: CandidateObservationRegistry,
  scope: RegistryScope,
  observationId: string,
  schema: v.GenericSchema<unknown, T>,
): Observation<T> => {
  const stored = registry.readObservation(scope, observationId);
  if (stored === undefined) throw new Error('RUNTIME_NATIVE_OBSERVATION_MISSING');
  const parsed = v.safeParse(ObservationSchema(schema), stored);
  if (!parsed.success) throw new Error('RUNTIME_NATIVE_OBSERVATION_INVALID');
  return parsed.output;
};

const known = <T>(observation: Observation<T>): FieldResult<T> => ({
  status: 'known',
  observations: [observation],
});

const unknown = (): { readonly status: 'unknown'; readonly reason: string } => ({
  status: 'unknown',
  reason: 'runtime native fixture did not register this field',
});

const detailsFields = (
  request: GetPlaceDetailsInput['requests'][number],
  registry: CandidateObservationRegistry,
  scope: RegistryScope,
  ids: NativeObservationIds,
): GetPlaceDetailsOutput['items'][number]['fields'] => {
  const fields: GetPlaceDetailsOutput['items'][number]['fields'] = {};
  for (const field of request.fields) {
    if (field === 'identity') {
      fields.identity = known(typedObservation(registry, scope, ids.identity, PlaceIdentitySchema));
    } else if (field === 'opening_hours') {
      fields.opening_hours = known(
        typedObservation(registry, scope, ids.opening, OpeningHoursSchema),
      );
    } else if (field === 'price') {
      fields.price = unknown();
    } else if (field === 'photos') {
      fields.photos = unknown();
    } else if (field === 'contact') {
      fields.contact = unknown();
    } else if (field === 'facilities') {
      fields.facilities = unknown();
    } else if (field === 'walking_route') {
      fields.walking_route = unknown();
    } else {
      fields.last_train = unknown();
    }
  }
  return fields;
};

export class RuntimeNativeCommitPort implements CommitPort {
  readonly requests: CommitRequest[] = [];
  private revision: number;

  constructor(initialRevision: number) {
    this.revision = initialRevision;
  }

  commit(request: CommitRequest): CommitPortResult {
    const prior = this.requests.find(
      (candidate) =>
        candidate.record.scope.ownerScopeRef === request.record.scope.ownerScopeRef &&
        candidate.record.scope.threadId === request.record.scope.threadId &&
        candidate.record.idempotencyKey === request.record.idempotencyKey,
    );
    if (prior !== undefined) {
      if (
        prior.expectedRevision !== request.expectedRevision ||
        prior.record.payloadDigest !== request.record.payloadDigest
      ) {
        return {
          status: 'conflict',
          conflict: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'native fixture idempotency conflict',
          },
        };
      }
      return {
        status: 'committed',
        receipt: {
          responseId: prior.record.responseId,
          revision: prior.record.revision,
          payloadDigest: prior.record.payloadDigest,
          presentation: prior.record.presentation,
          replayed: true,
        },
      };
    }
    if (request.expectedRevision !== this.revision) {
      return {
        status: 'conflict',
        conflict: { code: 'STALE_REVISION', message: 'native fixture revision is stale' },
      };
    }
    this.requests.push(structuredClone(request));
    this.revision = request.record.revision;
    return {
      status: 'committed',
      receipt: {
        responseId: request.record.responseId,
        revision: request.record.revision,
        payloadDigest: request.record.payloadDigest,
        presentation: request.record.presentation,
        replayed: false,
      },
    };
  }
}

export class RuntimeNativeHashPort implements CommitHashPort {
  async digest(value: string): Promise<string> {
    const encoded = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}

export type RuntimeNativePortFixture = {
  readonly context: HarnessContext;
  readonly validationContext: SubmitValidationContext;
  readonly registry: CandidateObservationRegistry;
  readonly scope: RegistryScope;
  readonly turnId: string;
  readonly inputs: {
    readonly invalidSubmit: SubmitCardsInput;
    readonly details: GetPlaceDetailsInput;
    readonly validSubmit: SubmitCardsInput;
  };
  readonly observations: NativeObservationIds;
  readonly retention: RuntimeRetentionContext;
  readonly operations: string[];
  readonly ports: {
    readonly search: PlaceSearchPort;
    readonly details: PlaceDetailsPort;
    readonly submit: SubmitCardsPort;
  };
  readonly commit: RuntimeNativeCommitPort;
  readonly hashes: RuntimeNativeHashPort;
};

/** Worker-only fixture: all Core data enters through @ima/core's public package exports. */
export const createRuntimeNativePortFixture = (
  options: RuntimeNativeFixtureOptions,
): RuntimeNativePortFixture => {
  const ownerScopeRef = options.ownerScopeRef ?? RUNTIME_NATIVE_OWNER;
  const serverNow = options.serverNow ?? RUNTIME_NATIVE_NOW;
  const scope: RegistryScope = { ownerScopeRef, threadId: options.threadId };
  const context = nativeContext(scope, options.turnId, options.revision, serverNow);
  const submitContext = validationContext(scope, serverNow);
  const retentionContext: RuntimeRetentionContext = {
    ownerScopeRef,
    threadId: options.threadId,
    turnId: options.turnId,
    retention,
  };
  const ids = new NativeIds();
  const registry = new CandidateObservationRegistry({ now: () => serverNow }, ids);
  const candidate = registry.registerCandidate({
    ...scope,
    provider: 'runtime-native-fixture',
    recordRef: 'runtime-native-candidate-1',
    displayName: 'Runtime native candidate',
    status: 'operational',
  } satisfies CandidateRegistration);
  const identity = registerObservation(
    registry,
    scope,
    candidate.candidateId,
    'identity',
    {
      name: 'Runtime native candidate',
      area: 'Fixture area',
      address: null,
      category: 'cafe',
      stationName: null,
      accessText: null,
      businessStatus: 'operational',
      sourceUrl: null,
    },
    submitContext,
  );
  const opening = registerObservation(
    registry,
    scope,
    candidate.candidateId,
    'opening_hours',
    {
      timeZone: 'UTC',
      intervals: [{ startAt: '2026-09-10T09:00:00Z', endAt: '2026-09-10T18:00:00Z' }],
      weeklyText: ['09:00-18:00'],
      evaluatedAt: serverNow,
      listedOpenAtEvaluation: true,
      nextBoundaryAt: '2026-09-10T18:00:00Z',
      lastOrderAt: '2026-09-10T17:00:00Z',
      lastOrderRaw: '17:00',
    },
    submitContext,
  );
  const observations: NativeObservationIds = { identity, opening };
  const validSubmit: SubmitCardsInput = {
    message: [
      {
        text: 'Runtime native candidate is open now.',
        evidenceIds: [identity],
        basis: 'grounded',
      },
    ],
    hero: {
      candidateId: candidate.candidateId,
      evidenceIds: [identity, opening],
      why: {
        text: 'Identity and opening hours are registered.',
        evidenceIds: [identity, opening],
        basis: 'grounded',
      },
    },
    alts: [],
  };
  const invalidSubmit: SubmitCardsInput = {
    ...validSubmit,
    hero: { ...validSubmit.hero, evidenceIds: [identity] },
  };
  const details: GetPlaceDetailsInput = {
    requests: [{ candidateId: candidate.candidateId, fields: ['identity', 'opening_hours'] }],
    freshness: 'reuse_valid',
  };
  const operations: string[] = [];
  const ports = {
    search: {
      search: (): Promise<Result<SearchPlacesOutput>> => {
        operations.push('search_places');
        return Promise.resolve(error<SearchPlacesOutput>('native search is not scripted'));
      },
    } satisfies PlaceSearchPort,
    details: {
      read: (
        input: GetPlaceDetailsInput,
        _requestContext: HarnessContext,
        _execution: ToolExecutionContext,
      ): Promise<Result<GetPlaceDetailsOutput>> => {
        operations.push('get_place_details');
        return Promise.resolve({
          status: 'ok',
          data: {
            items: input.requests.map((request) => ({
              candidateId: request.candidateId,
              fields: detailsFields(request, registry, scope, observations),
            })),
          },
          warnings: [],
        });
      },
    } satisfies PlaceDetailsPort,
    submit: {
      submit: (
        _input: SubmitCardsInput,
        _execution: ToolExecutionContext,
      ): Promise<SubmitCardsPortResult> => {
        operations.push('submit_cards');
        return Promise.resolve({
          status: 'invalid',
          issues: [
            {
              code: 'INVALID_ARGUMENT',
              path: 'submit',
              message: 'native fixture submit adapter must be rebuilt by the composition',
              missingFields: [],
            },
          ],
          repairable: false,
          remainingRepairs: 0,
        });
      },
    } satisfies SubmitCardsPort,
  };
  return {
    context,
    validationContext: submitContext,
    registry,
    scope,
    turnId: options.turnId,
    inputs: { invalidSubmit, details, validSubmit },
    observations,
    retention: retentionContext,
    operations,
    ports,
    commit: new RuntimeNativeCommitPort(options.revision),
    hashes: new RuntimeNativeHashPort(),
  };
};
