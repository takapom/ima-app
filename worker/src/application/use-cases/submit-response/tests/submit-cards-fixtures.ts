import { CandidateObservationRegistry } from '@worker/application/candidate-registry/registry';
import type { ClockPort, RegistryIdPort } from '@worker/application/ports/context';
import type { CardSelection, SubmitCardsInput } from '@worker/application/ports/model';
import type { CandidateId, IsoTimestamp } from '@worker/domain/primitives';
import type { ObservationContext, RegistryScope } from '@worker/domain/evidence/freshness';
import type {
  ObservationRegistration,
  RegistryJsonValue,
} from '@worker/domain/candidates/registry';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import type { SubmitValidationContext } from '@worker/application/use-cases/submit-response/validation/submit-cards';

export const now = '2026-09-10T12:00:00Z';
export const scope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-1' };

class FixedClock implements ClockPort {
  constructor(private readonly value: string) {}

  now(): string {
    return this.value;
  }
}

class FixedIds implements RegistryIdPort {
  private place = 0;
  private candidate = 0;
  private observation = 0;

  nextCallId(): string {
    return 'call-1';
  }

  nextPlaceRef(): string {
    this.place += 1;
    return `place-${this.place}`;
  }

  nextCandidateId(): string {
    this.candidate += 1;
    return `candidate-${this.candidate}`;
  }

  nextObservationId(): string {
    this.observation += 1;
    return `observation-${this.observation}`;
  }

  nextResponseId(): string {
    return 'response-1';
  }

  nextSavedPlaceRef(): string {
    return 'saved-1';
  }

  nextCardSetId(): string {
    return 'card-set-1';
  }
}

export const retention: RetentionMetadata = {
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-10T23:00:00Z',
  freshUntil: '2026-09-10T13:00:00Z',
  displayUntil: '2026-09-10T22:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: { label: 'Fixture', sourceLink: null },
  restoreMode: 'reference_only',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

export type EvidenceIds = {
  identity: string;
  opening: string;
  price: string;
  photos: string;
};

type FixtureOptions = {
  requireLastOrderAtArrival?: boolean;
  lastOrderAt?: IsoTimestamp;
  openingStartAt?: IsoTimestamp;
  openingEndAt?: IsoTimestamp | null;
};

export type SubmitCardsFixture = {
  context: SubmitValidationContext;
  registry: CandidateObservationRegistry;
  ids: ReadonlyMap<CandidateId, EvidenceIds>;
};

export const makeContext = (options: FixtureOptions = {}): SubmitValidationContext => ({
  scope,
  serverNow: now,
  expectedObservationContext: {
    ownerScopeRef: scope.ownerScopeRef,
    threadId: scope.threadId,
    capabilityVersion: 'fixture-v1',
    locationRevision: 1,
    timeContext: 'now',
  },
  requireLastOrderAtArrival: options.requireLastOrderAtArrival ?? true,
});

const registerFixtureObservation = (
  registry: CandidateObservationRegistry,
  context: SubmitValidationContext,
  candidateId: CandidateId,
  field: string,
  value: RegistryJsonValue,
  observationContext: ObservationContext = context.expectedObservationContext,
): string => {
  const input: ObservationRegistration = {
    scope,
    candidateId,
    field,
    value,
    basis: 'provider_reported',
    sourceUpdatedAt: null,
    freshUntil: '2026-09-10T13:00:00Z',
    expiresAt: '2026-09-10T14:00:00Z',
    context: observationContext,
    sources: [
      {
        provider: 'fixture',
        recordRef: `source-${candidateId}-${field}`,
        attribution: 'Fixture',
        publicUrl: null,
      },
    ],
    retention,
  };
  return registry.registerObservation(input).observationId;
};

export const addObservation = (
  registry: CandidateObservationRegistry,
  context: SubmitValidationContext,
  candidateId: CandidateId,
  field: string,
  value: RegistryJsonValue,
  observationContext: ObservationContext = context.expectedObservationContext,
): string => {
  return registerFixtureObservation(
    registry,
    context,
    candidateId,
    field,
    value,
    observationContext,
  );
};

export const makeFixture = (
  candidateIds: readonly CandidateId[] = ['candidate-1'],
  options: FixtureOptions = {},
): SubmitCardsFixture => {
  const context = makeContext(options);
  const registry = new CandidateObservationRegistry(new FixedClock(now), new FixedIds());
  const ids = new Map<CandidateId, EvidenceIds>();
  for (const requestedCandidateId of candidateIds) {
    const candidate = registry.registerCandidate({
      ...scope,
      provider: 'fixture',
      recordRef: `record-${requestedCandidateId}`,
      displayName: `店 ${requestedCandidateId}`,
      status: 'operational',
    });
    const candidateId = candidate.candidateId;
    const identity = registerFixtureObservation(registry, context, candidateId, 'identity', {
      name: `店 ${candidateId}`,
      area: '恵比寿',
      address: null,
      category: 'cafe',
      stationName: null,
      accessText: null,
      businessStatus: 'operational',
      sourceUrl: null,
    });
    const opening = registerFixtureObservation(registry, context, candidateId, 'opening_hours', {
      timeZone: 'UTC',
      intervals: [
        {
          startAt: options.openingStartAt ?? '2026-09-10T11:00:00Z',
          endAt: options.openingEndAt === undefined ? '2026-09-10T15:00:00Z' : options.openingEndAt,
        },
      ],
      weeklyText: ['11:00-15:00'],
      evaluatedAt: now,
      listedOpenAtEvaluation: true,
      nextBoundaryAt: '2026-09-10T15:00:00Z',
      lastOrderAt: options.lastOrderAt ?? '2026-09-10T14:00:00Z',
      lastOrderRaw: '14:00',
    });
    const price = registerFixtureObservation(registry, context, candidateId, 'price', {
      level: 2,
      range: null,
      rawLabel: '¥¥',
    });
    const photos = registerFixtureObservation(registry, context, candidateId, 'photos', {
      photos: [{ photoRef: `photo-${candidateId}`, attributions: [], sourceUrl: null }],
    });
    ids.set(candidateId, { identity, opening, price, photos });
  }
  return { context, registry, ids };
};

export const makeSelection = (
  candidateId: CandidateId,
  ids: EvidenceIds,
  alternative = false,
): CardSelection => ({
  candidateId,
  evidenceIds: [ids.identity, ids.opening, ids.price, ids.photos],
  why: { text: `理由 ${candidateId}`, evidenceIds: [ids.identity], basis: 'grounded' },
  ...(alternative
    ? {
        diff: {
          text: `比較 ${candidateId}`,
          evidenceIds: [ids.identity],
          basis: 'grounded',
        },
      }
    : {}),
});

export const makeInput = (selections: readonly CardSelection[]): SubmitCardsInput => {
  const [hero, ...alts] = selections;
  if (hero === undefined) throw new Error('fixture requires a hero selection');
  return {
    message: [
      {
        text: '候補を提案します',
        evidenceIds: [hero.evidenceIds[0] ?? ''],
        basis: 'grounded',
      },
    ],
    hero,
    alts,
  };
};
