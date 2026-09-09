import { describe, expect, it } from 'vitest';
import { CandidateObservationRegistry } from './registry';
import { CardSetRegistry } from './card-set';
import { CardSetError } from '../domain/continuity';
import type { CandidateRegistration } from '../domain/registry';
import type { RegistryScope } from '../domain/freshness';
import type { CardSetIdPort, ClockPort, RegistryIdPort } from '../ports/context';

class FixedClock implements ClockPort {
  now(): string {
    return '2026-09-09T12:00:00Z';
  }
}

class FixedIds implements RegistryIdPort, CardSetIdPort {
  private place = 0;
  private candidate = 0;
  private observation = 0;
  private cardSet = 0;

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

  nextCardSetId(): string {
    this.cardSet += 1;
    return `card-set-${this.cardSet}`;
  }
}

const scope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-1' };
const otherOwner: RegistryScope = { ownerScopeRef: 'owner-2', threadId: 'thread-1' };
const otherThread: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-2' };

function candidate(scopeValue: RegistryScope, recordRef: string): CandidateRegistration {
  return {
    ...scopeValue,
    provider: 'fixture',
    recordRef,
    displayName: recordRef,
    status: 'operational',
  };
}

function expectCardSetError(action: () => unknown, code: CardSetError['code']): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CardSetError);
  if (error instanceof CardSetError) expect(error.code).toBe(code);
}

function createFixture(): {
  registry: CandidateObservationRegistry;
  cardSets: CardSetRegistry;
} {
  const ids = new FixedIds();
  const registry = new CandidateObservationRegistry(new FixedClock(), ids);
  return { registry, cardSets: new CardSetRegistry(ids, registry) };
}

describe('card set registry', () => {
  it('preserves display order and owns selection/exclusion by thread', () => {
    const { registry, cardSets } = createFixture();
    const first = registry.registerCandidate(candidate(scope, 'record-1'));
    const second = registry.registerCandidate(candidate(scope, 'record-2'));
    const third = registry.registerCandidate(candidate(scope, 'record-3'));
    const cardSet = cardSets.createCardSet({
      scope,
      responseId: 'response-1',
      candidateIds: [third.candidateId, first.candidateId, second.candidateId],
    });
    const sharedCardSet = cardSets.createCardSet({
      scope,
      responseId: 'response-2',
      candidateIds: [first.candidateId, second.candidateId],
    });

    expect(
      cardSet.entries.map((entry) => [entry.candidateId, entry.displayOrder, entry.role]),
    ).toEqual([
      [third.candidateId, 0, 'hero'],
      [first.candidateId, 1, 'alt'],
      [second.candidateId, 2, 'alt'],
    ]);
    expect(Object.isFrozen(cardSet)).toBe(true);
    expect(Object.isFrozen(cardSet.entries)).toBe(true);

    const selected = cardSets.selectCard(scope, cardSet.cardSetId, first.candidateId);
    expect(selected.selectedCandidateId).toBe(first.candidateId);
    const excluded = cardSets.excludeCard(scope, cardSet.cardSetId, first.candidateId);
    expect(excluded.selectedCandidateId).toBeNull();
    expect(excluded.excludedCandidateIds).toEqual([first.candidateId]);
    expect(excluded.entries).toEqual(cardSet.entries);
    expect(registry.readCandidate(scope, first.candidateId)?.excluded).toBe(true);
    expect(cardSets.readCardSet(scope, cardSet.cardSetId)).toEqual(excluded);

    expectCardSetError(
      () => cardSets.selectCard(scope, cardSet.cardSetId, first.candidateId),
      'EXCLUDED_CANDIDATE',
    );
    expectCardSetError(
      () => cardSets.selectCard(otherOwner, cardSet.cardSetId, second.candidateId),
      'OWNER_SCOPE_MISMATCH',
    );
    expectCardSetError(
      () => cardSets.selectCard(otherThread, cardSet.cardSetId, second.candidateId),
      'THREAD_SCOPE_MISMATCH',
    );
    expectCardSetError(
      () => cardSets.selectCard(scope, sharedCardSet.cardSetId, first.candidateId),
      'EXCLUDED_CANDIDATE',
    );
    expectCardSetError(
      () =>
        cardSets.createCardSet({
          scope,
          responseId: 'response-3',
          candidateIds: [first.candidateId],
        }),
      'EXCLUDED_CANDIDATE',
    );
  });

  it('rejects excluded or unknown candidates before issuing a card set ID', () => {
    const { registry, cardSets } = createFixture();
    const excluded = registry.registerCandidate(candidate(scope, 'excluded'));
    registry.excludeCandidate(scope, excluded.candidateId);
    expectCardSetError(
      () =>
        cardSets.createCardSet({
          scope,
          responseId: 'response-1',
          candidateIds: [excluded.candidateId],
        }),
      'EXCLUDED_CANDIDATE',
    );
    expectCardSetError(
      () =>
        cardSets.createCardSet({
          scope,
          responseId: 'response-2',
          candidateIds: ['candidate-unknown'],
        }),
      'CANDIDATE_NOT_IN_SET',
    );
  });
});
