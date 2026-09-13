import type { ThreadTurnRequest } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import { createRuntimeProductionConnectionOptions } from '../../src/runtime/composition/runtime-production-factory';
import type { RuntimeProviderTrace } from '../../src/providers/telemetry/runtime-provider-trace';
import { invokePublicToolEnvelope } from '../../src/tools';
import { modelFor, type RuntimeGateModelReport } from '../support/runtime-model-fixture';
import {
  ALLOW_MODEL_CONTEXT_FIELDS,
  ALLOW_RETENTION,
  FIXTURE_OPERATIONAL_ENV,
  NOW,
  buildRequest,
  readOnlyCommit,
  requestInput,
} from './composition/runtime-production-factory-fixtures';

const routeRequest: ThreadTurnRequest = {
  ...requestInput,
  requestId: 'request-provider-trace-route',
  turnId: 'turn-provider-trace-route',
  location: {
    status: 'available',
    lat: 35.6595,
    lng: 139.7005,
    accuracyMeters: 40,
    precise: true,
    capturedAt: NOW,
  },
  prefs: { ...requestInput.prefs, maxWalkMinutes: 15 },
};

const routePolicy = () => ({
  freshUntil: '2026-09-10T01:00:00.000Z',
  expiresAt: '2026-09-10T03:00:00.000Z',
  retention: ALLOW_RETENTION,
});

const routeFetcher =
  (requests: Request[]) =>
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.endsWith('/v1/places:searchText')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            places: [
              {
                id: 'place-provider-trace-route',
                displayName: { text: 'Provider Trace Cafe' },
                formattedAddress: '東京都渋谷区',
                primaryType: 'cafe',
                businessStatus: 'OPERATIONAL',
                googleMapsUri: 'https://maps.google.com/?cid=provider-trace-route',
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
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    if (request.url.endsWith('distanceMatrix/v2:computeRouteMatrix')) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              originIndex: 0,
              destinationIndex: 0,
              status: {},
              condition: 'ROUTE_EXISTS',
              distanceMeters: 300,
              duration: '90s',
            },
          ]),
          { status: 200 },
        ),
      );
    }
    return Promise.reject(new Error('unexpected provider trace request'));
  };

describe('production provider trace assembly', () => {
  it('forwards the factory observer through the real Routes transport', async () => {
    const report: RuntimeGateModelReport = { calls: 0, requests: [] };
    const requests: Request[] = [];
    const traces: RuntimeProviderTrace[] = [];
    const options = createRuntimeProductionConnectionOptions({
      env: {
        ...FIXTURE_OPERATIONAL_ENV,
        OPENAI_API_KEY: 'openai-provider-trace-key',
        GOOGLE_PLACES_API_KEY: 'google-provider-trace-key',
        GOOGLE_ROUTES_API_KEY: 'routes-provider-trace-key',
        PLACES_CURSOR_SECRET: 'cursor-provider-trace-secret',
      },
      commit: readOnlyCommit,
      overrides: {
        modelForTurn: modelFor('search', report),
        fetcher: routeFetcher(requests),
        placesEnabled: true,
        routesEnabled: true,
        observationPolicy: routePolicy,
        routeObservationPolicy: routePolicy,
        modelContextFieldPolicy: ALLOW_MODEL_CONTEXT_FIELDS,
        currentOriginRefFor: () => 'current-location',
        providerTraceSink: (trace) => {
          traces.push(trace);
        },
        clock: () => NOW,
        monotonicNow: () => 0,
        epochNow: () => 1_000,
      },
    });
    if (options === undefined) throw new Error('production provider trace factory unavailable');

    const composition = await options.buildTurn({
      ...buildRequest,
      turnId: 'turn-provider-trace-route',
      runtimeInput: routeRequest,
    });
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
      { toolCallId: 'provider-trace-search' },
    );
    expect(searched.status).toBe('ok');
    if (searched.status !== 'ok') throw new Error('provider trace search failed');
    const candidateId = searched.data.candidates[0]?.candidateId;
    if (candidateId === undefined) throw new Error('provider trace candidate missing');

    const details = await invokePublicToolEnvelope(
      'get_place_details',
      {
        input: { requests: [{ candidateId, fields: ['walking_route'] }], freshness: 'refresh' },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'provider-trace-details' },
    );
    expect(details.status).toBe('ok');
    expect(requests.filter((request) => request.url.includes('computeRouteMatrix'))).toHaveLength(
      1,
    );
    expect(traces).toHaveLength(2);
    expect(traces.map((trace) => trace.provider)).toEqual(['places', 'routes']);
    expect(traces.every((trace) => trace.status === 'ok' && trace.resultCode === 'OK')).toBe(true);
    expect(traces[1]).toMatchObject({ provider: 'routes', apiElementCount: 1 });
    expect(JSON.stringify(traces)).not.toMatch(
      /provider-trace-key|maps\.googleapis|provider-cafe-canary|35\.6595|139\.7005/iu,
    );
    composition.dispose();
  });
});
