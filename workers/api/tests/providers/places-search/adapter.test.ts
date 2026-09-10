import { describe, expect, it } from 'vitest';
import type {
  CancellationToken,
  CandidateObservationRegistry,
  ClockPort,
  HarnessContext,
  RegistryIdPort,
  SearchPlacesInput,
  ToolExecutionContext,
} from '@ima/core';
import { CandidateObservationRegistry as Registry } from '@ima/core';
import { normalizeGoogleOpeningHours } from '../../../src/providers/places/hours';
import {
  createPlacesSearchAdapter,
  type PlacesSearchOpeningHoursNormalizer,
} from '../../../src/providers/places-search/adapter';
import { createPlacesSearchContinuation } from '../../../src/providers/places-search/continuation';
import {
  createPlacesSearchCursorStore,
  type PlacesSearchCursorStore,
} from '../../../src/providers/places-search/cursor';
import { createPlacesSearchRegistration } from '../../../src/providers/places-search/registration';
import { createGoogleTextSearchTransport } from '../../../src/providers/places-search/transport';

const NOW = '2026-09-10T02:00:00.000Z';
const SCOPE = { ownerScopeRef: 'owner-search', threadId: 'thread-search' } as const;

class FixtureClock implements ClockPort {
  constructor(private readonly value: string) {}

