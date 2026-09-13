import type { ThreadTurnRequest } from '@ima/contracts';
import type { CommitPort } from '@ima/core';
import { describe, expect, it } from 'vitest';
import { createRuntimeProductionConnectionOptions } from '../../../src/runtime/composition/runtime-production-factory';
import { invokePublicToolEnvelope } from '../../../src/tools';
import { modelFor, type RuntimeGateModelReport } from '../../support/runtime-model-fixture';
import {
  ALLOW_MODEL_CONTEXT_FIELDS,
  ALLOW_RETENTION,
  FIXTURE_OPERATIONAL_ENV,
  NOW,
  buildRequest,
  requestInput,
} from './runtime-production-factory-fixtures';

describe('production runtime Routes wiring', () => {
  it('submits current-location walking evidence without a station dataset', async () => {
    const report: RuntimeGateModelReport = { calls: 0, requests: [] };
    const requests: Request[] = [];
    const routeCommit: CommitPort = {
      commit: ({ record }) => ({
        status: 'committed',
        receipt: {
          responseId: record.responseId,
          revision: record.revision,
          payloadDigest: record.payloadDigest,
          presentation: record.presentation,
          replayed: false,
        },
      }),
    };
    const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith('/v1/places:searchText')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              places: [
                {
                  id: 'place-production-route',
                  displayName: { text: 'Route Cafe' },
                  formattedAddress: '東京都渋谷区',
                  primaryType: 'cafe',
                  businessStatus: 'OPERATIONAL',
                  googleMapsUri: 'https://maps.google.com/?cid=production-route',
                  attributions: [
                    { provider: 'Google Maps', providerUri: 'https://maps.google.com' },
                  ],
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
      if (request.url.includes('computeRouteMatrix')) {
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
      return Promise.reject(new Error('unexpected provider request'));
    };
    const routeRequest: ThreadTurnRequest = {
      ...requestInput,
      requestId: 'request-production-route',
      turnId: 'turn-production-route',
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
    const options = createRuntimeProductionConnectionOptions({
      env: {
        ...FIXTURE_OPERATIONAL_ENV,
        OPENAI_API_KEY: 'openai-test-key',
        GOOGLE_PLACES_API_KEY: 'google-test-key',
        GOOGLE_ROUTES_API_KEY: 'routes-test-key',
        PLACES_CURSOR_SECRET: 'cursor-test-secret-16',
      },
      commit: routeCommit,
      overrides: {
        modelForTurn: modelFor('search', report),
        fetcher,
        placesEnabled: true,
        routesEnabled: true,
        observationPolicy: () => ({
          freshUntil: '2026-09-10T01:00:00.000Z',
          expiresAt: '2026-09-10T03:00:00.000Z',
          retention: ALLOW_RETENTION,
        }),
        routeObservationPolicy: () => ({
          freshUntil: '2026-09-10T01:00:00.000Z',
          expiresAt: '2026-09-10T03:00:00.000Z',
          retention: ALLOW_RETENTION,
        }),
        modelContextFieldPolicy: ALLOW_MODEL_CONTEXT_FIELDS,
        currentOriginRefFor: () => 'current-location',
        clock: () => NOW,
        monotonicNow: () => 0,
        epochNow: () => 1_000,
      },
    });
    if (options === undefined) throw new Error('production factory should be configured');

    const composition = await options.buildTurn({
      ...buildRequest,
      turnId: 'turn-production-route',
      runtimeInput: routeRequest,
    });
    expect(composition.turn.context.capabilities).toMatchObject({
      walkingRoute: true,
      detailFields: ['identity', 'opening_hours', 'price', 'walking_route'],
      lastTrain: false,
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
      { toolCallId: 'sdk-production-route-search' },
    );
    if (searched.status !== 'ok') throw new Error('route search failed');
    const candidateId = searched.data.candidates[0]?.candidateId;
    if (candidateId === undefined) throw new Error('route candidate missing');
    const details = await invokePublicToolEnvelope(
      'get_place_details',
      {
        input: { requests: [{ candidateId, fields: ['walking_route'] }], freshness: 'refresh' },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'sdk-production-route-details' },
    );
    expect(details.status).toBe('ok');
    if (details.status !== 'ok') throw new Error('route details failed');
    expect(details.data.items[0]?.fields.walking_route).toMatchObject({
      status: 'known',
      observations: [{ value: { durationSeconds: 90, distanceMeters: 300 } }],
    });
    const candidate = searched.data.candidates[0];
    const walking = details.data.items[0]?.fields.walking_route;
    const identityObservation =
      candidate?.identity.status === 'known' ? candidate.identity.observations[0] : undefined;
    const openingObservation =
      candidate?.openingHours.status === 'known'
        ? candidate.openingHours.observations[0]
        : undefined;
    const walkingObservation = walking?.status === 'known' ? walking.observations[0] : undefined;
    if (
      candidate === undefined ||
      candidate.identity.status !== 'known' ||
      candidate.openingHours.status !== 'known' ||
      walking?.status !== 'known' ||
      identityObservation === undefined ||
      openingObservation === undefined ||
      walkingObservation === undefined
    ) {
      throw new Error('route submit evidence fields were not known');
    }
    const submit = await invokePublicToolEnvelope(
      'submit_cards',
      {
        input: {
          message: [
            {
              text: 'Route Cafeを提案します',
              evidenceIds: [identityObservation.observationId],
              basis: 'grounded',
            },
          ],
          hero: {
            candidateId: candidate.candidateId,
            evidenceIds: [
              identityObservation.observationId,
              openingObservation.observationId,
              walkingObservation.observationId,
            ],
            why: {
              text: '現在地から徒歩圏内です',
              evidenceIds: [walkingObservation.observationId],
              basis: 'grounded',
            },
          },
          alts: [],
        },
        metadata: {},
      },
      composition.turn.dependencies,
      { toolCallId: 'sdk-production-route-submit' },
    );
    expect(submit.status).toBe('committed');
    expect(composition.turn.budget.snapshot()).toMatchObject({
      readCalls: 3,
      providerHttpRequests: 2,
      costUnits: 3,
      routeElements: 1,
    });
    expect(requests.some((request) => request.url.includes('computeRouteMatrix'))).toBe(true);
    composition.dispose();
  });
});
