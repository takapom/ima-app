import { describe, expect, it } from 'vitest';
import { CandidateObservationRegistry } from '@worker/application/candidate-registry/registry';
import type { ClockPort, RegistryIdPort } from '@worker/application/ports/context';
import type { ObservationContext, RegistryScope } from '@worker/domain/evidence/freshness';
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
  private observation = 0;

  nextCallId(): string {
    return 'call-1';
  }

  nextPlaceRef(): string {
    return 'place-1';
  }

  nextCandidateId(): string {
    return 'candidate-1';
  }

  nextObservationId(): string {
    this.observation += 1;
    return `observation-${this.observation}`;
  }

  nextResponseId(): string {
    return 'response-1';
  }
}

const scope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-1' };
const context: ObservationContext = {
  ...scope,
  capabilityVersion: 'places-v1',
  locationRevision: 1,
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

function candidate(overrides: Partial<CandidateRegistration> = {}): CandidateRegistration {
  return {
    ...scope,
    provider: 'fixture',
    recordRef: 'record-1',
    displayName: '店',
    status: 'operational',
    ...overrides,
  };
}

function registration(
  candidateId: string,
  overrides: Partial<ObservationRegistration> = {},
): ObservationRegistration {
  return {
    scope,
    candidateId,
    field: 'identity',
    value: { name: '新しい店' },
    basis: 'provider_reported',
    sourceUpdatedAt: null,
    freshUntil: '2026-09-09T13:00:00Z',
    expiresAt: '2026-09-10T05:00:00+09:00',
    context,
    sources: [{ provider: 'fixture', recordRef: 'record-1', attribution: null, publicUrl: null }],
    retention,
    ...overrides,
  };
}

function createRegistry(): CandidateObservationRegistry {
  return new CandidateObservationRegistry(new FixedClock('2026-09-09T12:00:00Z'), new FixedIds());
}

function registerOriginal(registry: CandidateObservationRegistry) {
  const registered = registry.registerCandidate(candidate());
  const original = registry.registerObservation(
    registration(registered.candidateId, { value: { name: '元の店' } }),
  );
  return { candidateId: registered.candidateId, original };
}

function expectRegistryError(action: () => unknown, code: RegistryError['code']): void {
  let caught: unknown;
  try {
    action();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RegistryError);
  if (caught instanceof RegistryError) expect(caught.code).toBe(code);
}

function reuse(registry: CandidateObservationRegistry, candidateId: string) {
  return registry.evaluateObservationReuse({
    scope,
    candidateId,
    field: 'identity',
    context,
  });
}

describe('atomic observation replacement', () => {
  it('publishes the new observation before suppressing the old reuse anchor', () => {
    const registry = createRegistry();
    const { candidateId, original } = registerOriginal(registry);

    const replacement = registry.replaceObservation({
      registration: registration(candidateId, { value: { name: '合成後の店' } }),
      expectedObservationId: original.observationId,
    });

    expect(replacement.observationId).not.toBe(original.observationId);
    expect(registry.readObservation(scope, original.observationId)).toEqual(original);
    expect(reuse(registry, candidateId)).toMatchObject({
      status: 'reusable',
      observation: replacement,
    });
    expect(
      registry.evaluateObservationReuse({
        scope,
        candidateId,
        field: 'identity',
        context,
        observationId: original.observationId,
      }),
    ).toEqual({ status: 'missing' });
  });

  it('keeps the old observation reusable when replacement registration fails', () => {
    const registry = createRegistry();
    const { candidateId, original } = registerOriginal(registry);
    const invalidRetention = { ...retention, freshUntil: '2026-09-09T14:00:00Z' };

    expectRegistryError(
      () =>
        registry.replaceObservation({
          registration: registration(candidateId, { retention: invalidRetention }),
          expectedObservationId: original.observationId,
        }),
      'INVALID_OBSERVATION',
    );

    expect(registry.listObservations(scope, candidateId)).toHaveLength(1);
    expect(reuse(registry, candidateId)).toMatchObject({
      status: 'reusable',
      observation: original,
    });
  });

  it('rejects anchors with a different scope, context, or field', () => {
    const registry = createRegistry();
    const { candidateId, original } = registerOriginal(registry);

    expectRegistryError(
      () =>
        registry.replaceObservation({
          registration: registration(candidateId, {
            scope: { ownerScopeRef: 'owner-2', threadId: scope.threadId },
          }),
          expectedObservationId: original.observationId,
        }),
      'OWNER_SCOPE_MISMATCH',
    );
    expectRegistryError(
      () =>
        registry.replaceObservation({
          registration: registration(candidateId, {
            context: { ...context, capabilityVersion: 'places-v2' },
          }),
          expectedObservationId: original.observationId,
        }),
      'INVALID_OBSERVATION',
    );
    expectRegistryError(
      () =>
        registry.replaceObservation({
          registration: registration(candidateId, { field: 'price' }),
          expectedObservationId: original.observationId,
        }),
      'INVALID_OBSERVATION',
    );
    expect(registry.listObservations(scope, candidateId)).toHaveLength(1);
  });

  it('rejects a blocked or already suppressed anchor without changing the graph', () => {
    const blockedRegistry = createRegistry();
    const blocked = registerOriginal(blockedRegistry);
    blockedRegistry.invalidateObservationReuse(scope, blocked.candidateId, 'identity');
    expectRegistryError(
      () =>
        blockedRegistry.replaceObservation({
          registration: registration(blocked.candidateId),
          expectedObservationId: blocked.original.observationId,
        }),
      'INVALID_OBSERVATION',
    );
    expect(blockedRegistry.listObservations(scope, blocked.candidateId)).toHaveLength(1);

    const suppressedRegistry = createRegistry();
    const suppressed = registerOriginal(suppressedRegistry);
    const published = suppressedRegistry.replaceObservation({
      registration: registration(suppressed.candidateId),
      expectedObservationId: suppressed.original.observationId,
    });
    expectRegistryError(
      () =>
        suppressedRegistry.replaceObservation({
          registration: registration(suppressed.candidateId, { value: { name: '不正な再置換' } }),
          expectedObservationId: suppressed.original.observationId,
        }),
      'INVALID_OBSERVATION',
    );
    expect(reuse(suppressedRegistry, suppressed.candidateId)).toMatchObject({
      status: 'reusable',
      observation: published,
    });
  });

  it('does not hide a third fresh conflicting observation', () => {
    const registry = createRegistry();
    const { candidateId, original } = registerOriginal(registry);
    registry.registerObservation(registration(candidateId, { value: { name: '別の観測' } }));

    expectRegistryError(
      () =>
        registry.replaceObservation({
          registration: registration(candidateId, { value: { name: '置換後' } }),
          expectedObservationId: original.observationId,
        }),
      'INVALID_OBSERVATION',
    );
    expect(reuse(registry, candidateId)).toMatchObject({ status: 'conflict' });
    expect(registry.listObservations(scope, candidateId)).toHaveLength(2);
  });

  it('rejects an expired anchor even when another fresh value exists', () => {
    const clock = new FixedClock('2026-09-09T12:00:00Z');
    const registry = new CandidateObservationRegistry(clock, new FixedIds());
    const registered = registry.registerCandidate(candidate());
    const original = registry.registerObservation(
      registration(registered.candidateId, { value: { name: '期限切れの店' } }),
    );
    clock.set('2026-09-09T13:30:00Z');
    const futureRetention: RetentionMetadata = {
      ...retention,
      freshUntil: '2026-09-09T14:00:00Z',
      displayUntil: '2026-09-09T14:00:00Z',
    };
    registry.registerObservation(
      registration(registered.candidateId, {
        value: { name: '新しい店' },
        freshUntil: '2026-09-09T14:00:00Z',
        retention: futureRetention,
      }),
    );

    expectRegistryError(
      () =>
        registry.replaceObservation({
          registration: registration(registered.candidateId, {
            value: { name: '危険な置換' },
            freshUntil: '2026-09-09T14:00:00Z',
            retention: futureRetention,
          }),
          expectedObservationId: original.observationId,
        }),
      'INVALID_OBSERVATION',
    );
    expect(reuse(registry, registered.candidateId)).toMatchObject({
      status: 'reusable',
      observation: { value: { name: '新しい店' } },
    });
    expect(registry.listObservations(scope, registered.candidateId)).toHaveLength(2);
  });

  it('replaces the current context without rejecting older refresh history', () => {
    const registry = createRegistry();
    const { candidateId, original } = registerOriginal(registry);
    const nextContext = { ...context, capabilityVersion: 'places-v2' };
    const current = registry.registerObservation(
      registration(candidateId, {
        context: nextContext,
        value: { name: '現行の店' },
      }),
    );

    const replacement = registry.replaceObservation({
      registration: registration(candidateId, {
        context: nextContext,
        value: { name: '現行の合成店' },
      }),
      expectedObservationId: current.observationId,
    });

    expect(replacement.observationId).not.toBe(current.observationId);
    expect(registry.readObservation(scope, original.observationId)).toEqual(original);
    expect(
      registry.evaluateObservationReuse({
        scope,
        candidateId,
        field: 'identity',
        context: nextContext,
      }),
    ).toMatchObject({ status: 'reusable', observation: replacement });
  });
});
