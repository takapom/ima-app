import { describe, expect, it } from 'vitest';
import { CandidateObservationRegistry } from './registry';
import { SavedPlaceReferenceRegistry } from './saved-reference';
import type { RegistryScope } from '../domain/freshness';
import type { ObservationRegistration } from '../domain/registry';
import type { ClockPort, RegistryIdPort, SavedPlaceIdPort } from '../ports/context';

class FixedClock implements ClockPort {
  now(): string {
    return '2026-09-09T12:00:00Z';
  }
}

class FixedIds implements RegistryIdPort, SavedPlaceIdPort {
  private place = 0;
  private candidate = 0;
  private observation = 0;
  private saved = 0;

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
    this.saved += 1;
    return `saved-${this.saved}`;
  }
}

const firstScope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-1' };
const secondScope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-2' };
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

const observation = (candidateId: string, scope: RegistryScope): ObservationRegistration => ({
  scope,
  candidateId,
  field: 'identity',
  value: { name: '保存店' },
  basis: 'provider_reported',
  sourceUpdatedAt: null,
  freshUntil: '2026-09-09T13:00:00Z',
  expiresAt: '2026-09-10T05:00:00+09:00',
  context: {
    ...scope,
    capabilityVersion: 'places-v1',
    locationRevision: 1,
    originRef: null,
    homeStationRef: null,
    minimumStayMinutes: null,
    timeContext: 'now',
  },
  sources: [{ provider: 'fixture', recordRef: 'record-1', attribution: null, publicUrl: null }],
  retention,
});

function createFixture(): {
  registry: CandidateObservationRegistry;
  references: SavedPlaceReferenceRegistry;
} {
  const ids = new FixedIds();
  const registry = new CandidateObservationRegistry(new FixedClock(), ids);
  return { registry, references: new SavedPlaceReferenceRegistry(ids, registry) };
}

describe('saved place reference registry', () => {
  it('keeps only an owner-scoped provider reference and hides it from another owner', () => {
    const { references } = createFixture();
    const saved = references.registerSavedPlace({
      ownerScopeRef: firstScope.ownerScopeRef,
      provider: 'fixture',
      recordRef: 'record-1',
    });
    const repeated = references.registerSavedPlace({
      ownerScopeRef: firstScope.ownerScopeRef,
      provider: 'fixture',
      recordRef: 'record-1',
    });

    expect(repeated.savedPlaceRef).toBe(saved.savedPlaceRef);
    expect(Object.keys(saved)).toEqual(['ownerScopeRef', 'provider', 'recordRef', 'savedPlaceRef']);
    expect(references.readSavedPlace('owner-2', saved.savedPlaceRef)).toBeUndefined();
    expect(references.deleteSavedPlace('owner-2', saved.savedPlaceRef)).toBe(false);
    expect(
      references.importSavedPlace(
        { ownerScopeRef: 'owner-2', threadId: 'thread-1' },
        saved.savedPlaceRef,
        { displayName: '漏洩不可', status: 'operational' },
      ),
    ).toBeUndefined();
    expect(references.readSavedPlace('owner-1', saved.savedPlaceRef)).toEqual(saved);
  });

  it('requires explicit same-owner import and issues a new thread candidate without old observations', () => {
    const { registry, references } = createFixture();
    const saved = references.registerSavedPlace({
      ownerScopeRef: firstScope.ownerScopeRef,
      provider: 'fixture',
      recordRef: 'record-1',
    });
    const oldCandidate = registry.registerCandidate({
      ...firstScope,
      provider: 'fixture',
      recordRef: 'record-1',
      displayName: '旧表示名',
      status: 'operational',
    });
    registry.registerObservation(observation(oldCandidate.candidateId, firstScope));

    expect(registry.readCandidate(secondScope, oldCandidate.candidateId)).toBeUndefined();
    const imported = references.importSavedPlace(secondScope, saved.savedPlaceRef, {
      displayName: '再取得した表示名',
      status: 'operational',
    });
    expect(imported).toBeDefined();
    if (imported === undefined) return;
    expect(imported.candidateId).not.toBe(oldCandidate.candidateId);
    expect(imported.placeRef).toBe(oldCandidate.placeRef);
    expect(registry.listObservations(secondScope, imported.candidateId)).toHaveLength(0);
    expect(registry.listObservations(firstScope, oldCandidate.candidateId)).toHaveLength(1);
  });
});
