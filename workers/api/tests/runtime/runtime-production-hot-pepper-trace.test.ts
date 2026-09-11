import { describe, expect, it } from 'vitest';
import { parseHotPepperResponse } from '../../src/providers/hot-pepper/wire';
import type {
  HotPepperField,
  HotPepperFieldPolicy,
  HotPepperPolicyUse,
  HotPepperProviderInputPolicy,
} from '../../src/providers/hot-pepper/types';
import type { PlacesDetailsObservationPolicy } from '../../src/providers/places-details/adapter-types';
import type { RuntimeProviderTrace } from '../../src/providers/telemetry/runtime-provider-trace';
import { createRuntimeProductionConnectionOptions } from '../../src/runtime/runtime-production-factory';
import { invokePublicToolEnvelope } from '../../src/tools';
import {
  ALLOW_MODEL_CONTEXT_FIELDS,
  ALLOW_RETENTION,
  NOW,
  buildRequest,
  readOnlyCommit,
} from './runtime-production-factory-fixtures';
import { modelFor, type RuntimeGateModelReport } from '../support/runtime-model-fixture';

const hpFieldPolicy: HotPepperFieldPolicy = (field: HotPepperField, use: HotPepperPolicyUse) => ({
  decision:
    (field === 'source' && use === 'attribution') || (field === 'facilities' && use === 'llm_input')
      ? 'allow'
      : 'deny',
  activation: 'live_verified',
});

const hpProviderInputPolicy: HotPepperProviderInputPolicy = () => ({
  decision: 'allow',
  activation: 'live_verified',
});

const hpObservationPolicy: PlacesDetailsObservationPolicy = () => ({
  freshUntil: '2026-09-10T01:00:00.000Z',
  expiresAt: '2026-09-10T03:00:00.000Z',
  retention: {
    ...ALLOW_RETENTION,
    attribution: { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
  },
});

const googlePlace = (id: string) => ({
  id,
  displayName: { text: 'HP Trace Cafe' },
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
});

const hotPepperBody = () => {
  const parsed = parseHotPepperResponse({
    results: {
      shop: [
        {
          id: 'hp-trace-cafe',
          name: 'HP Trace Cafe',
          lat: 35.6595,
          lng: 139.7005,
          open: '11:00〜22:00',
          close: '無休',
          budget: { name: '昼 1000円', average: '夜 3000円' },
          urls: { pc: 'https://www.hotpepper.jp/strJ000000003' },
          wifi: 'あり',
          non_smoking: 'なし',
          private_room: '一部',
          parking: 'あり',
        },
      ],
    },
  });
  return { results: { shop: [parsed.shops[0]] } };
};

describe('production Hot Pepper transport trace', () => {
  it('traces one live configured HP fetch through the production factory', async () => {
    const report: RuntimeGateModelReport = { calls: 0, requests: [] };
    const requests: Request[] = [];
    const traces: RuntimeProviderTrace[] = [];
    const fetcher: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes('/hotpepper/gourmet/')) {
        return Promise.resolve(new Response(JSON.stringify(hotPepperBody()), { status: 200 }));
      }
      if (request.url.endsWith('/v1/places:searchText')) {
        return Promise.resolve(
          new Response(JSON.stringify({ places: [googlePlace('place-hp-trace')] }), {
            status: 200,
          }),
        );
      }
      if (request.url.includes('/v1/places/')) {
        return Promise.resolve(
          new Response(JSON.stringify(googlePlace('place-hp-trace')), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    };
    const options = createRuntimeProductionConnectionOptions({
      env: {
        IMA_RUNTIME_MODE: 'live',
        IMA_PROVIDER_OPENAI: 'true',
        IMA_PROVIDER_PLACES: 'true',
        IMA_PROVIDER_HOTPEPPER: 'true',
        IMA_KILL_SWITCH: 'false',
        OPENAI_API_KEY: 'openai-hotpepper-trace-key',
        GOOGLE_PLACES_API_KEY: 'google-hotpepper-trace-key',
        PLACES_CURSOR_SECRET: 'cursor-hotpepper-trace-secret',
        HOTPEPPER_API_KEY: 'hotpepper-trace-key',
      },
      commit: readOnlyCommit,
      overrides: {
        modelForTurn: modelFor('search', report),
        fetcher,
        hotPepperFetcher: fetcher,
        placesEnabled: true,
        hotPepperEnabled: true,
        hotPepperFieldPolicy: hpFieldPolicy,
        hotPepperProviderInputPolicy: hpProviderInputPolicy,
        hotPepperObservationPolicy: hpObservationPolicy,
        hotPepperCandidateReferenceFor: (candidate) => ({
          candidateId: candidate.candidateId,
          name: candidate.displayName,
          lat: 35.6595,
          lng: 139.7005,
        }),
        observationPolicy: hpObservationPolicy,
        detailsObservationPolicy: hpObservationPolicy,
        modelContextFieldPolicy: ALLOW_MODEL_CONTEXT_FIELDS,
        providerTraceSink: (trace) => {
          traces.push(trace);
        },
        clock: () => NOW,
        monotonicNow: () => 0,
        epochNow: () => 1_000,
      },
    });
    if (options === undefined) throw new Error('live HP trace factory unavailable');

    const composition = await options.buildTurn(buildRequest);
    const searched = await invokePublicToolEnvelope(
      'search_places',
      {
        input: {
          mode: 'search',
          query: '静かなカフェ',
          area: { kind: 'named_area', name: '渋谷' },
          openNow: true,
          limit: 1,
          excludeCandidateIds: [],
        },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-live-trace-search' },
    );
    expect(searched.status).toBe('ok');
    if (searched.status !== 'ok') throw new Error('live HP trace search failed');
    const candidateId = searched.data.candidates[0]?.candidateId;
    if (candidateId === undefined) throw new Error('live HP trace candidate missing');
    const details = await invokePublicToolEnvelope(
      'get_place_details',
      {
        input: { requests: [{ candidateId, fields: ['facilities'] }], freshness: 'refresh' },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'hotpepper-live-trace-details' },
    );
    expect(details.status).toBe('ok');
    const hpRequests = requests.filter((request) => request.url.includes('/hotpepper/gourmet/'));
    expect(hpRequests).toHaveLength(1);
    const hpTraces = traces.filter((trace) => trace.provider === 'hotpepper');
    expect(hpTraces).toHaveLength(1);
    expect(hpTraces[0]).toMatchObject({ status: 'ok', resultCode: 'OK', durationMs: 0 });
    expect(JSON.stringify(hpTraces)).not.toMatch(/hotpepper-trace-key|35\.6595|139\.7005/iu);
    composition.dispose();
  });
});
