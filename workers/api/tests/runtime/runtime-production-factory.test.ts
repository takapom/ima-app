import type { ThreadTurnRequest } from '@ima/contracts';
import type { CommitPort, ModelContextFieldPolicy, RetentionMetadata } from '@ima/core';
import { describe, expect, it } from 'vitest';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '../../src/model/provider-options';
import { createRuntimeProductionConnectionOptions } from '../../src/runtime/runtime-production-factory';
import { invokePublicToolEnvelope } from '../../src/tools';
import { modelFor, type RuntimeGateModelReport } from '../runtime-gate/runtime-gate-provider';

const NOW = '2026-09-10T00:00:00.000Z';

const ALLOW_RETENTION = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T04:00:00.000Z',
  freshUntil: '2026-09-10T01:00:00.000Z',
  displayUntil: '2026-09-10T02:00:00.000Z',
  retentionUntil: '2026-09-10T03:00:00.000Z',
  deletionScheduledAt: '2026-09-10T03:00:00.000Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
} satisfies RetentionMetadata;

const ALLOW_MODEL_CONTEXT_FIELDS: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    photos: 'allow',
    contact: 'allow',
    facilities: 'allow',
    walking_route: 'allow',
    last_train: 'allow',
  },
  history: 'deny',
  cardSet: 'deny',
  displayName: 'deny',
};

const requestInput: ThreadTurnRequest = {
  schemaVersion: 'v1',
  requestId: 'request-production-factory',
  turnId: 'turn-production-factory',
  revision: 1,
  text: '静かなカフェを探して',
  clientNow: NOW,
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: null,
    budget: 'normal',
  },
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: 'idempotency-production-factory',
};

const buildRequest = {
  ownerScopeRef: 'owner-production-factory',
  threadId: 'thread-production-factory',
  turnId: 'turn-production-factory',
  revision: 1,
  messages: [],
  runtimeInput: requestInput,
  serverNow: NOW,
};

const commit: CommitPort = {
  commit: () => ({
    status: 'conflict',
    conflict: { code: 'STALE_REVISION', message: 'read-only factory test' },
  }),
};

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
      detailFields: [],
      supportedScopes: [],
    });
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
        OPENAI_API_KEY: 'openai-test-key',
        GOOGLE_PLACES_API_KEY: 'google-test-key',
        PLACES_CURSOR_SECRET: 'cursor-test-secret-16',
      },
      commit,
      overrides: {
        modelForTurn: modelFor('search', report),
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
});
