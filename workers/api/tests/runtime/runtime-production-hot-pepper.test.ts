import { describe, expect, it } from 'vitest';
import { invokePublicToolEnvelope } from '../../src/tools';
import { createRuntimeProductionConnectionOptions } from '../../src/runtime/composition/runtime-production-factory';
import { cardEvidenceResolver } from '../../src/runtime/composition/runtime-production-provider-config';
import type {
  HotPepperField,
  HotPepperFieldPolicy,
  HotPepperPolicyUse,
  HotPepperProviderInputPolicy,
} from '../../src/providers/hot-pepper/types';
import type { HotPepperTransport } from '../../src/providers/hot-pepper/transport';
import { parseHotPepperResponse } from '../../src/providers/hot-pepper/wire';
import type { PlacesDetailsObservationPolicy } from '../../src/providers/places-details/adapter-types';
import {
  ALLOW_MODEL_CONTEXT_FIELDS,
  ALLOW_RETENTION,
  FIXTURE_OPERATIONAL_ENV,
  NOW,
  buildRequest,
  readOnlyCommit,
} from './runtime-production-factory-fixtures';
import { sessionExpiryAt } from '../../src/runtime/composition/runtime-production-support';

const hpFieldPolicy: HotPepperFieldPolicy = (field: HotPepperField, use: HotPepperPolicyUse) => ({
  decision:
    (field === 'source' && use === 'attribution') || (field === 'facilities' && use === 'llm_input')
      ? 'allow'
      : 'deny',
  activation: 'fixture_only',
});

const hpProviderInputPolicy: HotPepperProviderInputPolicy = () => ({
  decision: 'allow',
  activation: 'fixture_only',
});

