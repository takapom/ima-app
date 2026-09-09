import { describe, expect, it } from 'vitest';
import { CandidateFieldResultRegistry } from './field-results';
import { CandidateObservationRegistry } from './registry';
import { RegistryError } from '../domain/registry';
import type {
  CandidateRegistration,
  ObservationRegistration,
  RegistryJsonValue,
} from '../domain/registry';
import type { RegistryScope } from '../domain/freshness';
import type { ClockPort, RegistryIdPort } from '../ports/context';

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

const scope: RegistryScope = { ownerScopeRef: 'owner-1', threadId: 'thread-1' };
const context = {
  ...scope,
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

function candidate(recordRef: string): CandidateRegistration {
  return {
    ...scope,
    provider: 'fixture',
    recordRef,
    displayName: recordRef,
    status: 'operational',
  };
}

function observation(
  candidateId: string,
  field: string,
  value: RegistryJsonValue = { name: '正規値' },
): ObservationRegistration {
  return {
    scope,
    candidateId,
    field,
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

function createFixture(): {
  registry: CandidateObservationRegistry;
  fieldResults: CandidateFieldResultRegistry;
} {
  const registry = new CandidateObservationRegistry(new FixedClock(), new FixedIds());
  return { registry, fieldResults: new CandidateFieldResultRegistry(registry) };
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

describe('candidate field result registry', () => {
  it('keeps unknown, unsupported, not applicable, and error outcomes distinct', () => {
    const { registry, fieldResults } = createFixture();
    const registered = registry.registerCandidate(candidate('record-1'));
    fieldResults.registerFieldResult(scope, registered.candidateId, 'identity', {
      status: 'unknown',
      reason: 'provider omitted it',
    });
    fieldResults.registerFieldResult(scope, registered.candidateId, 'opening_hours', {
      status: 'unsupported',
      reason: 'capability is unavailable',
    });
    fieldResults.registerFieldResult(scope, registered.candidateId, 'price', {
      status: 'not_applicable',
      reason: 'free venue',
    });
    fieldResults.registerFieldResult(scope, registered.candidateId, 'photos', {
      status: 'error',
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        path: 'photos',
        retryable: true,
        retryAfterMs: 1000,
        message: 'fixture outage',
        missingFields: ['photos'],
      },
    });

    expect(fieldResults.listFieldResults(scope, registered.candidateId)).toHaveLength(4);
    expect(fieldResults.readFieldResult(scope, registered.candidateId, 'identity')?.result).toEqual(
      {
        status: 'unknown',
        reason: 'provider omitted it',
      },
    );
    expect(
      fieldResults.readFieldResult(scope, registered.candidateId, 'opening_hours')?.result,
    ).toEqual({
      status: 'unsupported',
      reason: 'capability is unavailable',
    });
    expect(fieldResults.readFieldResult(scope, registered.candidateId, 'price')?.result).toEqual({
      status: 'not_applicable',
      reason: 'free venue',
    });
    expect(
      fieldResults.readFieldResult(scope, registered.candidateId, 'photos')?.result,
    ).toMatchObject({
      status: 'error',
      error: { code: 'UPSTREAM_UNAVAILABLE', missingFields: ['photos'] },
    });
  });

  it('stores the registry snapshot and gates reuse on the latest result status', () => {
    const { registry, fieldResults } = createFixture();
    const registered = registry.registerCandidate(candidate('record-1'));
    const stored = registry.registerObservation(
      observation(registered.candidateId, 'identity', { name: '保存値' }),
    );
    const callerPayload = {
      ...stored,
      candidateId: registered.candidateId,
      value: { name: '入力値' },
    };
    fieldResults.registerFieldResult(scope, registered.candidateId, 'identity', {
      status: 'known',
      observations: [callerPayload],
    });
    expect(fieldResults.readFieldResult(scope, registered.candidateId, 'identity')?.result).toEqual(
      {
        status: 'known',
        observations: [stored],
      },
    );
    expect(
      registry.findReusableObservation({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
      }),
    ).toEqual(stored);
    expect(
      fieldResults.findReusableObservation(scope, registered.candidateId, 'identity', context),
    )?.toEqual(stored);

    fieldResults.registerFieldResult(scope, registered.candidateId, 'identity', {
      status: 'error',
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        path: 'identity',
        retryable: true,
        retryAfterMs: null,
        message: 'latest lookup failed',
        missingFields: ['identity'],
      },
    });
    expect(
      fieldResults.readFieldResult(scope, registered.candidateId, 'identity')?.result.status,
    ).toBe('error');
    expect(
      fieldResults.findReusableObservation(scope, registered.candidateId, 'identity', context),
    ).toBeUndefined();
    expect(
      registry.findReusableObservation({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
      }),
    ).toBeUndefined();
    expect(registry.readObservation(scope, stored.observationId)).toEqual(stored);
    expect(registry.listObservations(scope, registered.candidateId)).toHaveLength(1);
    expectRegistryError(
      () =>
        fieldResults.registerFieldResult(scope, registered.candidateId, 'identity', {
          status: 'known',
          observations: [callerPayload],
        }),
      'INVALID_OBSERVATION',
    );

    const refreshed = registry.registerObservation(
      observation(registered.candidateId, 'identity', { name: '再取得値' }),
    );
    fieldResults.registerFieldResult(scope, registered.candidateId, 'identity', {
      status: 'known',
      observations: [refreshed],
    });
    expect(
      registry.findReusableObservation({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
      }),
    ).toEqual(refreshed);
    expect(
      registry.evaluateObservationReuse({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
        observationId: stored.observationId,
      }),
    ).toEqual({ status: 'missing' });
    expect(
      registry.evaluateObservationReuse({
        scope,
        candidateId: registered.candidateId,
        field: 'identity',
        context,
        observationId: refreshed.observationId,
      }),
    ).toEqual({ status: 'reusable', observation: refreshed });
    expect(registry.listObservations(scope, registered.candidateId)).toHaveLength(2);
  });

  it('rejects a spoofed input observation whose registered ID belongs to another candidate or field', () => {
    const { registry, fieldResults } = createFixture();
    const first = registry.registerCandidate(candidate('record-1'));
    const second = registry.registerCandidate(candidate('record-2'));
    const stored = registry.registerObservation(
      observation(second.candidateId, 'opening_hours', { open: true }),
    );
    const spoofed = { ...stored, candidateId: first.candidateId, field: 'identity' };
    expectRegistryError(
      () =>
        fieldResults.registerFieldResult(scope, first.candidateId, 'identity', {
          status: 'known',
          observations: [spoofed],
        }),
      'INVALID_OBSERVATION',
    );
    expect(fieldResults.readFieldResult(scope, first.candidateId, 'identity')).toBeUndefined();
  });
});
