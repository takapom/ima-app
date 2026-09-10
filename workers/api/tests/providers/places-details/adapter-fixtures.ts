import type {
  CandidateObservationRegistry,
  ClockPort,
  GetPlaceDetailsInput,
  HarnessContext,
  RegistryIdPort,
  ToolExecutionContext,
} from '@ima/core';
import { CandidateObservationRegistry as Registry } from '@ima/core';
import {
  createPlacesDetailsAdapter,
  type PlacesDetailsAdapterOptions,
} from '../../../src/providers/places-details/adapter';
import { createGooglePlaceDetailsTransport } from '../../../src/providers/places-details/transport';
import type { PlacesDetailsObservationPolicy } from '../../../src/providers/places-details/adapter-types';

export const NOW = '2026-09-10T02:00:00.000Z';
export const SCOPE = { ownerScopeRef: 'owner-details', threadId: 'thread-details' } as const;

export class FixtureClock implements ClockPort {
  constructor(private value: string) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

class FixtureIds implements RegistryIdPort {
  private candidate = 0;
  private observation = 0;
  private place = 0;

  nextCallId(): string {
    return 'call-details';
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
    return 'response-details';
  }

  nextPlaceRef(): string {
    this.place += 1;
    return `place-${this.place}`;
  }
}

export const context: HarnessContext = {
  threadId: SCOPE.threadId,
  turnId: 'turn-details',
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
    homeStationRef: 'station-details',
    maxWalkMinutes: 15,
    minimumStayMinutes: 20,
    areaText: null,
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
    version: 'places-details-v1',
    detailFields: ['identity', 'opening_hours', 'price', 'photos', 'contact'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['thread'],
  },
};

export const execution: ToolExecutionContext = {
  callId: 'call-details',
  operation: 'get_place_details',
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
};

export const retention = {
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

export const policy: PlacesDetailsObservationPolicy = () => ({
  freshUntil: retention.freshUntil,
  expiresAt: retention.retentionUntil,
  retention,
});

export const place = (id: string, name = `店 ${id}`): Record<string, unknown> => ({
  id,
  displayName: { text: name },
  formattedAddress: '東京都渋谷区',
  primaryType: 'cafe',
  businessStatus: 'OPERATIONAL',
  googleMapsUri: `https://maps.google.com/?cid=${id}`,
  websiteUri: 'https://example.com/cafe',
  internationalPhoneNumber: '+81 3 1234 5678',
  priceLevel: 'PRICE_LEVEL_MODERATE',
  photos: [
    {
      name: `places/${id}/photos/photo-1`,
      authorAttributions: [{ displayName: 'Google guide', uri: 'https://example.com/guide' }],
      googleMapsUri: `https://maps.google.com/?cid=${id}`,
    },
  ],
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
  timeZone: { id: 'Asia/Tokyo' },
  attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
});

export type Fixture = {
  readonly adapter: ReturnType<typeof createPlacesDetailsAdapter>;
  readonly registry: CandidateObservationRegistry;
  readonly candidateIds: readonly string[];
  readonly calls: { readonly id: string; readonly mask: string }[];
  readonly clock: FixtureClock;
  readonly cancel: { value: boolean };
  setBody(factory: (id: string) => unknown): void;
};

export const makeFixture = (ids: readonly string[] = ['place-a']): Fixture => {
  const clock = new FixtureClock(NOW);
  const registry = new Registry(clock, new FixtureIds());
  const candidateIds = ids.map(
    (recordRef) =>
      registry.registerCandidate({
        ...SCOPE,
        provider: 'google_places',
        recordRef,
        displayName: `候補 ${recordRef}`,
        status: 'operational',
      }).candidateId,
  );
  const calls: { id: string; mask: string }[] = [];
  let bodyFactory: (id: string) => unknown = (id) => place(id);
  const fetcher: typeof fetch = (url, init) => {
    const urlText = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const id = urlText.split('/').at(-1) ?? '';
    const mask = new Headers(init?.headers).get('x-goog-fieldmask') ?? '';
    calls.push({ id, mask });
    try {
      return Promise.resolve(new Response(JSON.stringify(bodyFactory(id)), { status: 200 }));
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error('fixture failure'));
    }
  };
  const transport = createGooglePlaceDetailsTransport({ apiKey: 'fixture-key', fetcher });
  const cancel = { value: false };
  const options: PlacesDetailsAdapterOptions = {
    transport,
    registry,
    clock,
    observationPolicy: policy,
    areaLabelFor: () => '渋谷',
  };
  const adapter = createPlacesDetailsAdapter(options);
  return {
    adapter,
    registry,
    candidateIds,
    calls,
    clock,
    cancel,
    setBody: (factory) => {
      bodyFactory = factory;
    },
  };
};

export const readInput = (
  candidateId: string,
  fields: GetPlaceDetailsInput['requests'][number]['fields'],
  freshness: GetPlaceDetailsInput['freshness'] = 'refresh',
): GetPlaceDetailsInput => ({
  requests: [{ candidateId, fields }],
  freshness,
});

export const read = (
  fixture: Fixture,
  input: GetPlaceDetailsInput,
  token: { readonly isCancelled: () => boolean } = { isCancelled: () => false },
) => fixture.adapter.read(input, context, execution, token);
