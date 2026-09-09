import { describe, expect, it } from 'vitest';
import {
  CandidateFieldResultRegistry,
  CardSetRegistry,
  SavedPlaceReferenceRegistry,
  type CandidateRegistration,
  type ObservationRegistration,
  type RegistryJsonValue,
  type RegistryScope,
} from '@ima/core';
import { createRegistryFixture } from './registry-fixture';

const firstScope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-1' };
const secondScope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-2' };

function candidate(scope: RegistryScope, recordRef: string): CandidateRegistration {
  return {
    ...scope,
    provider: 'fixture',
    recordRef,
    displayName: recordRef,
    status: 'operational',
  };
}

const context = {
  ...firstScope,
  capabilityVersion: 'places-v1',
  locationRevision: 1,
  originRef: null,
  homeStationRef: null,
  minimumStayMinutes: null,
  timeContext: 'now',
} as const;

const retention = {
  retentionDecision: 'allow' as const,
  retentionMode: 'provider_limited' as const,
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: '2026-09-09T13:00:00Z',
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: '2026-09-10T05:00:00+09:00',
  deletionScheduledAt: '2026-09-10T05:00:00+09:00',
  attribution: null,
  restoreMode: 'full' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};

function observation(candidateId: string, value: RegistryJsonValue): ObservationRegistration {
  return {
    scope: firstScope,
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

describe('M06 continuity scenarios', () => {
  it('imports a saved provider identity into a new thread with a new candidate ID', () => {
    const { registry, ids } = createRegistryFixture();
    const references = new SavedPlaceReferenceRegistry(ids, registry);
    const saved = references.registerSavedPlace({
      ownerScopeRef: firstScope.ownerScopeRef,
      provider: 'fixture',
      recordRef: 'record-1',
    });
    const oldCandidate = registry.registerCandidate(candidate(firstScope, 'record-1'));
    const imported = references.importSavedPlace(secondScope, saved.savedPlaceRef, {
      displayName: 'thread 2',
      status: 'operational',
    });

    expect(imported?.candidateId).toBeDefined();
    expect(imported?.candidateId).not.toBe(oldCandidate.candidateId);
    expect(imported?.placeRef).toBe(oldCandidate.placeRef);
    expect(registry.readCandidate(secondScope, oldCandidate.candidateId)).toBeUndefined();
    expect(references.readSavedPlace('owner-2', saved.savedPlaceRef)).toBeUndefined();
  });

  it('imports an unsaved past candidate only across same-owner threads', () => {
    const { registry } = createRegistryFixture();
    const source = registry.registerCandidate(candidate(firstScope, 'record-1'));
    registry.registerObservation(observation(source.candidateId, { name: 'history' }));
    const imported = registry.importCandidate(firstScope, secondScope, source.candidateId, {
      displayName: 'thread 2 refresh',
      status: 'operational',
    });

    expect(imported).toBeDefined();
    if (imported === undefined) return;
    expect(imported.candidateId).not.toBe(source.candidateId);
    expect(imported.placeRef).toBe(source.placeRef);
    expect(registry.listObservations(secondScope, imported.candidateId)).toHaveLength(0);
    expect(
      registry.importCandidate(
        { ownerScopeRef: 'owner-2', threadId: 'thread-1' },
        secondScope,
        source.candidateId,
        { displayName: 'denied', status: 'operational' },
      ),
    ).toBeUndefined();
  });

  it('keeps card order and propagates exclusion while field status gates reuse', () => {
    const { registry, ids } = createRegistryFixture();
    const first = registry.registerCandidate(candidate(firstScope, 'record-1'));
    const second = registry.registerCandidate(candidate(firstScope, 'record-2'));
    const cards = new CardSetRegistry(ids, registry);
    const cardSet = cards.createCardSet({
      scope: firstScope,
      responseId: 'response-1',
      candidateIds: [second.candidateId, first.candidateId],
    });
    expect(cardSet.entries.map((entry) => entry.candidateId)).toEqual([
      second.candidateId,
      first.candidateId,
    ]);
    cards.excludeCard(firstScope, cardSet.cardSetId, first.candidateId);
    expect(registry.readCandidate(firstScope, first.candidateId)?.excluded).toBe(true);

    const stored = registry.registerObservation(observation(second.candidateId, { name: 'saved' }));
    const fieldResults = new CandidateFieldResultRegistry(registry);
    fieldResults.registerFieldResult(firstScope, second.candidateId, 'identity', {
      status: 'known',
      observations: [stored],
    });
    expect(
      fieldResults.findReusableObservation(firstScope, second.candidateId, 'identity', context)
        ?.observationId,
    ).toBe(stored.observationId);
    fieldResults.registerFieldResult(firstScope, second.candidateId, 'identity', {
      status: 'error',
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        path: 'identity',
        retryable: true,
        retryAfterMs: null,
        message: 'latest request failed',
        missingFields: ['identity'],
      },
    });
    expect(
      fieldResults.findReusableObservation(firstScope, second.candidateId, 'identity', context),
    ).toBeUndefined();
  });
});