  now(): string {
    return this.value;
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

const context = (overrides: Partial<HarnessContext> = {}): HarnessContext => ({
  threadId: SCOPE.threadId,
  turnId: 'turn-search',
  revision: 1,
  serverNow: NOW,
  ownerScopeRef: SCOPE.ownerScopeRef,
  location: {
    status: 'available',
    coordinates: { lat: 35.6595, lng: 139.7005 },
    accuracyMeters: 40,
    precise: true,
    capturedAt: NOW,
    revision: 4,
  },
  preferences: {
    homeStationRef: 'station-search',
    maxWalkMinutes: 15,
    minimumStayMinutes: 20,
    areaText: '渋谷',
    budget: 'normal',
  },
  budget: {
    wallClockMs: 5_000,
    finalReserveMs: 500,
    modelCallsRemaining: 2,
    readCallsRemaining: 4,
    providerHttpRequestsRemaining: 4,
    retriesRemaining: 1,
  },
  capabilities: {
    version: 'places-search-v1',
    detailFields: ['identity'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['thread'],
  },
  ...overrides,
});

const execution = (current: HarnessContext): ToolExecutionContext => ({
  callId: 'call-search',
  operation: 'search_places',
  threadId: current.threadId,
  turnId: current.turnId,
  revision: current.revision,
});

const cancellation: CancellationToken = { isCancelled: () => false };

const input = (overrides: Partial<Extract<SearchPlacesInput, { mode: 'search' }>> = {}) => ({
  mode: 'search' as const,
  query: '静かなカフェ',
  area: { kind: 'named_area' as const, name: '渋谷' },
  openNow: true,
  limit: 2,
  excludeCandidateIds: [],
  ...overrides,
});

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

const place = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  displayName: { text: `店 ${id}` },
  formattedAddress: '東京都渋谷区',
  primaryType: 'cafe',
  businessStatus: 'OPERATIONAL',
  googleMapsUri: `https://maps.google.com/?cid=${id}`,
  timeZone: { id: 'Asia/Tokyo' },
  currentOpeningHours: {
    periods: [
      {
        open: { date: { year: 2026, month: 9, day: 10 }, hour: 9, minute: 0 },
        close: { date: { year: 2026, month: 9, day: 10 }, hour: 18, minute: 0 },
      },
    ],
    weekdayDescriptions: ['毎日 9:00–18:00'],
    openNow: true,
  },
  priceLevel: 'PRICE_LEVEL_MODERATE',
  attributions: [
    { provider: 'Google Maps', providerUri: 'https://maps.google.com' },
    { provider: 'Local guide', providerUri: 'https://example.com/guide' },
  ],
  ...overrides,
});

type Fixture = {
  readonly adapter: ReturnType<typeof createPlacesSearchAdapter>;
  readonly registry: CandidateObservationRegistry;
  readonly bodies: Record<string, unknown>[];
  readonly hoursInputs: Record<string, unknown>[];
  readonly clockReadBeforeFetchSettled: () => boolean;
  readonly setNow: (value: number) => void;
};

const makeFixture = (pages: readonly Record<string, unknown>[]): Fixture => {
  const bodies: Record<string, unknown>[] = [];
  const hoursInputs: Record<string, unknown>[] = [];
  let pageIndex = 0;
  let nowMs = 100;
  let fetchSettled = false;
  let clockReadBeforeFetchSettled = false;
  const fetcher: typeof fetch = (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('fixture body is not a string');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    const page = pages[pageIndex];
    pageIndex += 1;
    if (page === undefined) throw new Error('fixture page is missing');
    fetchSettled = true;
    return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }));
  };
  const transport = createGoogleTextSearchTransport({ apiKey: 'test-key', fetcher });
  const store: PlacesSearchCursorStore = createPlacesSearchCursorStore({
    secret: 'places-search-fixture-secret',
    now: () => nowMs,
    nonceFactory: (() => {
      let nonce = 0;
      return () => {
        nonce += 1;
        const bytes = new Uint8Array(16);
        bytes.fill(nonce);
        return bytes;
      };
    })(),
  });
  const continuation = createPlacesSearchContinuation({ store, now: () => nowMs });
  const clock = new FixtureClock(NOW);
  const registry = new Registry(clock, new FixtureIds());
  const registration = createPlacesSearchRegistration({
    registry,
    clock,
    observationPolicy: () => ({
      freshUntil: retention.freshUntil ?? NOW,
      expiresAt: retention.retentionUntil ?? '2026-09-10T23:00:00.000Z',
      retention,
    }),
  });
  const normalizeOpeningHours: PlacesSearchOpeningHoursNormalizer = (raw, evaluatedAt) => {
    hoursInputs.push(raw);
    return normalizeGoogleOpeningHours(raw, evaluatedAt);
  };
  let search = 0;
  const adapter = createPlacesSearchAdapter({
    transport,
    continuation,
    registration,
    nextSearchId: () => {
      search += 1;
      return `search-${search}`;
    },
    clock: () => {
      if (!fetchSettled) clockReadBeforeFetchSettled = true;
      return NOW;
    },
    normalizeOpeningHours,
  });
  return {
    adapter,
    registry,
    bodies,
    hoursInputs,
    clockReadBeforeFetchSettled: () => clockReadBeforeFetchSettled,
    setNow: (value) => (nowMs = value),
  };
};

