import type { RetentionMetadata } from '@ima/core';
import { describe, expect, it } from 'vitest';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '../../src/model/provider-options';
import { createRuntimeProductionConnectionOptions } from '../../src/runtime/composition/runtime-production-factory';
import { invokePublicToolEnvelope } from '../../src/tools';
import { modelFor, type RuntimeGateModelReport } from '../support/runtime-model-fixture';
import {
  ALLOW_MODEL_CONTEXT_FIELDS,
  ALLOW_RETENTION,
  FIXTURE_OPERATIONAL_ENV,
  NOW,
  buildRequest,
  readOnlyCommit as commit,
  requestInput,
} from './runtime-production-factory-fixtures';

describe('production runtime factory', () => {
  it('fails closed until model and provider secrets are configured', () => {
    expect(createRuntimeProductionConnectionOptions({ env: {}, commit })).toBeUndefined();
  });

  it('builds the default Core registry and real Places ports with a mock fetcher', async () => {
    const report: RuntimeGateModelReport = { calls: 0, requests: [] };
    const requests: Request[] = [];
    const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            places: [
              {
                id: 'place-production-factory',
                displayName: { text: 'Factory Cafe' },
                formattedAddress: '東京都渋谷区',
                primaryType: 'cafe',
                businessStatus: 'OPERATIONAL',
                googleMapsUri: 'https://maps.google.com/?cid=production-factory',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const options = createRuntimeProductionConnectionOptions({
      env: {
        ...FIXTURE_OPERATIONAL_ENV,
        OPENAI_API_KEY: 'openai-test-key',
        GOOGLE_PLACES_API_KEY: 'google-test-key',
        PLACES_CURSOR_SECRET: 'cursor-test-secret-16',
      },
      commit,
      overrides: {
        modelForTurn: modelFor('search', report),
        fetcher,
        clock: () => NOW,
        monotonicNow: () => 0,
        epochNow: () => 1_000,
      },
    });
    if (options === undefined) throw new Error('production factory should be configured');

    const composition = await options.buildTurn(buildRequest);
    expect(composition.providerOptions).toEqual(OPENAI_PROVIDER_REQUEST_OPTIONS);
    expect(composition.turn.context.capabilities).toMatchObject({
      detailFields: ['identity', 'opening_hours', 'price'],
      supportedScopes: ['runtime-production'],
    });
    expect(composition.turn.context.capabilities.walkingRoute).toBe(false);
    const result = await invokePublicToolEnvelope(
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
      { toolCallId: 'sdk-production-search' },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('search result was not successful');
    expect(result.data.candidates).toHaveLength(1);
    expect(result.data.candidates[0]?.identity.status).toBe('withheld');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(requests[0]?.headers.get('x-goog-api-key')).toBe('google-test-key');
    expect(requests[0]?.headers.get('x-goog-fieldmask')).toContain('places.id');
    expect(composition.turn.budget.snapshot()).toMatchObject({
      readCalls: 1,
      providerHttpRequests: 1,
      costUnits: 1,
    });
    composition.dispose();
  });

  it('keeps production Photos closed until a verified display policy is supplied', async () => {
    const report: RuntimeGateModelReport = { calls: 0, requests: [] };
    const photoRpc = {
      putPhotoReference: () => Promise.resolve({ ok: true as const }),
      getPhotoReference: () => Promise.resolve({ ok: true as const, record: null }),
    };
    const env = {
      ...FIXTURE_OPERATIONAL_ENV,
      IMA_RUNTIME_MODE: 'live',
      OPENAI_API_KEY: 'openai-test-key',
      GOOGLE_PLACES_API_KEY: 'google-test-key',
      PLACES_CURSOR_SECRET: 'cursor-test-secret-16',
      THREADS: { getByName: () => photoRpc },
    };
    const base = {
      modelForTurn: modelFor('search', report),
      placesEnabled: true,
      photoTokenSecret: 'photo-production-factory-secret',
      photosEnabled: true,
      clock: () => NOW,
      monotonicNow: () => 0,
      epochNow: () => 1_000,
    } as const;
    const withoutPolicy = createRuntimeProductionConnectionOptions({
      env,
      commit,
      overrides: base,
    });
    if (withoutPolicy === undefined) throw new Error('production factory should be configured');
    const closed = await withoutPolicy.buildTurn({
      ...buildRequest,
      deviceId: 'photo-device-production-factory',
    });
    expect(closed.turn.context.capabilities.detailFields).not.toContain('photos');
    closed.dispose();

    const livePolicy = () => ({
      policy: {
        llm_input: {
          decision: 'deny' as const,
          activation: 'live_verified' as const,
          fieldStatus: 'known' as const,
          policyStatus: 'available' as const,
        },
        display: {
          decision: 'allow' as const,
          activation: 'live_verified' as const,
          fieldStatus: 'known' as const,
          policyStatus: 'available' as const,
        },
        persistence: {
          decision: 'deny' as const,
          activation: 'live_verified' as const,
          fieldStatus: 'known' as const,
          policyStatus: 'available' as const,
        },
      },
      mode: 'live' as const,
    });
    const withPolicy = createRuntimeProductionConnectionOptions({
      env,
      commit,
      overrides: { ...base, photoDisplayPolicyFor: livePolicy },
    });
    if (withPolicy === undefined) throw new Error('production factory should be configured');
    const open = await withPolicy.buildTurn({
      ...buildRequest,
      deviceId: 'photo-device-production-factory',
    });
    expect(open.turn.context.capabilities.detailFields).toContain('photos');
    open.dispose();
  });

  it('keeps search provenance for a later Details turn and gates capabilities on policy', async () => {
    const report: RuntimeGateModelReport = { calls: 0, requests: [] };
    const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      if (request.url.endsWith('/v1/places:searchText')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              places: [
                {
                  id: 'place-production-provenance',
                  displayName: { text: 'Provenance Cafe' },
                  formattedAddress: '東京都渋谷区',
                  primaryType: 'cafe',
                  businessStatus: 'OPERATIONAL',
                  googleMapsUri: 'https://maps.google.com/?cid=production-provenance',
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'place-production-provenance',
            displayName: { text: 'Provenance Cafe' },
            formattedAddress: '東京都渋谷区',
            primaryType: 'cafe',
            businessStatus: 'OPERATIONAL',
            googleMapsUri: 'https://maps.google.com/?cid=production-provenance',
          }),
          { status: 200 },
        ),
      );
    };
    const policy = () => ({
      freshUntil: ALLOW_RETENTION.freshUntil,
      expiresAt: ALLOW_RETENTION.retentionUntil,
      retention: ALLOW_RETENTION,
    });
    const options = createRuntimeProductionConnectionOptions({
      env: {
        ...FIXTURE_OPERATIONAL_ENV,
        OPENAI_API_KEY: 'openai-test-key',
        GOOGLE_PLACES_API_KEY: 'google-test-key',
        PLACES_CURSOR_SECRET: 'cursor-test-secret-16',
      },
      commit,
      overrides: {
        modelForTurn: modelFor('search', report),
        fetcher,
        observationPolicy: policy,
        detailsObservationPolicy: policy,
        placesEnabled: true,
        retention: ALLOW_RETENTION,
        modelContextFieldPolicy: ALLOW_MODEL_CONTEXT_FIELDS,
        clock: () => NOW,
        monotonicNow: () => 0,
        epochNow: () => 1_000,
      },
    });
    if (options === undefined) throw new Error('production factory should be configured');

    const first = await options.buildTurn(buildRequest);
    expect(first.turn.context.capabilities.detailFields).toEqual([
      'identity',
      'opening_hours',
      'price',
    ]);
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
      first.turn.dependencies,
      { toolCallId: 'sdk-production-provenance-search' },
    );
    if (searched.status !== 'ok') throw new Error('provenance search failed');
    const candidateId = searched.data.candidates[0]?.candidateId;
    if (candidateId === undefined) throw new Error('provenance candidate missing');
    first.dispose();

    const second = await options.buildTurn({
      ...buildRequest,
      turnId: 'turn-production-provenance-2',
      revision: 2,
      serverNow: NOW,
      runtimeInput: {
        ...requestInput,
        requestId: 'request-production-provenance-2',
        turnId: 'turn-production-provenance-2',
        revision: 2,
        prefs: { ...requestInput.prefs, areaText: '誤った地域' },
      },
    });
    const details = await invokePublicToolEnvelope(
      'get_place_details',
      {
        input: {
          requests: [{ candidateId, fields: ['identity'] }],
          freshness: 'refresh',
        },
        metadata: {},
      },
      second.turn.dependencies,
      { toolCallId: 'sdk-production-provenance-details' },
    );
    expect(details.status).toBe('ok');
    if (details.status !== 'ok') throw new Error('provenance details failed');
    const identity = details.data.items[0]?.fields.identity;
    expect(identity?.status).toBe('known');
    if (identity?.status === 'known') {
      expect(identity.observations[0]?.value.area).toBe('渋谷');
    }
    second.dispose();
  });

  it('keeps the thread-created 05:00 JST expiry across later turns', async () => {
    const report: RuntimeGateModelReport = { calls: 0, requests: [] };
    const lateRetention = {
      ...ALLOW_RETENTION,
      sessionExpiresAt: '2026-09-12T20:00:00.000Z',
      freshUntil: '2026-09-11T20:00:00.000Z',
      displayUntil: '2026-09-11T21:00:00.000Z',
      retentionUntil: '2026-09-12T20:00:00.000Z',
      deletionScheduledAt: '2026-09-12T20:00:00.000Z',
    } satisfies RetentionMetadata;
    const options = createRuntimeProductionConnectionOptions({
      env: {
        ...FIXTURE_OPERATIONAL_ENV,
        OPENAI_API_KEY: 'openai-test-key',
        GOOGLE_PLACES_API_KEY: 'google-test-key',
        PLACES_CURSOR_SECRET: 'cursor-test-secret-16',
      },
      commit,
      overrides: {
        modelForTurn: modelFor('search', report),
        placesEnabled: false,
        googlePlacesApiKey: 'google-test-key',
        placesCursorSecret: 'cursor-test-secret-16',
        retention: lateRetention,
        threadCreatedAt: '2026-09-10T19:59:00.000Z',
        clock: () => '2026-09-10T20:01:00.000Z',
        monotonicNow: () => 0,
        epochNow: () => 1_000,
      },
    });
    if (options === undefined) throw new Error('production factory should be configured');

    const first = await options.buildTurn({
      ...buildRequest,
      serverNow: '2026-09-10T19:59:00.000Z',
    });
    const second = await options.buildTurn({
      ...buildRequest,
      turnId: 'turn-production-factory-05jst-2',
      revision: 2,
      serverNow: '2026-09-10T20:01:00.000Z',
      runtimeInput: {
        ...requestInput,
        turnId: 'turn-production-factory-05jst-2',
        revision: 2,
      },
    });
    const firstContext =
      typeof first.retention.context === 'function'
        ? first.retention.context()
        : first.retention.context;
    const secondContext =
      typeof second.retention.context === 'function'
        ? second.retention.context()
        : second.retention.context;
    expect(firstContext.retention.sessionExpiresAt).toBe('2026-09-10T20:00:00.000Z');
    expect(secondContext.retention.sessionExpiresAt).toBe(firstContext.retention.sessionExpiresAt);
    expect(secondContext.retention.retentionUntil).toBe('2026-09-10T20:00:00.000Z');
    first.dispose();
    second.dispose();
  });

  it('does not create a runtime when the OpenAI capability is disabled', () => {
    expect(
      createRuntimeProductionConnectionOptions({
        env: {
          ...FIXTURE_OPERATIONAL_ENV,
          IMA_PROVIDER_OPENAI: 'false',
          OPENAI_API_KEY: 'openai-test-key',
          GOOGLE_PLACES_API_KEY: 'google-test-key',
          PLACES_CURSOR_SECRET: 'cursor-test-secret-16',
        },
        commit,
        overrides: { modelForTurn: modelFor('search', { calls: 0, requests: [] }) },
      }),
    ).toBeUndefined();
  });

  it('returns a typed disabled result without invoking Places when its flag is off', async () => {
    let fetchCalls = 0;
    const options = createRuntimeProductionConnectionOptions({
      env: {
        ...FIXTURE_OPERATIONAL_ENV,
        IMA_PROVIDER_PLACES: 'false',
        OPENAI_API_KEY: 'openai-test-key',
        GOOGLE_PLACES_API_KEY: 'google-test-key',
        PLACES_CURSOR_SECRET: 'cursor-test-secret-16',
      },
      commit,
      overrides: {
        modelForTurn: modelFor('search', { calls: 0, requests: [] }),
        fetcher: () => {
          fetchCalls += 1;
          return Promise.reject(new Error('disabled Places must not fetch'));
        },
        clock: () => NOW,
        monotonicNow: () => 0,
        epochNow: () => 1_000,
      },
    });
    if (options === undefined) throw new Error('production factory should be configured');
    const composition = await options.buildTurn(buildRequest);
    expect(composition.turn.context.capabilities.detailFields).toEqual([]);
    const result = await invokePublicToolEnvelope(
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
      { toolCallId: 'sdk-disabled-search' },
    );
    expect(result.status).toBe('error');
    expect(fetchCalls).toBe(0);
    composition.dispose();
  });

  it('does not let fixture Routes fall through to global fetch', () => {
    const options = createRuntimeProductionConnectionOptions({
      env: {
        ...FIXTURE_OPERATIONAL_ENV,
        IMA_PROVIDER_PLACES: 'false',
        IMA_PROVIDER_ROUTES: 'true',
        OPENAI_API_KEY: 'openai-test-key',
        GOOGLE_ROUTES_API_KEY: 'routes-test-key',
      },
      commit,
      overrides: {
        modelForTurn: modelFor('search', { calls: 0, requests: [] }),
        routesEnabled: true,
        routeObservationPolicy: () => ({
          freshUntil: '2026-09-10T01:00:00.000Z',
          expiresAt: '2026-09-10T03:00:00.000Z',
          retention: ALLOW_RETENTION,
        }),
        currentOriginRefFor: () => 'current-location',
      },
    });
    expect(options).toBeUndefined();
  });

  it('does not read the journey dataset when LastTrain is disabled', async () => {
    let revisionReads = 0;
    const options = createRuntimeProductionConnectionOptions({
      env: {
        ...FIXTURE_OPERATIONAL_ENV,
        IMA_PROVIDER_PLACES: 'false',
        IMA_PROVIDER_ROUTES: 'false',
        IMA_PROVIDER_LAST_TRAIN: 'false',
        OPENAI_API_KEY: 'openai-test-key',
      },
      commit,
      overrides: {
        modelForTurn: modelFor('search', { calls: 0, requests: [] }),
        lastTrainEnabled: false,
        journeyDataset: {
          readRevision: () => {
            revisionReads += 1;
            return Promise.resolve(7);
          },
          read: () => Promise.reject(new Error('disabled LastTrain must not read journeys')),
        },
      },
    });
    if (options === undefined) throw new Error('production factory should be configured');

    const composition = await options.buildTurn(buildRequest);
    expect(revisionReads).toBe(0);
    expect(composition.turn.context.capabilities.lastTrain).toBe(false);
    composition.dispose();
  });
});
