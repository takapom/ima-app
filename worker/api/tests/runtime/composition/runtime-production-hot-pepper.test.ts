import type { ThreadTurnRequest } from '@ima/contracts';
import { describe, expect, it, vi } from 'vitest';
import { invokePublicToolEnvelope } from '@api/tools';
import { createRuntimeProductionConnectionOptions } from '@api/runtime/composition/runtime-production-factory';
import { createDevFixtureModel } from '@api/runtime/composition/runtime-dev-fixture';
import { fixturePlace } from '@api/runtime/composition/runtime-dev-fixture-place';
import {
  NOW,
  buildRequest,
  readOnlyCommit,
  FIXTURE_OPERATIONAL_ENV,
} from './runtime-production-factory-fixtures';
import type { RuntimeProviderTrace } from '@api/providers/telemetry/runtime-provider-trace';

const searchInput = {
  mode: 'search',
  query: 'カフェ',
  area: { kind: 'named_area', name: '恵比寿' },
  openNow: false,
  limit: 1,
  excludeCandidateIds: [],
};
const setup = async (
  response?: (request: URL) => Response,
  runtimeInput: ThreadTurnRequest = buildRequest.runtimeInput,
) => {
  let current = NOW;
  const requests: URL[] = [];
  const traces: RuntimeProviderTrace[] = [];
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(new Request(input, init).url);
    requests.push(url);
    expect(url.origin).toBe('https://webservice.recruit.co.jp');
    expect(url.pathname).toBe('/hotpepper/gourmet/v1/');
    return Promise.resolve(
      response?.(url) ??
        Response.json({
          results: {
            shop: [fixturePlace(() => current)],
            results_available: 1,
            results_start: 1,
          },
        }),
    );
  });
  const factory = createRuntimeProductionConnectionOptions({
    env: FIXTURE_OPERATIONAL_ENV,
    commit: readOnlyCommit,
    overrides: {
      modelForTurn: createDevFixtureModel(),
      hotPepperApiKey: 'hp-test-secret',
      placesCursorSecret: 'hp-cursor-secret',
      fetcher,
      clock: () => current,
      monotonicNow: () => 0,
      epochNow: () => 1000,
      providerTraceSink: (trace) => {
        traces.push(trace);
      },
    },
  });
  if (factory === undefined) throw new Error('Factory is unavailable');
  const composition = await factory.buildTurn({ ...buildRequest, runtimeInput });
  let calls = 0;
  const search = (input: unknown = searchInput) =>
    invokePublicToolEnvelope(
      'search_places',
      { input, metadata: {} },
      composition.turn.dependencies,
      { toolCallId: `search-${++calls}` },
    );
  const details = (
    candidateId: string,
    fields = ['identity', 'opening_hours', 'price'],
    freshness = 'refresh',
  ) =>
    invokePublicToolEnvelope(
      'get_place_details',
      { input: { requests: [{ candidateId, fields }], freshness }, metadata: {} },
      composition.turn.dependencies,
      { toolCallId: `details-${++calls}` },
    );
  return {
    composition,
    search,
    details,
    requests,
    traces,
    fetcher,
    advance: () => {
      current = '2026-09-10T00:01:00.000Z';
    },
  };
};

