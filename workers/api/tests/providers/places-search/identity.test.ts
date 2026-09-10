import type {
  CancellationToken,
  CandidateObservationRegistryPort,
  ClockPort,
  HarnessContext,
  RegistryIdPort,
  ToolExecutionContext,
} from '@ima/core';
import { CandidateObservationRegistry } from '@ima/core';
import { describe, expect, it } from 'vitest';
import { createPlacesSearchAdapter } from '../../../src/providers/places-search/adapter';
import { createPlacesSearchRegistration } from '../../../src/providers/places-search/registration';
import { createGoogleTextSearchTransport } from '../../../src/providers/places-search/transport';

const NOW = '2026-09-10T02:00:00.000Z';
const SCOPE = { ownerScopeRef: 'owner-same-name', threadId: 'thread-same-name' } as const;

class FixtureClock implements ClockPort {
  now(): string {
    return NOW;
  }
}

class FixtureIds implements RegistryIdPort {
  private candidate = 0;
  private observation = 0;
  private place = 0;

  nextCallId(): string {
    return 'call-generated';
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
    return 'response-generated';
  }

  nextPlaceRef(): string {
    this.place += 1;
    return `place-${this.place}`;
  }
}

const context: HarnessContext = {
  threadId: SCOPE.threadId,
  turnId: 'turn-same-name',
  revision: 1,
  serverNow: NOW,
  ownerScopeRef: SCOPE.ownerScopeRef,
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
    budget: 'any',
  },
  budget: {
    wallClockMs: 5_000,
    finalReserveMs: 500,
    modelCallsRemaining: 1,
    readCallsRemaining: 2,
    providerHttpRequestsRemaining: 2,
    retriesRemaining: 0,
  },
  capabilities: {
    version: 'places-search-v1',
    detailFields: ['identity'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['thread'],
  },
};

const execution: ToolExecutionContext = {
  callId: 'call-same-name',
  operation: 'search_places',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

const request = {
  mode: 'search' as const,
  query: 'カフェ',
  area: { kind: 'named_area' as const, name: '渋谷' },
  openNow: false,
  limit: 2,
  excludeCandidateIds: [],
};

const retention = {
  retentionDecision: 'allow' as const,
  retentionMode: 'provider_limited' as const,
  sessionExpiresAt: '2026-09-11T00:00:00.000Z',
  freshUntil: '2026-09-10T12:00:00.000Z',
  displayUntil: '2026-09-10T18:00:00.000Z',
  retentionUntil: '2026-09-10T23:00:00.000Z',
  deletionScheduledAt: '2026-09-10T23:00:00.000Z',
  attribution: { label: 'Google Places', sourceLink: 'https://maps.google.com' },
  restoreMode: 'full' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};

const place = (recordRef: string): Record<string, unknown> => ({
  id: recordRef,
  displayName: { text: '同名カフェ' },
  formattedAddress: '東京都渋谷区',
  primaryType: 'cafe',
  businessStatus: 'OPERATIONAL',
  googleMapsUri: `https://maps.google.com/?cid=${recordRef}`,
  priceLevel: 'PRICE_LEVEL_MODERATE',
  attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
});

const makeFixture = () => {
  const clock = new FixtureClock();
  const registry: CandidateObservationRegistryPort = new CandidateObservationRegistry(
    clock,
    new FixtureIds(),
  );
  let page = 0;
  let search = 0;
  let calls = 0;
  const fetcher: typeof fetch = (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('search request body is not JSON');
    calls += 1;
    const places = page === 0 ? [place('google-a'), place('google-b')] : [place('google-a')];
    page += 1;
    return Promise.resolve(new Response(JSON.stringify({ places })));
  };
  const registration = createPlacesSearchRegistration({
    registry,
    clock,
    observationPolicy: () => ({
      freshUntil: retention.freshUntil,
      expiresAt: retention.retentionUntil,
      retention,
    }),
  });
  const adapter = createPlacesSearchAdapter({
    transport: createGoogleTextSearchTransport({ apiKey: 'test-key', fetcher }),
    continuation: {
      issue: () => Promise.resolve('cursor-same-name'),
      resolve: () => Promise.resolve({ ok: false, code: 'INVALID_CURSOR' as const }),
    },
    registration,
    nextSearchId: () => {
      search += 1;
      return `search-same-name-${search}`;
    },
    clock: () => NOW,
    normalizeOpeningHours: () => ({ status: 'unknown', reason: 'not supplied by fixture' }),
  });
  return { adapter, registry, calls: () => calls };
};

const cancellation: CancellationToken = { isCancelled: () => false };

describe('Places search identity contract', () => {
  it('uses the real registry key for same-name separation and same-record reuse', async () => {
    const fixture = makeFixture();
    const first = await fixture.adapter.search(request, context, execution, cancellation);
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.data.candidates).toHaveLength(2);
    expect(first.data.candidates[0]?.candidateId).not.toBe(first.data.candidates[1]?.candidateId);
    expect(
      fixture.registry
        .listCandidates(SCOPE)
        .map(({ recordRef, displayName }) => [recordRef, displayName]),
    ).toEqual([
      ['google-a', '同名カフェ'],
      ['google-b', '同名カフェ'],
    ]);

    const second = await fixture.adapter.search(request, context, execution, cancellation);
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    expect(second.data.candidates[0]?.candidateId).toBe(first.data.candidates[0]?.candidateId);
    expect(fixture.registry.listCandidates(SCOPE)).toHaveLength(2);
    expect(fixture.calls()).toBe(2);
  });
});
