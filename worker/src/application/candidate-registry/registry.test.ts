import { describe, expect, it } from 'vitest';
import { CandidateObservationRegistry } from '@worker/application/candidate-registry/registry';
import type { ClockPort, RegistryIdPort } from '@worker/application/ports/context';
import {
  contextKeyForObservation,
  type ObservationContext,
  type RegistryScope,
} from '@worker/domain/evidence/freshness';
import {
  RegistryError,
  type CandidateRegistration,
  type ObservationRegistration,
} from '@worker/domain/candidates/registry';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';

class FixedClock implements ClockPort {
  constructor(private value: string) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

class FixedIds implements RegistryIdPort {
  private call = 0;
  private place = 0;
  private candidate = 0;
  private observation = 0;
  private response = 0;

  nextCallId(): string {
    this.call += 1;
    return `call-${this.call}`;
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
    this.response += 1;
    return `response-${this.response}`;
  }
}

class FailingCandidateIds extends FixedIds {
  private fail = true;

  override nextCandidateId(): string {
    if (this.fail) {
      this.fail = false;
      return 'invalid/candidate';
    }
    return super.nextCandidateId();
  }
}

class DuplicateObservationIds extends FixedIds {
  override nextObservationId(): string {
    return 'observation-1';
  }
}

const scope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-1' };
const context: ObservationContext = {
  ...scope,
  capabilityVersion: 'places-v1',
  locationRevision: 3,
  originRef: 'origin-1',
  homeStationRef: 'station-1',
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
const unknownRetentionWithoutFreshness: RetentionMetadata = {
  retentionDecision: 'unknown',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
};

function candidate(overrides: Partial<CandidateRegistration> = {}): CandidateRegistration {
  return {
    ...scope,
    provider: 'fixture',
    recordRef: 'record-1',
    displayName: '同名店',
    status: 'operational',
    ...overrides,
  };
}

function observation(value: ObservationRegistration['value']): ObservationRegistration {
  return {
    scope,
    candidateId: 'candidate-1',
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

function createRegistry(clock = new FixedClock('2026-09-09T12:00:00Z')): {
  registry: CandidateObservationRegistry;
  clock: FixedClock;
} {
  return { registry: new CandidateObservationRegistry(clock, new FixedIds()), clock };
}

function expectRegistryError(action: () => unknown, code: RegistryError['code']): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RegistryError);
  if (error instanceof RegistryError) expect(error.code).toBe(code);
}

function registerObservationAtRuntime(
  registry: CandidateObservationRegistry,
  input: unknown,
): unknown {
  const registerObservation = registry.registerObservation.bind(registry);
  return Reflect.apply(registerObservation, undefined, [input]);
}

describe('candidate and observation registry', () => {
  it('keeps provider record identity separate from names and scopes candidates by thread', () => {
    const { registry } = createRegistry();
    const first = registry.registerCandidate(candidate());
    const repeated = registry.registerCandidate(candidate({ status: 'temporarily_closed' }));
    const otherThread = registry.registerCandidate(
      candidate({ threadId: 'thread-2', status: 'operational' }),
    );
    const otherRecord = registry.registerCandidate(candidate({ recordRef: 'record-2' }));
    const otherProvider = registry.registerCandidate(candidate({ provider: 'other-provider' }));

    expect(repeated.candidateId).toBe(first.candidateId);
    expect(repeated.placeRef).toBe(first.placeRef);
    expect(repeated.status).toBe('temporarily_closed');
    expect(otherThread.candidateId).not.toBe(first.candidateId);
    expect(otherThread.placeRef).toBe(first.placeRef);
    expect(otherRecord.placeRef).not.toBe(first.placeRef);
    expect(otherProvider.placeRef).not.toBe(first.placeRef);
    expect(registry.readCandidate({ ...scope, ownerScopeRef: 'owner-2' }, first.candidateId)).toBe(
      undefined,
    );

    const excluded = registry.excludeCandidate(scope, first.candidateId);
    expect(excluded.excluded).toBe(true);
    expect(registry.readCandidate(scope, first.candidateId)?.excluded).toBe(true);
  });

  it('stores an immutable independent observation snapshot and issues a new ID on refresh', () => {
    const { registry, clock } = createRegistry();
    const registered = registry.registerCandidate(candidate());
    const inputValue = { name: '旧名称', nested: { source: 'fixture' } };
    const first = registry.registerObservation({
      ...observation(inputValue),
      candidateId: registered.candidateId,
    });
    inputValue.name = '呼出元で変更';
    inputValue.nested.source = '呼出元で変更';

    expect(first.value).toEqual({ name: '旧名称', nested: { source: 'fixture' } });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(first.context)).toBe(true);

    clock.set('2026-09-09T12:30:00Z');
    const refreshedInput = observation({ name: '新名称' });
    expectRegistryError(
      () =>
        registry.registerObservation({
          ...refreshedInput,
          candidateId: registered.candidateId,
          freshUntil: '2026-09-09T14:00:00Z',
        }),
      'INVALID_OBSERVATION',
    );
    const refreshed = registry.registerObservation({
      ...refreshedInput,
      candidateId: registered.candidateId,
      freshUntil: '2026-09-09T14:00:00Z',
      retention: {
        ...refreshedInput.retention,
        freshUntil: '2026-09-09T14:00:00Z',
        displayUntil: '2026-09-09T14:00:00Z',
      },
    });
    expect(refreshed.observationId).not.toBe(first.observationId);
    expect(registry.listObservations(scope, registered.candidateId)).toHaveLength(2);
  });

  it('keeps local freshness when policy freshness is unknown', () => {
    const { registry, clock } = createRegistry();
    const registered = registry.registerCandidate(candidate());
    registry.registerObservation({
      ...observation({ name: '参照のみ' }),
      candidateId: registered.candidateId,
      retention: unknownRetentionWithoutFreshness,
    });

    expect(
      registry.evaluateObservationReuse({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
      }).status,
    ).toBe('reusable');
    clock.set('2026-09-09T13:00:00Z');
    expect(
      registry.evaluateObservationReuse({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
      }),
    ).toEqual({ status: 'expired' });
  });

  it('rejects non-JSON values before allocating an observation ID', () => {
    const { registry } = createRegistry();
    const registered = registry.registerCandidate(candidate());
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const invalidValues: readonly unknown[] = [
      new Date('2026-09-09T12:00:00Z'),
      new Map([['name', '店']]),
      BigInt(1),
      circular,
    ];

    for (const value of invalidValues) {
      const input = { ...observation({ valid: true }), candidateId: registered.candidateId, value };
      expectRegistryError(
        () => registerObservationAtRuntime(registry, input),
        'INVALID_OBSERVATION',
      );
    }
    expect(registry.listObservations(scope, registered.candidateId)).toHaveLength(0);
  });

  it('does not retain a place index when candidate ID generation fails', () => {
    const clock = new FixedClock('2026-09-09T12:00:00Z');
    const registry = new CandidateObservationRegistry(clock, new FailingCandidateIds());
    expectRegistryError(() => registry.registerCandidate(candidate()), 'INVALID_ID');

    const retried = registry.registerCandidate(candidate());
    expect(retried.placeRef).toBe('place-2');
    expect(registry.listCandidates(scope)).toHaveLength(1);
  });

  it('rejects duplicate observation IDs without partial storage and preserves proto keys', () => {
    const clock = new FixedClock('2026-09-09T12:00:00Z');
    const registry = new CandidateObservationRegistry(clock, new DuplicateObservationIds());
    const registered = registry.registerCandidate(candidate());
    const firstValue: { name: string } = { name: 'A' };
    const secondValue: { name: string } = { name: 'B' };
    Object.defineProperty(firstValue, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 'first-proto',
      writable: true,
    });
    Object.defineProperty(secondValue, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 'second-proto',
      writable: true,
    });
    const firstInput = {
      ...observation({ valid: true }),
      candidateId: registered.candidateId,
      value: firstValue,
    };
    const secondInput = { ...firstInput, value: secondValue };

    registerObservationAtRuntime(registry, firstInput);
    expectRegistryError(() => registerObservationAtRuntime(registry, secondInput), 'DUPLICATE_ID');
    const [stored] = registry.listObservations(scope, registered.candidateId);
    expect(stored).toBeDefined();
    if (stored === undefined) return;
    expect(Object.getPrototypeOf(stored.value)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(stored.value, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(stored.value, '__proto__')?.value).toBe('first-proto');
    expect(
      registry.evaluateObservationReuse({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
      }),
    ).toMatchObject({ status: 'reusable' });

    const conflictRegistry = createRegistry().registry;
    conflictRegistry.registerCandidate(candidate());
    registerObservationAtRuntime(conflictRegistry, firstInput);
    registerObservationAtRuntime(conflictRegistry, secondInput);
    expect(
      conflictRegistry.evaluateObservationReuse({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
      }),
    ).toMatchObject({ status: 'conflict' });
  });

  it('reuses only fresh observations with the complete structured context', () => {
    const { registry, clock } = createRegistry();
    const registered = registry.registerCandidate(candidate());
    registry.registerObservation({
      ...observation({ name: '店' }),
      candidateId: registered.candidateId,
    });

    expect(
      registry.evaluateObservationReuse({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
      }),
    ).toMatchObject({ status: 'reusable' });

    clock.set('2026-09-09T13:00:00Z');
    expect(
      registry.evaluateObservationReuse({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
      }),
    ).toEqual({ status: 'expired' });

    const changedContexts: ObservationContext[] = [
      { ...context, capabilityVersion: 'places-v2' },
      { ...context, locationRevision: 4 },
      { ...context, originRef: 'origin-2' },
      { ...context, homeStationRef: 'station-2' },
      { ...context, minimumStayMinutes: 30 },
      { ...context, timeContext: 'service-date:2026-09-10' },
      { ...context, threadId: 'thread-2' },
      { ...context, ownerScopeRef: 'owner-2' },
    ];
    clock.set('2026-09-09T12:30:00Z');
    for (const changed of changedContexts) {
      expect(
        registry.evaluateObservationReuse({
          scope,
          candidateId: registered.candidateId,
          field: 'identity',
          context: changed,
        }),
      ).toEqual({ status: 'context_mismatch' });
    }
  });

  it('retains conflicting fresh observations instead of selecting or averaging them', () => {
    const { registry } = createRegistry();
    const registered = registry.registerCandidate(candidate());
    registry.registerObservation({
      ...observation({ name: '店A' }),
      candidateId: registered.candidateId,
    });
    registry.registerObservation({
      ...observation({ name: '店B' }),
      candidateId: registered.candidateId,
    });

    const result = registry.evaluateObservationReuse({
      scope,
      candidateId: registered.candidateId,
      field: 'identity',
      context,
    });
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') expect(result.observations).toHaveLength(2);
  });

  it('keeps context keys bounded for maximum identifiers and separator-like values', () => {
    const longScope: RegistryScope = {
      ownerScopeRef: `owner-${'x'.repeat(122)}`,
      threadId: `thread-${'y'.repeat(121)}`,
    };
    const longContext: ObservationContext = {
      ...longScope,
      capabilityVersion: `cap-${'z'.repeat(60)}`,
      locationRevision: 3,
      originRef: `origin-${'o'.repeat(121)}`,
      homeStationRef: `station-${'s'.repeat(120)}`,
      minimumStayMinutes: 20,
      timeContext: `time-${'日本語|%'.repeat(25)}`,
    };
    const { registry } = createRegistry();
    const registered = registry.registerCandidate({
      ...longScope,
      provider: 'fixture',
      recordRef: 'record-long',
      displayName: '長いIDの店',
      status: 'operational',
    });
    const key = contextKeyForObservation(longContext, 'field|%');
    const stored = registry.registerObservation({
      ...observation({ name: '長い文脈' }),
      scope: longScope,
      candidateId: registered.candidateId,
      field: 'field|%',
      context: longContext,
    });
    expect(key.length).toBeLessThanOrEqual(256);
    expect(stored.contextKey).toBe(key);
    expect(key).not.toBe(
      contextKeyForObservation({ ...longContext, locationRevision: 4 }, 'field|%'),
    );
  });
});