describe('Hot Pepper primary provider composition', () => {
  it('searches by keyword and area, refreshes by exact shop ID, and preserves attribution and unknown opening status', async () => {
    const f = await setup();
    const searched = await f.search();
    expect(searched.status).toBe('ok');
    if (searched.status !== 'ok') throw new Error('Search failed');
    const candidate = searched.data.candidates[0];
    if (candidate === undefined) throw new Error('Candidate missing');
    expect(f.requests[0]?.searchParams.get('keyword')).toBe('カフェ 恵比寿');
    expect(f.requests[0]?.searchParams.get('key')).toBe('hp-test-secret');
    expect(candidate.openingHours).toMatchObject({
      status: 'known',
      observations: [
        {
          value: {
            intervals: [],
            listedOpenAtEvaluation: null,
            nextBoundaryAt: null,
            lastOrderAt: null,
            weeklyText: ['24時間営業', '定休日: なし'],
          },
        },
      ],
    });
    expect(candidate.price).toMatchObject({
      status: 'known',
      observations: [{ value: { range: null, level: null } }],
    });
    f.advance();
    const details = await f.details(candidate.candidateId, [
      'identity',
      'opening_hours',
      'price',
      'facilities',
    ]);
    expect(details.status).toBe('ok');
    if (details.status !== 'ok') throw new Error('Details failed');
    expect(f.requests[1]?.searchParams.get('id')).toBe('dev-fixture-place');
    const hours = details.data.items[0]?.fields.opening_hours;
    if (hours?.status !== 'known') throw new Error('Hours missing');
    expect(await f.details(candidate.candidateId, ['opening_hours'], 'reuse_valid')).toMatchObject({
      status: 'ok',
    });
    expect(hours.observations[0]?.sources).toContainEqual(
      expect.objectContaining({
        provider: 'hotpepper',
        attribution: 'Powered by ホットペッパーグルメ Webサービス',
        publicUrl: 'https://webservice.recruit.co.jp/',
      }),
    );
    expect(f.traces).toHaveLength(2);
    expect(f.traces.every((t) => t.provider === 'hotpepper')).toBe(true);
    expect(JSON.stringify(f.traces)).not.toContain('hp-test-secret');
    expect(f.composition.turn.budget.snapshot().providerHttpRequests).toBe(2);
    f.composition.dispose();
  });

  it('reuses valid observations without HTTP and leaves unsupported fields distinct', async () => {
    const f = await setup();
    const searched = await f.search();
    if (searched.status !== 'ok') throw new Error('Search failed');
    const id = searched.data.candidates[0]?.candidateId;
    if (id === undefined) throw new Error('Candidate missing');
    const result = await f.details(id, ['identity'], 'reuse_valid');
    expect(result).toMatchObject({
      status: 'ok',
      data: { items: [{ fields: { identity: { status: 'known' } } }] },
    });
    expect(await f.details(id, ['photos', 'walking_route'])).toMatchObject({
      status: 'error',
      error: { code: 'UNSUPPORTED_FIELD' },
    });
    expect(f.requests).toHaveLength(1);
    expect(f.composition.turn.budget.snapshot().providerHttpRequests).toBe(1);
    f.composition.dispose();
  });

  it('uses coordinates and the next larger API range while enforcing the requested radius', async () => {
    const shop = fixturePlace(() => NOW);
    const f = await setup(
      () =>
        Response.json({
          results: {
            shop: [shop, { ...shop, id: 'outside-radius', lat: 35.6667 }],
            results_available: 2,
          },
        }),
      {
        ...buildRequest.runtimeInput,
        location: {
          status: 'available',
          lat: 35.6467,
          lng: 139.7102,
          accuracyMeters: 20,
          precise: true,
          capturedAt: NOW,
        },
      },
    );
    const result = await f.search({
      ...searchInput,
      limit: 3,
      area: { kind: 'current_location', radiusMeters: 600 },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('Search failed');
    expect(result.data.candidates).toHaveLength(1);
    expect(f.requests[0]?.searchParams.get('lat')).toBe('35.6467');
    expect(f.requests[0]?.searchParams.get('lng')).toBe('139.7102');
    expect(f.requests[0]?.searchParams.get('range')).toBe('3');
    f.composition.dispose();
  });

  it('rejects a detail response for another shop', async () => {
    const f = await setup((url) =>
      Response.json({
        results: {
          shop: [
            {
              ...fixturePlace(() => NOW),
              ...(url.searchParams.has('id') ? { id: 'wrong-shop' } : {}),
            },
          ],
        },
      }),
    );
    const result = await f.search();
    if (result.status !== 'ok') throw new Error('Search failed');
    const id = result.data.candidates[0]?.candidateId;
    if (id === undefined) throw new Error('Candidate missing');
    expect(await f.details(id, ['identity'])).toMatchObject({
      status: 'partial',
      data: {
        items: [
          {
            fields: {
              identity: { status: 'error', error: { code: 'SOURCE_CONFLICT' } },
            },
          },
        ],
      },
    });
    f.composition.dispose();
  });

  it('distinguishes zero results from upstream failure', async () => {
    const empty = await setup(() => Response.json({ results: { shop: [], results_available: 0 } }));
    expect(await empty.search()).toMatchObject({
      status: 'ok',
      data: { candidates: [], nextCursor: null },
    });
    empty.composition.dispose();
    const failed = await setup(() => new Response(null, { status: 401 }));
    expect(await failed.search()).toMatchObject({
      status: 'error',
      error: { code: 'UPSTREAM_UNAVAILABLE' },
    });
    failed.composition.dispose();
  });

  it('rejects open-now and missing location without an upstream call', async () => {
    const f = await setup();
    expect(await f.search({ ...searchInput, openNow: true })).toMatchObject({
      status: 'error',
      error: { code: 'UNSUPPORTED_FIELD' },
    });
    expect(
      await f.search({ ...searchInput, area: { kind: 'current_location', radiusMeters: 500 } }),
    ).toMatchObject({ status: 'error', error: { code: 'LOCATION_REQUIRED' } });
    expect(f.requests).toHaveLength(0);
    f.composition.dispose();
  });

  it('continues with the signed original query and rejects tampered cursors', async () => {
    const f = await setup(() =>
      Response.json({ results: { shop: [fixturePlace(() => NOW)], results_available: 2 } }),
    );
    const first = await f.search();
    if (first.status !== 'ok') throw new Error('Search failed');
    expect(first.data.nextCursor).toBeTypeOf('string');
    expect(await f.search({ mode: 'continue', cursor: first.data.nextCursor })).toMatchObject({
      status: 'ok',
    });
    expect(f.requests[1]?.searchParams.get('start')).toBe('2');
    expect(f.requests[1]?.searchParams.get('keyword')).toBe('カフェ 恵比寿');
    expect(await f.search({ mode: 'continue', cursor: 'tampered' })).toMatchObject({
      status: 'error',
    });
    expect(f.requests).toHaveLength(2);
    f.composition.dispose();
  });

  it('rejects unknown candidates without HTTP and invalidates stale data after a failed refresh', async () => {
    const f = await setup((url) =>
      url.searchParams.has('id')
        ? new Response(null, { status: 503 })
        : Response.json({ results: { shop: [fixturePlace(() => NOW)] } }),
    );
    expect(await f.details('unknown-candidate')).toMatchObject({
      status: 'error',
      error: { code: 'UNKNOWN_CANDIDATE' },
    });
    expect(f.requests).toHaveLength(0);
    const search = await f.search();
    if (search.status !== 'ok') throw new Error('Search failed');
    const id = search.data.candidates[0]?.candidateId;
    if (id === undefined) throw new Error('Candidate missing');
    expect(await f.details(id, ['identity'])).toMatchObject({ status: 'partial' });
    const callsBeforeReuse = f.requests.length;
    expect(await f.details(id, ['identity'], 'reuse_valid')).toMatchObject({ status: 'partial' });
    expect(f.requests.length).toBeGreaterThan(callsBeforeReuse);
    f.composition.dispose();
  });
});
