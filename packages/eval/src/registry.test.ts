import { describe, expect, it } from 'vitest';
import type {
  CandidateRegistration,
  ObservationContext,
  ObservationRegistration,
  RegistryScope,
  RetentionMetadata,
} from '@ima/core';
import { createRegistryFixture } from './registry-fixture';

const scope: RegistryScope = { ownerScopeRef: 'eval-owner', threadId: 'eval-thread' };
const context: ObservationContext = {
  ...scope,
  capabilityVersion: 'eval-v1',
  locationRevision: 1,
  originRef: 'eval-origin',
  homeStationRef: 'eval-station',
  minimumStayMinutes: 20,
  timeContext: 'now',
};
const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: '2026-09-09T13:00:00Z',
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: '2026-09-10T05:00:00+09:00',
  deletionScheduledAt: '2026-09-10T05:00:00+09:00',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

function registration(overrides: Partial<CandidateRegistration> = {}): CandidateRegistration {
  return {
    ...scope,
    provider: 'fixture',
    recordRef: 'record-1',
    displayName: '同名店',
    status: 'operational',
    ...overrides,
  };
}

function observation(
  candidateId: string,
  value: ObservationRegistration['value'],
): ObservationRegistration {
  return {
    scope,
    candidateId,
    field: 'identity',
    value,
    basis: 'provider_reported',
    sourceUpdatedAt: null,
    freshUntil: '2026-09-09T13:00:00Z',
    expiresAt: '2026-09-10T05:00:00+09:00',
    context,
    sources: [{ provider: 'fixture', recordRef: 'record-1', attribution: null, publicUrl: null }],
    retention,
  };
}

describe('Core registry evaluation fixtures', () => {
  it('keeps same-name records and providers separate', () => {
    const { registry } = createRegistryFixture();
    const first = registry.registerCandidate(registration());
    const second = registry.registerCandidate(registration({ recordRef: 'record-2' }));
    const third = registry.registerCandidate(registration({ provider: 'other-provider' }));

    expect(first.placeRef).not.toBe(second.placeRef);
    expect(first.placeRef).not.toBe(third.placeRef);
    expect(first.candidateId).not.toBe(second.candidateId);
    expect(first.displayName).toBe(second.displayName);
  });

  it('requires the owner and thread context for candidate and observation reads', () => {
    const { registry } = createRegistryFixture();
    const candidate = registry.registerCandidate(registration());
    const stored = registry.registerObservation(observation(candidate.candidateId, { name: '店' }));

    expect(
      registry.readCandidate(
        { ownerScopeRef: 'other-owner', threadId: scope.threadId },
        candidate.candidateId,
      ),
    ).toBeUndefined();
    expect(
      registry.readObservation(
        { ownerScopeRef: scope.ownerScopeRef, threadId: 'other-thread' },
        stored.observationId,
      ),
    ).toBeUndefined();
  });

  it('distinguishes an expired observation from a refreshed observation', () => {
    const { registry, clock } = createRegistryFixture();
    const candidate = registry.registerCandidate(registration());
    registry.registerObservation(observation(candidate.candidateId, { name: 'old' }));
    clock.set('2026-09-09T13:00:00Z');
    expect(
      registry.evaluateObservationReuse({
        scope,
        candidateId: candidate.candidateId,
        field: 'identity',
        context,
      }),
    ).toEqual({ status: 'expired' });

    clock.set('2026-09-09T13:01:00Z');
    const refreshedInput = observation(candidate.candidateId, { name: 'new' });
    const refreshed = registry.registerObservation({
      ...refreshedInput,
      freshUntil: '2026-09-09T14:00:00Z',
      retention: {
        ...refreshedInput.retention,
        freshUntil: '2026-09-09T14:00:00Z',
        displayUntil: '2026-09-09T14:00:00Z',
      },
    });
    const result = registry.evaluateObservationReuse({
      scope,
      candidateId: candidate.candidateId,
      field: 'identity',
      context,
    });
    expect(result.status).toBe('reusable');
    if (result.status === 'reusable')
      expect(result.observation.observationId).toBe(refreshed.observationId);
  });
});