const hpObservationPolicy: PlacesDetailsObservationPolicy = () => ({
  freshUntil: '2026-09-10T01:00:00.000Z',
  expiresAt: '2026-09-10T03:00:00.000Z',
  retention: {
    ...ALLOW_RETENTION,
    attribution: { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
  },
});

const hpObservationPolicyLong: PlacesDetailsObservationPolicy = () => ({
  freshUntil: '2026-09-11T01:00:00.000Z',
  expiresAt: '2026-09-11T03:00:00.000Z',
  retention: {
    ...ALLOW_RETENTION,
    sessionExpiresAt: '2026-09-12T00:00:00.000Z',
    freshUntil: '2026-09-11T01:00:00.000Z',
    displayUntil: '2026-09-11T02:00:00.000Z',
    retentionUntil: '2026-09-11T03:00:00.000Z',
    deletionScheduledAt: '2026-09-11T03:00:00.000Z',
    attribution: { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
  },
});

const googlePlace = (id: string) => ({
  id,
  displayName: { text: 'HP Production Cafe' },
  formattedAddress: '東京都渋谷区',
  primaryType: 'cafe',
  businessStatus: 'OPERATIONAL',
  googleMapsUri: `https://maps.google.com/?cid=${id}`,
  attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
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
});

const hotPepperShop = () => {
  const parsed = parseHotPepperResponse({
    results: {
      shop: [
        {
          id: 'hp-production-cafe',
          name: 'HP Production Cafe',
          lat: 35.6595,
          lng: 139.7005,
          open: '11:00〜22:00',
          close: '無休',
          budget: { name: '昼 1000円', average: '夜 3000円' },
          urls: { pc: 'https://www.hotpepper.jp/strJ000000002' },
          wifi: 'あり',
          non_smoking: 'なし',
          private_room: '一部',
          parking: 'あり',
        },
      ],
    },
  });
  const shop = parsed.shops[0];
  if (shop === undefined) throw new Error('Hot Pepper fixture shop is missing');
  return shop;
};

type FactoryFixture = {
  readonly options: NonNullable<ReturnType<typeof createRuntimeProductionConnectionOptions>>;
  readonly hpCalls: number[];
};

const factoryFor = (
  hotPepperFlag = true,
  factoryOptions: {
    readonly longHotPepperRetention?: boolean;
    readonly manyPlaces?: boolean;
    readonly googlePrice?: boolean;
    readonly hotPepperFieldPolicy?: HotPepperFieldPolicy;
  } = {},
): FactoryFixture => {
  const hpCalls: number[] = [];
  const googleFetcher: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    const googlePlaceForResponse = (id: string) => {
      const place = { ...googlePlace(id) };
      if (factoryOptions.googlePrice === false) {
        delete (place as { priceLevel?: unknown }).priceLevel;
      }
      return place;
    };
    if (request.url.endsWith('/v1/places:searchText')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            places: factoryOptions.manyPlaces
              ? Array.from({ length: 5 }, (_, index) =>
                  googlePlaceForResponse(`place-hp-production-${index}`),
                )
              : [googlePlaceForResponse('place-hp-production')],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    }
    const placeId = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '');
    return Promise.resolve(
      new Response(JSON.stringify(googlePlaceForResponse(placeId || 'place-hp-production')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const hotPepperObservation = factoryOptions.longHotPepperRetention
    ? hpObservationPolicyLong
    : hpObservationPolicy;
  const hotPepperTransport: HotPepperTransport = {
    search: () => {
      hpCalls.push(1);
      return Promise.resolve({ shops: [hotPepperShop()], resultsAvailable: 1, resultsStart: 1 });
    },
  };
  const options = createRuntimeProductionConnectionOptions({
    env: {
      ...FIXTURE_OPERATIONAL_ENV,
      IMA_PROVIDER_HOTPEPPER: hotPepperFlag ? 'true' : 'false',
      OPENAI_API_KEY: 'openai-hotpepper-test-key',
      GOOGLE_PLACES_API_KEY: 'google-hotpepper-test-key',
      PLACES_CURSOR_SECRET: 'cursor-hotpepper-test-secret',
    },
    commit: readOnlyCommit,
    overrides: {
      modelForTurn: {
        specificationVersion: 'v3',
        provider: 'hotpepper-test-model',
        modelId: 'hotpepper-test-model',
        supportedUrls: {},
        doGenerate: () => Promise.reject(new Error('fixture does not generate')),
        doStream: () => Promise.reject(new Error('fixture does not stream')),
      },
      fetcher: googleFetcher,
      placesEnabled: true,
      hotPepperEnabled: true,
      hotPepperTransport,
      hotPepperFieldPolicy: factoryOptions.hotPepperFieldPolicy ?? hpFieldPolicy,
      hotPepperProviderInputPolicy: hpProviderInputPolicy,
      hotPepperObservationPolicy: hotPepperObservation,
      hotPepperCandidateReferenceFor: (candidate) => ({
        candidateId: candidate.candidateId,
        name: candidate.displayName,
        lat: 35.6595,
        lng: 139.7005,
      }),
      observationPolicy: hpObservationPolicy,
      detailsObservationPolicy: hpObservationPolicy,
      modelContextFieldPolicy: ALLOW_MODEL_CONTEXT_FIELDS,
      clock: () => NOW,
      monotonicNow: () => 0,
      epochNow: () => 1_000,
    },
  });
  if (options === undefined) throw new Error('production factory should be configured');
  return { options, hpCalls };
};

const searchInput = {
  input: {
    mode: 'search' as const,
    query: '静かなカフェ',
    area: { kind: 'named_area' as const, name: '渋谷' },
    openNow: true,
    limit: 1,
    excludeCandidateIds: [],
  },
  metadata: {},
};

describe('production Hot Pepper composition', () => {
  it('composes optional HP facilities through the production Details port', async () => {
    const fixture = factoryFor();
    const composition = await fixture.options.buildTurn(buildRequest);
    expect(composition.turn.context.capabilities.detailFields).toEqual([
      'identity',
      'opening_hours',
      'price',
      'facilities',
    ]);
    const searched = await invokePublicToolEnvelope(
      'search_places',
      searchInput,
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-production-search' },
    );
    expect(searched.status).toBe('ok');
    if (searched.status !== 'ok') return;
    const candidateId = searched.data.candidates[0]?.candidateId;
    if (candidateId === undefined) throw new Error('HP production candidate is missing');
    const details = await invokePublicToolEnvelope(
      'get_place_details',
      {
        input: {
          requests: [{ candidateId, fields: ['identity', 'price', 'facilities'] }],
          freshness: 'refresh',
        },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-production-details' },
    );
    expect(details.status).toBe('ok');
    if (details.status !== 'ok') return;
    const fields = details.data.items[0]?.fields;
    expect(fields?.identity).toMatchObject({ status: 'known' });
    expect(fields?.price).toMatchObject({ status: 'known' });
    expect(fields?.facilities).toMatchObject({
      status: 'known',
      observations: [{ sources: [{ provider: 'hotpepper' }] }],
    });
    expect(fixture.hpCalls).toHaveLength(1);
    expect(composition.turn.budget.snapshot()).toMatchObject({
      providerHttpRequests: 3,
      readCalls: 2,
    });
    composition.dispose();
  });

  it('keeps HP out of the production graph when its operational flag is disabled', async () => {
    const fixture = factoryFor(false);
    const composition = await fixture.options.buildTurn(buildRequest);
    expect(composition.turn.context.capabilities.detailFields).toEqual([
      'identity',
      'opening_hours',
      'price',
    ]);
    const searched = await invokePublicToolEnvelope(
      'search_places',
      searchInput,
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-disabled-search' },
    );
    expect(searched.status).toBe('ok');
    expect(fixture.hpCalls).toHaveLength(0);
    composition.dispose();
  });

  it('caps HP observation freshness at the fixed production session expiry', async () => {
    const fixture = factoryFor(true, { longHotPepperRetention: true });
    const composition = await fixture.options.buildTurn(buildRequest);
    const searched = await invokePublicToolEnvelope(
      'search_places',
      searchInput,
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-cap-search' },
    );
    expect(searched.status).toBe('ok');
    if (searched.status !== 'ok') return;
    const candidateId = searched.data.candidates[0]?.candidateId;
    if (candidateId === undefined) throw new Error('HP cap candidate is missing');
    const details = await invokePublicToolEnvelope(
      'get_place_details',
      {
        input: {
          requests: [{ candidateId, fields: ['facilities'] }],
          freshness: 'refresh',
        },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-cap-details' },
    );
    expect(details.status).toBe('ok');
    if (details.status !== 'ok') return;
    const facilities = details.data.items[0]?.fields.facilities;
    expect(facilities).toMatchObject({
      status: 'known',
    });
    if (facilities?.status !== 'known') return;
    const observationId = facilities.observations[0]?.observationId;
    if (observationId === undefined) throw new Error('HP capped observation is missing');
    const stored = composition.turn.dependencies.registry.readObservation(
      { ownerScopeRef: buildRequest.ownerScopeRef, threadId: buildRequest.threadId },
      observationId,
    );
    expect(stored?.retention.sessionExpiresAt).toBe(sessionExpiryAt(NOW));
    expect(fixture.hpCalls).toHaveLength(1);
    composition.dispose();
  });

  it('reprojects stored HP evidence at the production public evidence boundary', async () => {
    let allowStorage = true;
    const policy: HotPepperFieldPolicy = (field, use) => ({
      decision:
        (field === 'source' && use === 'attribution') ||
        (field === 'price' && use === 'llm_input') ||
        (field === 'price' && (use === 'display' || use === 'persistence') && allowStorage)
          ? 'allow'
          : 'deny',
      activation: 'fixture_only',
    });
    const fixture = factoryFor(true, { googlePrice: false, hotPepperFieldPolicy: policy });
    const composition = await fixture.options.buildTurn(buildRequest);
    const searched = await invokePublicToolEnvelope(
      'search_places',
      searchInput,
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-public-evidence-search' },
    );
    expect(searched.status).toBe('ok');
    if (searched.status !== 'ok') return;
    const candidateId = searched.data.candidates[0]?.candidateId;
    if (candidateId === undefined) throw new Error('HP public evidence candidate is missing');
    const details = await invokePublicToolEnvelope(
      'get_place_details',
      {
        input: {
          requests: [{ candidateId, fields: ['price'] }],
          freshness: 'refresh',
        },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-public-evidence-details' },
    );
    expect(details.status).toBe('ok');
    if (details.status !== 'ok') return;
    const price = details.data.items[0]?.fields.price;
    expect(price).toMatchObject({ status: 'known' });
    if (price?.status !== 'known') return;
    const evidenceId = price.observations[0]?.observationId;
    if (evidenceId === undefined) throw new Error('HP public evidence observation is missing');
    const stored = composition.turn.dependencies.registry.readObservation(
      { ownerScopeRef: buildRequest.ownerScopeRef, threadId: buildRequest.threadId },
      evidenceId,
    );
    expect(stored?.retention.policyStatus).toBe('available');

    allowStorage = false;
    const resolveCardEvidence = cardEvidenceResolver(
      composition.turn.dependencies.registry,
      composition.turn.context,
      { hotPepperFieldPolicy: policy, hotPepperMode: 'fixture' },
    );
    const projected = resolveCardEvidence(candidateId, evidenceId);

    expect(projected?.retention).toMatchObject({
      retentionDecision: 'deny',
      policyStatus: 'policy_withheld',
      displayPolicyStatus: 'policy_withheld',
      retentionUntil: null,
      deletionScheduledAt: null,
      restoreMode: 'unavailable',
    });
    composition.dispose();
  });

  it('does not call HP after the production provider budget is exhausted', async () => {
    const fixture = factoryFor(true, { manyPlaces: true });
    const composition = await fixture.options.buildTurn(buildRequest);
    const searched = await invokePublicToolEnvelope(
      'search_places',
      { ...searchInput, input: { ...searchInput.input, limit: 5 } },
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-budget-search' },
    );
    expect(searched.status).toBe('ok');
    if (searched.status !== 'ok') return;
    const candidateIds = searched.data.candidates.map((candidate) => candidate.candidateId);
    expect(candidateIds).toHaveLength(5);
    const detailsEnvelope = {
      input: {
        requests: candidateIds.map((candidateId) => ({ candidateId, fields: ['facilities'] })),
        freshness: 'refresh' as const,
      },
      metadata: {},
    };
    for (let index = 0; index < 3; index += 1) {
      const result = await invokePublicToolEnvelope(
        'get_place_details',
        detailsEnvelope,
        composition.turn.dependencies,
        { toolCallId: `hotpepper-budget-details-${index}` },
      );
      expect(result.status).toBe('ok');
    }
    const lastAdmitted = await invokePublicToolEnvelope(
      'get_place_details',
      {
        input: {
          requests: candidateIds.slice(0, 4).map((candidateId) => ({
            candidateId,
            fields: ['facilities'],
          })),
          freshness: 'refresh' as const,
        },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-budget-last-admitted' },
    );
    expect(lastAdmitted.status).toBe('ok');
    expect(fixture.hpCalls).toHaveLength(19);
    expect(composition.turn.budget.snapshot().providerHttpRequests).toBe(20);

    const exhausted = await invokePublicToolEnvelope(
      'get_place_details',
      {
        input: {
          requests: [{ candidateId: candidateIds[4], fields: ['facilities'] }],
          freshness: 'refresh' as const,
        },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-budget-exhausted' },
    );
    expect(exhausted.status).toBe('partial');
    expect(fixture.hpCalls).toHaveLength(19);
    composition.dispose();
  });
});
