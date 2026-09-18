import type { Observation, OpeningHours, PlaceIdentity, RetentionMetadata } from '@ima/core';

const IDENTITY_RETENTION = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: '2026-09-09T12:00:00Z',
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: '2026-09-10T05:00:00+09:00',
  deletionScheduledAt: '2026-09-10T05:00:00+09:00',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
} satisfies RetentionMetadata;

const OPENING_HOURS_RETENTION = {
  retentionDecision: 'unknown',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: '2026-09-09T13:00:00Z',
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
} satisfies RetentionMetadata;

const identities = {
  'candidate-1': {
    name: 'Fixture candidate-1',
    area: 'Fixture area',
    address: null,
    category: 'cafe',
    stationName: null,
    accessText: null,
    businessStatus: 'operational',
    sourceUrl: 'https://fixture.example/places/candidate-1',
  },
  'candidate-2': {
    name: 'Fixture candidate-2',
    area: 'Fixture area',
    address: null,
    category: 'cafe',
    stationName: null,
    accessText: null,
    businessStatus: 'operational',
    sourceUrl: 'https://fixture.example/places/candidate-2',
  },
  'candidate-3': {
    name: 'Fixture candidate-3',
    area: 'Fixture area',
    address: null,
    category: 'cafe',
    stationName: null,
    accessText: null,
    businessStatus: 'operational',
    sourceUrl: 'https://fixture.example/places/candidate-3',
  },
} satisfies Record<string, PlaceIdentity>;

const openingHours = {
  timeZone: 'Asia/Tokyo',
  intervals: [
    {
      startAt: '2026-09-09T10:00:00+09:00',
      endAt: '2026-09-09T22:00:00+09:00',
    },
  ],
  weeklyText: ['fixture opening hours'],
  evaluatedAt: '2026-09-09T12:00:00+09:00',
  listedOpenAtEvaluation: true,
  nextBoundaryAt: '2026-09-09T22:00:00+09:00',
  lastOrderAt: null,
  lastOrderRaw: null,
} satisfies OpeningHours;

function source<T>(
  observationId: string,
  candidateId: string,
  field: string,
  value: T,
  retention: RetentionMetadata,
  recordRef: string,
): Observation<T> {
  return {
    observationId,
    candidateId,
    field,
    value,
    basis: 'provider_reported',
    fetchedAt: '2026-09-09T12:00:00Z',
    sourceUpdatedAt: null,
    expiresAt: '2026-09-09T13:00:00Z',
    contextKey: `runtime-gate:${field}`,
    sources: [
      {
        provider: 'fixture',
        recordRef,
        attribution: null,
        publicUrl: null,
      },
    ],
    retention,
  };
}

export type RuntimeGateObservation = Observation<PlaceIdentity> | Observation<OpeningHours>;

const observations: Readonly<Record<string, RuntimeGateObservation>> = Object.freeze({
  'candidate-1:identity': source(
    'obs-identity-1',
    'candidate-1',
    'identity',
    identities['candidate-1'],
    IDENTITY_RETENTION,
    'identity-1',
  ),
  'candidate-1:opening_hours': source(
    'obs-opening-hours-1',
    'candidate-1',
    'opening_hours',
    openingHours,
    OPENING_HOURS_RETENTION,
    'opening-hours-1',
  ),
  'candidate-2:identity': source(
    'obs-identity-2',
    'candidate-2',
    'identity',
    identities['candidate-2'],
    IDENTITY_RETENTION,
    'identity-2',
  ),
  'candidate-2:opening_hours': source(
    'obs-opening-hours-2',
    'candidate-2',
    'opening_hours',
    openingHours,
    OPENING_HOURS_RETENTION,
    'opening-hours-2',
  ),
  'candidate-3:identity': source(
    'obs-identity-3',
    'candidate-3',
    'identity',
    identities['candidate-3'],
    IDENTITY_RETENTION,
    'identity-3',
  ),
  'candidate-3:opening_hours': source(
    'obs-opening-hours-3',
    'candidate-3',
    'opening_hours',
    openingHours,
    OPENING_HOURS_RETENTION,
    'opening-hours-3',
  ),
});

export function observationFor(candidateId: string, field: 'identity'): Observation<PlaceIdentity>;
export function observationFor(
  candidateId: string,
  field: 'opening_hours',
): Observation<OpeningHours>;
export function observationFor(
  candidateId: string,
  field: 'identity' | 'opening_hours',
): Observation<PlaceIdentity> | Observation<OpeningHours> {
  const value = observations[`${candidateId}:${field}`];
  if (!value) throw new Error(`RUNTIME_GATE_OBSERVATION_NOT_FOUND:${candidateId}:${field}`);
  return value;
}

export function identityObservationId(candidateId: string): string {
  return observationFor(candidateId, 'identity').observationId;
}

export const allObservations = Object.freeze(Object.values(observations));
export { IDENTITY_RETENTION, OPENING_HOURS_RETENTION, identities, openingHours };
