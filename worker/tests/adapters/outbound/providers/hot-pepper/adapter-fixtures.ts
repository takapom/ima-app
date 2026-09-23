import type { CandidateObservationRegistry } from '@worker/application/candidate-registry/registry';
import type {
  ClockPort,
  HarnessContext,
  RegistryIdPort,
  ToolExecutionContext,
} from '@worker/application/ports/context';
import type { GetPlaceDetailsInput } from '@worker/application/ports/operations';
import { CandidateObservationRegistry as Registry } from '@worker/application/candidate-registry/registry';
import { createHotPepperDetailsAdapter } from '@worker/adapters/out/providers/hot-pepper/details-adapter';
import { createHotPepperTransport } from '@worker/adapters/out/providers/hot-pepper/transport';
import {
  createPlacesSearchRegistration,
  type PlacesSearchObservationPolicy,
} from '@worker/adapters/out/providers/places-search/registration';

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
  attribution: { label: 'ホットペッパー', sourceLink: 'https://webservice.recruit.co.jp/' },
  restoreMode: 'full' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};

export const policy: PlacesSearchObservationPolicy = () => ({
  freshUntil: retention.freshUntil,
  expiresAt: retention.retentionUntil,
  retention,
});

export const place = (id: string, name = `店 ${id}`): Record<string, unknown> => ({
  id,
  name,
  address: '東京都渋谷区',
  lat: 35.6595,
  lng: 139.7005,
  open: '毎日 9:00–18:00',
  close: 'なし',
  genre: { name: 'カフェ' },
  budget: { average: '2000円' },
  urls: { pc: `https://www.hotpepper.jp/str${id}/` },
});

export type Fixture = {
  readonly adapter: ReturnType<typeof createHotPepperDetailsAdapter>;
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
        provider: 'hotpepper',
        recordRef,
        displayName: `候補 ${recordRef}`,
        status: 'operational',
      }).candidateId,
  );
  const calls: { id: string; mask: string }[] = [];
  let bodyFactory: (id: string) => unknown = (id) => place(id);
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(new Request(input, init).url);
    const id = url.searchParams.get('id') ?? '';
    calls.push({ id, mask: '' });
    try {
      return Promise.resolve(Response.json({ results: { shop: [bodyFactory(id)] } }));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('fixture failure'));
    }
  };
  const transport = createHotPepperTransport({ apiKey: 'fixture-key', fetcher });
  const cancel = { value: false };
  const base = createPlacesSearchRegistration({ registry, clock, observationPolicy: policy });
  const adapter = createHotPepperDetailsAdapter({
    transport,
    registry,
    clock: () => clock.now(),
    areaFor: () => '渋谷',
    registration: {
      ...base,
      registerObservation: (input) => {
        registry.invalidateObservationReuse(input.scope, input.candidateId, input.field);
        const stored = base.registerObservation(input);
        if (stored)
          registry.restoreObservationReuse(input.scope, input.candidateId, input.field, [
            stored.observationId,
          ]);
        return stored;
      },
    },
  });
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
