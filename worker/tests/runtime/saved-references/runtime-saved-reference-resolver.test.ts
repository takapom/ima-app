import { describe, expect, it, vi } from 'vitest';
import {
  CandidateObservationRegistry,
  type CandidateRegistration,
  type CancellationToken,
  type HarnessContext,
  type RegistryIdPort,
  type RegistryScope,
  type SavedPlaceReference,
  type ToolExecutionContext,
} from '@ima/core';
import {
  createSavedPlaceReferenceResolver,
  type SavedReferenceProviderRefreshRequest,
  type SavedReferenceResolverDependencies,
} from '@worker/runtime/saved-references/runtime-saved-reference-resolver';

const scope: RegistryScope = { ownerScopeRef: 'saved-owner', threadId: 'saved-thread' };
const reference: SavedPlaceReference = {
  savedPlaceRef: 'saved-place',
  ownerScopeRef: scope.ownerScopeRef,
  provider: 'fixture',
  recordRef: 'provider-place',
};

class TestIds implements RegistryIdPort {
  private candidate = 0;
  private place = 0;
  private observation = 0;

  nextCallId(): string {
    return 'call-1';
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

  nextPlaceRef(): string {
    this.place += 1;
    return `place-${this.place}`;
  }
}

const context: HarnessContext = {
  threadId: scope.threadId,
  turnId: 'saved-turn',
  revision: 2,
  serverNow: '2026-09-11T12:00:00.000Z',
  ownerScopeRef: scope.ownerScopeRef,
  location: {
    status: 'unavailable',
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision: 1,
  },
  preferences: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: null,
    budget: 'normal',
  },
  budget: {
    wallClockMs: 2_000,
    finalReserveMs: 250,
    modelCallsRemaining: 1,
    readCallsRemaining: 2,
    providerHttpRequestsRemaining: 1,
    retriesRemaining: 0,
  },
  capabilities: {
    version: 'saved-reference-test',
    detailFields: ['identity'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['saved-reference-test'],
  },
};

const execution: ToolExecutionContext = {
  callId: 'call-saved-reference',
  operation: 'get_place_details',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

const request = (cancellation: CancellationToken = { isCancelled: () => false }) => ({
  savedPlaceRef: reference.savedPlaceRef,
  fields: ['identity' as const],
  context,
  execution,
  cancellation,
});

const candidate = (input: SavedReferenceProviderRefreshRequest): CandidateRegistration => ({
  ownerScopeRef: input.scope.ownerScopeRef,
  threadId: input.scope.threadId,
  provider: input.reference.provider,
  recordRef: input.reference.recordRef,
  displayName: 'Fresh fixture place',
  status: 'operational',
});

const validOwner = () => ({ ok: true as const, reference });

const providerIssue = {
  code: 'UPSTREAM_UNAVAILABLE' as const,
  path: null,
  retryable: true,
  retryAfterMs: null,
  message: 'provider failed',
  missingFields: [],
};

const makeFixture = (
  overrides: Partial<{
    readonly ownerResult: unknown;
    readonly refreshResult: unknown;
    readonly now: () => string;
    readonly sessionExpiresAt: () => string | undefined;
    readonly reserveProviderRequest: () => boolean;
    readonly provider: (input: SavedReferenceProviderRefreshRequest) => Promise<unknown>;
  }> = {},
) => {
  const registry = new CandidateObservationRegistry(
    { now: () => '2026-09-11T12:00:00.000Z' },
    new TestIds(),
  );
  const ownerRead = vi.fn(() => Promise.resolve(overrides.ownerResult ?? validOwner()));
  const providerRefresh = vi.fn(
    overrides.provider ??
      ((input: SavedReferenceProviderRefreshRequest) =>
        Promise.resolve(
          overrides.refreshResult ?? { status: 'ok' as const, candidate: candidate(input) },
        )),
  );
  const dependencies: SavedReferenceResolverDependencies = {
    owner: { read: ownerRead },
    provider: { refresh: providerRefresh },
    registry,
    supportedProviders: ['fixture'],
    budget: {
      reserveProviderRequest: overrides.reserveProviderRequest ?? (() => true),
    },
    now: overrides.now ?? (() => '2026-09-11T12:00:00.000Z'),
    sessionExpiresAt: overrides.sessionExpiresAt ?? (() => '2026-09-11T13:00:00.000Z'),
  };
  return {
    registry,
    ownerRead,
    providerRefresh,
    resolve: createSavedPlaceReferenceResolver(dependencies),
  };
};

describe('saved reference owner/provider resolver', () => {
  it('refreshes before registering a current owner/thread candidate', async () => {
    const fixture = makeFixture();
    const result = await fixture.resolve(request());

    expect(result).toMatchObject({ status: 'ok' });
    expect(fixture.ownerRead).toHaveBeenCalledWith(reference.savedPlaceRef);
    expect(fixture.providerRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        savedPlaceRef: reference.savedPlaceRef,
        reference,
        scope,
        fields: ['identity'],
      }),
    );
    expect(fixture.ownerRead).toHaveBeenCalledTimes(2);
    expect(fixture.registry.listCandidates(scope)).toHaveLength(1);
    expect(fixture.registry.listCandidates(scope)[0]).toMatchObject({
      provider: reference.provider,
      recordRef: reference.recordRef,
      displayName: 'Fresh fixture place',
    });
  });

  it('does not leave a candidate when provider refresh fails', async () => {
    const fixture = makeFixture({ refreshResult: { status: 'error', error: providerIssue } });
    const result = await fixture.resolve(request());

    expect(result).toMatchObject({ status: 'error', error: { code: 'UPSTREAM_UNAVAILABLE' } });
    expect(fixture.registry.listCandidates(scope)).toEqual([]);
  });

  it('refreshes an existing non-excluded candidate instead of trusting stale registry data', async () => {
    const fixture = makeFixture();
    const existing = fixture.registry.registerCandidate({
      ...scope,
      provider: reference.provider,
      recordRef: reference.recordRef,
      displayName: 'Stale place',
      status: 'unknown',
    });

    const result = await fixture.resolve(request());
    expect(result).toEqual({ status: 'ok', candidateId: existing.candidateId });
    expect(fixture.providerRefresh).toHaveBeenCalledOnce();
    expect(fixture.registry.listCandidates(scope)[0]).toMatchObject({
      candidateId: existing.candidateId,
      displayName: 'Fresh fixture place',
      status: 'operational',
    });
  });

  it('rejects missing/deleted owner references before provider I/O', async () => {
    const fixture = makeFixture({ ownerResult: { ok: true, reference: null } });
    const result = await fixture.resolve(request());

    expect(result).toMatchObject({ status: 'error', error: { code: 'UNKNOWN_CANDIDATE' } });
    expect(fixture.providerRefresh).not.toHaveBeenCalled();
    expect(fixture.registry.listCandidates(scope)).toEqual([]);
  });

  it('rejects owner failures and malformed owner RPC output without leaking details', async () => {
    const ownerFailures = ['FORBIDDEN', 'OWNER_NOT_INITIALIZED', 'CORRUPT_ROW'] as const;
    for (const code of ownerFailures) {
      const fixture = makeFixture({ ownerResult: { ok: false, code } });
      const result = await fixture.resolve(request());
      expect(result).toMatchObject({ status: 'error' });
      expect(fixture.providerRefresh).not.toHaveBeenCalled();
    }

    const malformed = makeFixture({
      ownerResult: { ok: true, reference: { provider: 'raw-key' } },
    });
    const malformedResult = await malformed.resolve(request());
    expect(malformedResult).toMatchObject({ status: 'error', error: { code: 'SCHEMA_MISMATCH' } });
    expect(malformed.providerRefresh).not.toHaveBeenCalled();

    const wrongOwner = makeFixture({
      ownerResult: {
        ok: true,
        reference: { ...reference, ownerScopeRef: 'other-owner' },
      },
    });
    await expect(wrongOwner.resolve(request())).resolves.toMatchObject({
      status: 'error',
      error: { code: 'UNSUPPORTED_SCOPE' },
    });
    expect(wrongOwner.providerRefresh).not.toHaveBeenCalled();
  });

  it('rejects an unsupported provider before reserving or fetching', async () => {
    const unsupported = {
      ...reference,
      provider: 'unknown-provider',
    } satisfies SavedPlaceReference;
    const fixture = makeFixture({ ownerResult: { ok: true, reference: unsupported } });
    const reserve = vi.fn(() => true);
    const withBudget = makeFixture({
      ownerResult: { ok: true, reference: unsupported },
      reserveProviderRequest: reserve,
    });

    const result = await fixture.resolve(request());
    expect(result).toMatchObject({ status: 'error', error: { code: 'UNSUPPORTED_SCOPE' } });
    expect(fixture.providerRefresh).not.toHaveBeenCalled();

    await withBudget.resolve(request());
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects invalid provider output and mismatched identity without registering it', async () => {
    const malformed = makeFixture({
      refreshResult: { status: 'ok', candidate: { provider: 'fixture' } },
    });
    await expect(malformed.resolve(request())).resolves.toMatchObject({
      status: 'error',
      error: { code: 'SCHEMA_MISMATCH' },
    });
    expect(malformed.registry.listCandidates(scope)).toEqual([]);

    const wrongIdentity = makeFixture({
      refreshResult: {
        status: 'ok',
        candidate: {
          ...scope,
          provider: 'fixture',
          recordRef: 'another-place',
          displayName: 'Wrong place',
          status: 'operational',
        },
      },
    });
    await expect(wrongIdentity.resolve(request())).resolves.toMatchObject({
      status: 'error',
      error: { code: 'SCHEMA_MISMATCH' },
    });
    expect(wrongIdentity.registry.listCandidates(scope)).toEqual([]);
  });

  it('rejects an already excluded candidate before provider refresh', async () => {
    const fixture = makeFixture();
    const existing = fixture.registry.registerCandidate({
      ...scope,
      provider: reference.provider,
      recordRef: reference.recordRef,
      displayName: 'Old place',
      status: 'operational',
    });
    fixture.registry.excludeCandidate(scope, existing.candidateId);

    const result = await fixture.resolve(request());
    expect(result).toMatchObject({ status: 'error', error: { code: 'EXCLUDED_CANDIDATE' } });
    expect(fixture.providerRefresh).not.toHaveBeenCalled();
  });

  it('rechecks owner identity after provider refresh before registration', async () => {
    let reads = 0;
    const fixture = makeFixture();
    fixture.ownerRead.mockImplementation(() => {
      reads += 1;
      return Promise.resolve(reads === 1 ? validOwner() : { ok: true as const, reference: null });
    });

    const result = await fixture.resolve(request());
    expect(result).toMatchObject({ status: 'error', error: { code: 'UNKNOWN_CANDIDATE' } });
    expect(fixture.ownerRead).toHaveBeenCalledTimes(2);
    expect(fixture.registry.listCandidates(scope)).toEqual([]);
  });

  it('rechecks exclusion after a provider call that overlaps a state change', async () => {
    const fixture = makeFixture({
      provider: (input) => {
        const current = fixture.registry.registerCandidate(candidate(input));
        fixture.registry.excludeCandidate(scope, current.candidateId);
        return Promise.resolve({ status: 'ok' as const, candidate: candidate(input) });
      },
    });

    const result = await fixture.resolve(request());
    expect(result).toMatchObject({ status: 'error', error: { code: 'EXCLUDED_CANDIDATE' } });
    expect(fixture.registry.listCandidates(scope)[0]?.excluded).toBe(true);
  });

  it('enforces the provider budget before provider I/O', async () => {
    const reserve = vi.fn(() => false);
    const fixture = makeFixture({ reserveProviderRequest: reserve });
    const result = await fixture.resolve(request());

    expect(result).toMatchObject({ status: 'error', error: { code: 'BUDGET_EXCEEDED' } });
    expect(reserve).toHaveBeenCalledOnce();
    expect(fixture.providerRefresh).not.toHaveBeenCalled();
  });

  it('does not register after cancellation while owner/provider work is pending', async () => {
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((finish) => {
        resolve = finish;
      });
      return { promise, resolve };
    };

    let ownerCancelled = false;
    const ownerGate = deferred<ReturnType<typeof validOwner>>();
    const ownerPending = makeFixture();
    ownerPending.ownerRead.mockImplementation(() => ownerGate.promise);
    const ownerRequest = request({ isCancelled: () => ownerCancelled });
    const ownerOperation = ownerPending.resolve(ownerRequest);
    await Promise.resolve();
    ownerCancelled = true;
    ownerGate.resolve(validOwner());
    await expect(ownerOperation).resolves.toMatchObject({
      status: 'error',
      error: { code: 'CANCELLED' },
    });
    expect(ownerPending.providerRefresh).not.toHaveBeenCalled();

    let providerCancelled = false;
    const providerGate = deferred<unknown>();
    const providerPending = makeFixture({
      provider: async (input) => {
        const value = await providerGate.promise;
        return value ?? { status: 'ok' as const, candidate: candidate(input) };
      },
    });
    const providerOperation = providerPending.resolve({
      ...request({ isCancelled: () => providerCancelled }),
    });
    for (
      let index = 0;
      index < 5 && providerPending.providerRefresh.mock.calls.length === 0;
      index += 1
    ) {
      await Promise.resolve();
    }
    expect(providerPending.providerRefresh).toHaveBeenCalledOnce();
    providerCancelled = true;
    providerGate.resolve(undefined);
    await expect(providerOperation).resolves.toMatchObject({
      status: 'error',
      error: { code: 'CANCELLED' },
    });
    expect(providerPending.registry.listCandidates(scope)).toEqual([]);
  });

  it('rechecks the session deadline after provider refresh', async () => {
    let now = '2026-09-11T12:00:00.000Z';
    const fixture = makeFixture({
      now: () => now,
      provider: (input) => {
        now = '2026-09-11T13:00:00.000Z';
        return Promise.resolve({ status: 'ok' as const, candidate: candidate(input) });
      },
    });
    const result = await fixture.resolve(request());

    expect(result).toMatchObject({ status: 'error', error: { code: 'STALE_TURN' } });
    expect(fixture.registry.listCandidates(scope)).toEqual([]);
  });
});
