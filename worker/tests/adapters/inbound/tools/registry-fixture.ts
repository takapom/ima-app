import { CandidateObservationRegistry } from '@worker/application/candidate-registry/registry';
import type { CandidateRegistration } from '@worker/domain/candidates/registry';
import type { ClockPort, RegistryIdPort } from '@worker/application/ports/context';
import type { RegistryScope } from '@worker/domain/evidence/freshness';

export const toolScope: RegistryScope = {
  ownerScopeRef: 'owner-tools',
  threadId: 'thread-tools',
};

export const otherThreadScope: RegistryScope = {
  ownerScopeRef: toolScope.ownerScopeRef,
  threadId: 'thread-other',
};

export const otherOwnerScope: RegistryScope = {
  ownerScopeRef: 'owner-other',
  threadId: toolScope.threadId,
};

class FixtureClock implements ClockPort {
  now(): string {
    return '2026-09-10T00:00:00Z';
  }
}

class FixtureIds implements RegistryIdPort {
  private candidate = 0;
  private observation = 0;
  private place = 0;

  nextCallId(): string {
    return 'call-1';
  }

  nextCandidateId(): string {
    this.candidate += 1;
    return `candidate-${this.candidate}`;
  }

  nextObservationId(): string {
    this.observation += 1;
    return this.observation === 1 ? 'observation-safe' : `observation-${this.observation}`;
  }

  nextResponseId(): string {
    return 'response-1';
  }

  nextPlaceRef(): string {
    this.place += 1;
    return `place-${this.place}`;
  }
}

const candidate = (scope: RegistryScope, recordRef: string): CandidateRegistration => ({
  ...scope,
  provider: 'fixture',
  recordRef,
  displayName: recordRef,
  status: 'operational',
});

export type ToolRegistryFixture = {
  readonly registry: CandidateObservationRegistry;
  readonly currentCandidateId: string;
  readonly otherThreadCandidateId: string;
  readonly otherOwnerCandidateId: string;
};

export const createToolRegistry = (): ToolRegistryFixture => {
  const registry = new CandidateObservationRegistry(new FixtureClock(), new FixtureIds());
  const current = registry.registerCandidate(candidate(toolScope, 'current-record'));
  const otherThread = registry.registerCandidate(
    candidate(otherThreadScope, 'other-thread-record'),
  );
  const otherOwner = registry.registerCandidate(candidate(otherOwnerScope, 'other-owner-record'));
  return {
    registry,
    currentCandidateId: current.candidateId,
    otherThreadCandidateId: otherThread.candidateId,
    otherOwnerCandidateId: otherOwner.candidateId,
  };
};