describe('Places search adapter', () => {
  it('uses the real transport, cursor store, and Core registry across two pages', async () => {
    const fixture = makeFixture([
      {
        places: [place('google-a'), place('google-a'), place('google-b')],
        nextPageToken: 'provider-page-2',
      },
      { places: [place('google-c')], nextPageToken: '' },
    ]);
    const current = context();
    const first = await fixture.adapter.search(input(), current, execution(current), cancellation);
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('first page should succeed');
    expect(first.data.candidates.map((candidate) => candidate.candidateId)).toEqual([
      'candidate-1',
      'candidate-2',
    ]);
    const cursor = first.data.nextCursor;
    expect(cursor).not.toBeNull();
    expect(cursor).not.toContain('provider-page-2');

    const second = await fixture.adapter.search(
      { mode: 'continue', cursor: cursor ?? '' },
      current,
      execution(current),
      cancellation,
    );
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') throw new Error('second page should succeed');
    expect(second.data.candidates.map((candidate) => candidate.candidateId)).toEqual([
      'candidate-3',
    ]);
    expect(fixture.bodies).toHaveLength(2);
    expect(fixture.bodies[1]).toMatchObject({
      textQuery: '静かなカフェ 渋谷',
      openNow: true,
      pageSize: 2,
      pageToken: 'provider-page-2',
    });
    expect(fixture.registry.listCandidates(SCOPE)).toHaveLength(3);
    expect(fixture.hoursInputs).toHaveLength(3);
    expect(fixture.clockReadBeforeFetchSettled()).toBe(false);
  });

  it('applies candidate exclusions after registration and keeps the provider order', async () => {
    const fixture = makeFixture([{ places: [place('google-a'), place('google-b')] }]);
    const current = context();
    const result = await fixture.adapter.search(
      input({ excludeCandidateIds: ['candidate-1'] }),
      current,
      execution(current),
      cancellation,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('search should succeed');
    expect(result.data.candidates).toHaveLength(1);
    expect(result.data.candidates[0]?.candidateId).toBe('candidate-2');
    expect(result.data.applied.excludedCount).toBe(1);
  });

  it('rejects continuation for another owner or a changed location revision before fetch', async () => {
    const fixture = makeFixture([
      { places: [place('google-a')], nextPageToken: 'provider-page-2' },
    ]);
    const current = context();
    const first = await fixture.adapter.search(input(), current, execution(current), cancellation);
    if (first.status !== 'ok' || first.data.nextCursor === null) throw new Error('cursor missing');
    const ownerChanged = context({ ownerScopeRef: 'owner-other' });
    const ownerResult = await fixture.adapter.search(
      { mode: 'continue', cursor: first.data.nextCursor },
      ownerChanged,
      execution(ownerChanged),
      cancellation,
    );
    expect(ownerResult).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT' } });
    const revisionChanged = context({ location: { ...current.location, revision: 5 } });
    const revisionResult = await fixture.adapter.search(
      { mode: 'continue', cursor: first.data.nextCursor },
      revisionChanged,
      execution(revisionChanged),
      cancellation,
    );
    expect(revisionResult).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT' } });
    expect(fixture.bodies).toHaveLength(1);
  });

  it('keeps identity and hours when price is malformed, while preserving all attributions', async () => {
    const fixture = makeFixture([
      {
        places: [place('google-bad-price', { priceLevel: 3 })],
        nextPageToken: '',
      },
    ]);
    const current = context();
    const result = await fixture.adapter.search(input(), current, execution(current), cancellation);
    expect(result.status).toBe('partial');
    if (result.status !== 'partial' && result.status !== 'ok') throw new Error('result missing');
    const candidate = result.data.candidates[0];
    expect(candidate?.identity.status).toBe('known');
    expect(candidate?.openingHours.status).toBe('known');
    expect(candidate?.price).toMatchObject({ status: 'error', error: { code: 'SCHEMA_MISMATCH' } });
    expect(fixture.hoursInputs[0]).toMatchObject({ timeZone: { id: 'Asia/Tokyo' } });
    expect(fixture.hoursInputs[0]).not.toHaveProperty('priceLevel');
    const observations = fixture.registry.listObservations(SCOPE, 'candidate-1');
    const identity = observations.find((observation) => observation.field === 'identity');
    expect(identity?.sources).toHaveLength(2);
  });

  it('distinguishes malformed opening-hours data from an absent field', async () => {
    const fixture = makeFixture([
      { places: [place('google-bad-hours', { currentOpeningHours: 'invalid' })] },
    ]);
    const current = context();
    const result = await fixture.adapter.search(input(), current, execution(current), cancellation);
    expect(result.status).toBe('partial');
    if (result.status !== 'partial' && result.status !== 'ok') throw new Error('result missing');
    expect(result.data.candidates[0]?.openingHours).toMatchObject({
      status: 'error',
      error: { code: 'SCHEMA_MISMATCH' },
    });
    expect(fixture.hoursInputs).toHaveLength(0);

    const noHours = place('google-no-hours');
    delete noHours.currentOpeningHours;
    delete noHours.regularOpeningHours;
    delete noHours.timeZone;
    const missingFixture = makeFixture([{ places: [noHours] }]);
    const missingResult = await missingFixture.adapter.search(
      input(),
      current,
      execution(current),
      cancellation,
    );
    expect(missingResult.status).toBe('ok');
    if (missingResult.status !== 'ok') throw new Error('missing-hours result should succeed');
    expect(missingResult.data.candidates[0]?.openingHours).toMatchObject({
      status: 'unknown',
    });
    expect(missingFixture.hoursInputs).toHaveLength(0);
  });

  it('does not turn malformed attribution metadata into a credited success', async () => {
    const fixture = makeFixture([
      { places: [place('google-bad-source', { attributions: [{ provider: 'missing-uri' }] })] },
    ]);
    const current = context();
    const result = await fixture.adapter.search(input(), current, execution(current), cancellation);
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') throw new Error('partial result expected');
    expect(result.data.candidates[0]?.identity).toMatchObject({
      status: 'error',
      error: { code: 'SCHEMA_MISMATCH', path: 'source' },
    });
    expect(fixture.registry.listObservations(SCOPE)).toHaveLength(0);
  });

  it('reports missing retention policy as context error instead of unknown success', async () => {
    const fixture = makeFixture([{ places: [place('google-a')], nextPageToken: '' }]);
    const current = context();
    const noPolicyRegistration = createPlacesSearchRegistration({
      registry: fixture.registry,
      clock: new FixtureClock(NOW),
      observationPolicy: () => undefined,
    });
    const adapter = createPlacesSearchAdapter({
      transport: {
        search: () => Promise.resolve({ places: [place('google-a')], nextPageToken: null }),
      },
      continuation: {
        issue: () => Promise.resolve('cursor-1'),
        resolve: () => Promise.resolve({ ok: false, code: 'INVALID_CURSOR' as const }),
      },
      registration: noPolicyRegistration,
      nextSearchId: () => 'search-policy',
      clock: () => NOW,
      normalizeOpeningHours: () => ({ status: 'unknown', reason: 'fixture' }),
    });
    const result = await adapter.search(input(), current, execution(current), cancellation);
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') throw new Error('partial result expected');
    expect(result.data.candidates[0]?.identity).toMatchObject({
      status: 'error',
      error: { code: 'MISSING_CONTEXT' },
    });
  });

  it('accepts the Core maximum query plus named-area label and requires current location', async () => {
    const fixture = makeFixture([{ places: [], nextPageToken: '' }]);
    const current = context();
    const longInput = input({
      query: 'q'.repeat(200),
      area: { kind: 'named_area', name: 'あ'.repeat(160) },
    });
    const longResult = await fixture.adapter.search(
      longInput,
      current,
      execution(current),
      cancellation,
    );
    expect(longResult.status).toBe('ok');
    expect(fixture.bodies[0]?.textQuery).toBe(`${'q'.repeat(200)} ${'あ'.repeat(160)}`);
    const currentFixture = makeFixture([{ places: [], nextPageToken: '' }]);
    const currentContext = context({
      preferences: { ...current.preferences, areaText: '保存済みの別地域' },
    });
    const currentResult = await currentFixture.adapter.search(
      input({ area: { kind: 'current_location', radiusMeters: 500 } }),
      currentContext,
      execution(currentContext),
      cancellation,
    );
    expect(currentResult).toMatchObject({
      status: 'ok',
      data: { applied: { areaDescription: '現在地周辺' } },
    });
    const unavailable = context({
      location: {
        status: 'unavailable',
        coordinates: null,
        accuracyMeters: null,
        precise: false,
        capturedAt: null,
        revision: 4,
      },
    });
    const unavailableResult = await fixture.adapter.search(
      input({ area: { kind: 'current_location', radiusMeters: 500 } }),
      unavailable,
      execution(unavailable),
      cancellation,
    );
    expect(unavailableResult).toMatchObject({
      status: 'error',
      error: { code: 'LOCATION_REQUIRED' },
    });
    expect(fixture.bodies).toHaveLength(1);
  });
});
