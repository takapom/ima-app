import { describe, expect, it } from 'vitest';
import { CandidateObservationRegistry } from './registry';
import type { ClockPort, RegistryIdPort } from '../ports/context';
import type { ObservationContext, RegistryScope } from '../domain/freshness';
import type {
  CandidateRegistration,
  ObservationRegistration,
  RegistryJsonValue,
} from '../domain/registry';

class FixedClock implements ClockPort {
  now(): string {
    return '2026-09-09T12:00:00Z';
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
}

const sourceScope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-1' };
const targetScope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-2' };
const context: ObservationContext = {
  ...sourceScope,
  capabilityVersion: 'places-v1',
  locationRevision: 1,
  originRef: null,
  homeStationRef: null,
  minimumStayMinutes: null,
  timeContext: 'now',
};
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

function candidate(): CandidateRegistration {
  return {
    ...sourceScope,
    provider: 'fixture',
    recordRef: 'record-1',
    displayName: '過去候補',
    status: 'operational',
  };
}

function observation(candidateId: string, value: RegistryJsonValue): ObservationRegistration {
  return {
    scope: sourceScope,
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

describe('candidate import continuity', () => {
  it('imports an unsaved same-owner candidate into another thread without observations', () => {
    const registry = new CandidateObservationRegistry(new FixedClock(), new FixedIds());
    const source = registry.registerCandidate(candidate());
    registry.registerObservation(observation(source.candidateId, { name: 'history' }));

    const details: Pick<CandidateRegistration, 'displayName' | 'status'> & {
      ownerScopeRef: string;
      provider: string;
      recordRef: string;
    } = {
      ownerScopeRef: 'owner-2',
      provider: 'attacker',
      recordRef: 'attacker-record',
      displayName: '再取得候補',
      status: 'temporarily_closed',
    };
    const imported = registry.importCandidate(
      sourceScope,
      targetScope,
      source.candidateId,
      details,
    );

    expect(imported).toBeDefined();
    if (imported === undefined) return;
    expect(imported.candidateId).not.toBe(source.candidateId);
    expect(imported.placeRef).toBe(source.placeRef);
    expect(imported.displayName).toBe('再取得候補');
    expect(imported.status).toBe('temporarily_closed');
    expect(imported.ownerScopeRef).toBe(targetScope.ownerScopeRef);
    expect(imported.provider).toBe(source.provider);
    expect(imported.recordRef).toBe(source.recordRef);
    expect(registry.listObservations(sourceScope, source.candidateId)).toHaveLength(1);
    expect(registry.listObservations(targetScope, imported.candidateId)).toHaveLength(0);
  });

  it('rejects a source or target owner mismatch without importing', () => {
    const registry = new CandidateObservationRegistry(new FixedClock(), new FixedIds());
    const source = registry.registerCandidate(candidate());

    expect(
      registry.importCandidate(
        { ownerScopeRef: 'owner-2', threadId: sourceScope.threadId },
        targetScope,
        source.candidateId,
        { displayName: '漏洩不可', status: 'operational' },
      ),
    ).toBeUndefined();
    expect(
      registry.importCandidate(
        sourceScope,
        { ownerScopeRef: 'owner-2', threadId: 'thread-2' },
        source.candidateId,
        { displayName: '漏洩不可', status: 'operational' },
      ),
    ).toBeUndefined();
  });
});
