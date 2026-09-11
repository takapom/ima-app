import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  OpeningHoursSchema,
  type GetPlaceDetailsInput,
  type GetPlaceDetailsOutput,
  type PlaceDetailsPort,
  type RetentionMetadata,
} from '@ima/core';
import { createHotPepperAdapter } from '../../../src/providers/hot-pepper/adapter';
import { createHotPepperDetailsOverlay } from '../../../src/providers/hot-pepper/composition';
import {
  intersectHotPepperOpeningRetention,
  mergeHotPepperOpeningHours,
} from '../../../src/providers/hot-pepper/opening-hours';
import { reprojectHotPepperField } from '../../../src/providers/hot-pepper/policy-projection';
import type { HotPepperField, HotPepperFieldPolicy } from '../../../src/providers/hot-pepper/types';
import type { HotPepperTransport } from '../../../src/providers/hot-pepper/transport';
import {
  parseHotPepperResponse,
  type HotPepperSearchPage,
  type HotPepperShopWire,
} from '../../../src/providers/hot-pepper/wire';
import type { PlacesDetailsObservationPolicy } from '../../../src/providers/places-details/adapter-types';
import {
  context,
  execution,
  makeFixture,
  readInput,
  SCOPE,
} from '../places-details/adapter-fixtures';

const baseOpening = {
  timeZone: 'Asia/Tokyo',
  intervals: [
    {
      startAt: '2026-09-10T00:00:00.000Z',
      endAt: '2026-09-10T09:00:00.000Z',
    },
  ],
  weeklyText: ['毎日 9:00–18:00'],
  evaluatedAt: '2026-09-10T02:00:00.000Z',
  listedOpenAtEvaluation: true,
  nextBoundaryAt: '2026-09-10T09:00:00.000Z',
  lastOrderAt: null,
  lastOrderRaw: null,
};

const hpPolicy: HotPepperFieldPolicy = (field: HotPepperField, use) => ({
  decision:
    (field === 'source' && use === 'attribution') ||
    (field === 'opening_hours' && ['llm_input', 'display', 'persistence'].includes(use))
      ? 'allow'
      : 'deny',
  activation: 'fixture_only',
});

const baseRetention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-11T00:00:00.000Z',
  freshUntil: '2026-09-10T08:00:00.000Z',
  displayUntil: '2026-09-10T08:30:00.000Z',
  retentionUntil: '2026-09-10T09:00:00.000Z',
  deletionScheduledAt: '2026-09-10T09:00:00.000Z',
  attribution: { label: 'ホットペッパー', sourceLink: 'https://www.hotpepper.jp' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const observationPolicy: PlacesDetailsObservationPolicy = () => ({
  freshUntil: '2026-09-10T08:00:00.000Z',
  expiresAt: '2026-09-10T09:00:00.000Z',
  retention: baseRetention,
});

const shopFor = (open: string): HotPepperShopWire => {
  const parsed = parseHotPepperResponse({
    results: {
      shop: [
        {
          id: 'hp-opening-cafe',
          name: '候補 place-a',
          lat: 35.6595,
          lng: 139.7005,
          open,
          close: '無休',
          budget: { name: '昼 1000円', average: '夜 3000円' },
          urls: { pc: 'https://www.hotpepper.jp/strJ000000001' },
          wifi: 'あり',
          non_smoking: 'なし',
          private_room: '一部',
          parking: 'あり',
        },
      ],
    },
  });
  const shop = parsed.shops[0];
  if (shop === undefined) throw new Error('opening-hours fixture shop is missing');
  return shop;
};

type OpeningFixture = {
  readonly candidateId: string;
  readonly calls: HotPepperSearchPage[];
  readonly read: (input: GetPlaceDetailsInput) => ReturnType<PlaceDetailsPort['read']>;
  readonly hpObservationCount: () => number;
};

type OpeningFixtureOptions = {
  readonly transport?: HotPepperTransport;
  readonly mutateOpening?: (
    value: Extract<
      NonNullable<GetPlaceDetailsOutput['items'][number]['fields']['opening_hours']>,
      {
        status: 'known';
      }
    >,
  ) => Extract<
    NonNullable<GetPlaceDetailsOutput['items'][number]['fields']['opening_hours']>,
    {
      status: 'known';
    }
  >;
};

const fixtureFor = (
  shop: HotPepperShopWire,
  options: OpeningFixtureOptions = {},
): OpeningFixture => {
  const fixture = makeFixture();
  const candidateId = fixture.candidateIds[0];
  if (candidateId === undefined) throw new Error('opening-hours candidate is missing');
  const calls: HotPepperSearchPage[] = [];
  const configuredTransport =
    options.transport ??
    ({
      search: () => Promise.resolve({ shops: [shop], resultsAvailable: 1, resultsStart: 1 }),
    } satisfies HotPepperTransport);
  const transport: HotPepperTransport = {
    search: async (request, signal) => {
      const page = await configuredTransport.search(request, signal);
      calls.push(page);
      return page;
    },
  };
  const adapter = createHotPepperAdapter({
    transport,
    mode: 'fixture',
    policy: hpPolicy,
    providerInputPolicy: () => ({ decision: 'allow', activation: 'fixture_only' }),
  });
  const mutateOpening = options.mutateOpening;
  const inner: PlaceDetailsPort =
    mutateOpening === undefined
      ? fixture.adapter
      : {
          read: async (input, readContext, readExecution, cancellation) => {
            const result = await fixture.adapter.read(
              input,
              readContext,
              readExecution,
              cancellation,
            );
            if (result.status === 'error') return result;
            return {
              ...result,
              data: {
                ...result.data,
                items: result.data.items.map((item) =>
                  item.candidateId !== candidateId
                    ? item
                    : item.fields.opening_hours?.status !== 'known'
                      ? item
                      : {
                          ...item,
                          fields: {
                            ...item.fields,
                            opening_hours: mutateOpening(item.fields.opening_hours),
                          },
                        },
                ),
              },
            };
          },
        };
  const overlay = createHotPepperDetailsOverlay({
    inner,
    adapter,
    registry: fixture.registry,
    clock: fixture.clock,
    observationPolicy,
    fieldPolicy: hpPolicy,
    candidateReferenceFor: (candidate) => ({
      candidateId: candidate.candidateId,
      name: candidate.displayName,
      lat: 35.6595,
      lng: 139.7005,
    }),
    reserveProviderRequest: () => true,
  });
  return {
    candidateId,
    calls,
    read: (input) => overlay.read(input, context, execution, { isCancelled: () => false }),
    hpObservationCount: () =>
      fixture.registry
        .listObservations(SCOPE, candidateId)
        .filter((observation) =>
          observation.sources.some((source) => source.provider === 'hotpepper'),
        ).length,
  };
};

describe('Hot Pepper opening-hours composition', () => {
  it('adds only explicit LO text and preserves Google intervals and sources', async () => {
    const fixture = fixtureFor(shopFor('11:00〜22:00（料理L.O. 21:00）'));
    const result = await fixture.read(readInput(fixture.candidateId, ['opening_hours']));

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const opening = result.data.items[0]?.fields.opening_hours;
    expect(opening).toMatchObject({
      status: 'known',
      observations: [
        {
          value: {
            lastOrderRaw: '料理L.O. 21:00',
            lastOrderAt: null,
            intervals: baseOpening.intervals,
            weeklyText: baseOpening.weeklyText,
          },
          sources: [{ provider: 'google_places' }, { provider: 'hotpepper' }],
          retention: {
            freshUntil: '2026-09-10T08:00:00.000Z',
            displayUntil: '2026-09-10T08:30:00.000Z',
            retentionUntil: '2026-09-10T09:00:00.000Z',
          },
        },
      ],
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.hpObservationCount()).toBe(1);
  });

  it('keeps the original Google observation when LO is unknown or the HP read fails', async () => {
    const unknown = fixtureFor(shopFor('11:00〜22:00'));
    const unknownResult = await unknown.read(readInput(unknown.candidateId, ['opening_hours']));
    expect(unknownResult.status).toBe('ok');
    expect(unknown.hpObservationCount()).toBe(0);

    const failed = fixtureFor(shopFor('11:00〜22:00（料理L.O. 21:00）'), {
      transport: { search: () => Promise.reject(new Error('fixture upstream failure')) },
    });
    const failedResult = await failed.read(readInput(failed.candidateId, ['opening_hours']));
    expect(failedResult.status).toBe('ok');
    expect(failed.hpObservationCount()).toBe(0);
    if (failedResult.status !== 'ok') return;
    expect(failedResult.data.items[0]?.fields.opening_hours).toMatchObject({
      status: 'known',
      observations: [{ sources: [{ provider: 'google_places' }] }],
    });
  });

  it('does not replace an opening observation when cancellation happens before HP registration', async () => {
    const fixture = makeFixture();
    const candidateId = fixture.candidateIds[0];
    if (candidateId === undefined) throw new Error('opening-hours candidate is missing');
    const adapter = createHotPepperAdapter({
      transport: {
        search: () =>
          Promise.resolve({
            shops: [shopFor('11:00〜22:00（L.O. 21:00）')],
            resultsAvailable: 1,
            resultsStart: 1,
          }),
      },
      mode: 'fixture',
      policy: hpPolicy,
      providerInputPolicy: () => ({ decision: 'allow', activation: 'fixture_only' }),
    });
    const overlay = createHotPepperDetailsOverlay({
      inner: fixture.adapter,
      adapter,
      registry: fixture.registry,
      clock: fixture.clock,
      observationPolicy,
      fieldPolicy: hpPolicy,
      candidateReferenceFor: (candidate) => ({
        candidateId: candidate.candidateId,
        name: candidate.displayName,
        lat: 35.6595,
        lng: 139.7005,
      }),
      reserveProviderRequest: () => true,
    });
    const initial = await fixture.adapter.read(
      readInput(candidateId, ['opening_hours']),
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(initial.status).toBe('ok');
    const result = await overlay.read(
      readInput(candidateId, ['opening_hours']),
      context,
      execution,
      { isCancelled: () => true },
    );
    expect(result).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(fixture.registry.listObservations(SCOPE, candidateId)).toHaveLength(1);
  });

  it('rejects an HP LO when the base has a different LO instant or source provider', () => {
    const differentInstant = mergeHotPepperOpeningHours(
      { ...baseOpening, lastOrderAt: '2026-09-10T08:00:00.000Z' },
      {
        openText: null,
        regularHolidayText: null,
        lastOrderRaw: '料理L.O. 21:00',
        lastOrderAt: null,
      },
    );
    expect(differentInstant.status).toBe('conflict');

    const policy: HotPepperFieldPolicy = (field, use) => ({
      decision:
        field === 'source' && use === 'attribution'
          ? 'allow'
          : field === 'opening_hours' && use === 'llm_input'
            ? 'allow'
            : 'deny',
      activation: 'live_verified',
    });
    const mixed = {
      status: 'known',
      observations: [
        {
          observationId: 'observation-opening',
          candidateId: 'candidate-opening',
          field: 'opening_hours',
          value: baseOpening,
          basis: 'provider_reported',
          fetchedAt: '2026-09-10T02:00:00.000Z',
          sourceUpdatedAt: null,
          expiresAt: '2026-09-10T23:00:00.000Z',
          contextKey: 'context-opening',
          sources: [
            {
              provider: 'google_places',
              recordRef: 'google-1',
              attribution: 'Google',
              publicUrl: null,
            },
            { provider: 'other', recordRef: 'other-1', attribution: 'Other', publicUrl: null },
            { provider: 'hotpepper', recordRef: 'hp-1', attribution: 'HP', publicUrl: null },
          ],
          retention: {
            retentionDecision: 'allow',
            retentionMode: 'provider_limited',
            sessionExpiresAt: '2026-09-11T00:00:00.000Z',
            freshUntil: '2026-09-10T12:00:00.000Z',
            displayUntil: '2026-09-10T18:00:00.000Z',
            retentionUntil: '2026-09-10T23:00:00.000Z',
            deletionScheduledAt: '2026-09-10T23:00:00.000Z',
            attribution: { label: 'HP', sourceLink: null },
            restoreMode: 'full',
            policyStatus: 'available',
            displayPolicyStatus: 'available',
          },
        },
      ],
    };
    expect(reprojectHotPepperField(policy, 'live', 'opening_hours', mixed)).toMatchObject({
      status: 'unsupported',
    });
  });

  it('returns a fixed source-conflict warning while retaining the Google opening value', async () => {
    const fixture = fixtureFor(shopFor('11:00〜22:00（料理L.O. 21:00）'), {
      mutateOpening: (value) => {
        return {
          ...value,
          observations: value.observations.map((observation) => ({
            ...observation,
            value: { ...observation.value, lastOrderAt: '2026-09-10T08:00:00.000Z' },
          })),
        };
      },
    });
    const result = await fixture.read(readInput(fixture.candidateId, ['opening_hours']));

    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'SOURCE_CONFLICT', path: 'opening_hours' }),
    ]);
    expect(JSON.stringify(result.warnings)).not.toContain('21:00');
    expect(result.data.items[0]?.fields.opening_hours).toMatchObject({
      status: 'known',
      observations: [{ sources: [{ provider: 'google_places' }] }],
    });
    expect(fixture.hpObservationCount()).toBe(0);
  });

  it('intersects finite retention and fails closed when either source bound is null', () => {
    const hpRetention = baseRetention;
    const bounded = intersectHotPepperOpeningRetention(baseRetention, {
      ...hpRetention,
      freshUntil: '2026-09-10T07:00:00.000Z',
      displayUntil: '2026-09-10T07:30:00.000Z',
      retentionUntil: '2026-09-10T08:00:00.000Z',
      deletionScheduledAt: '2026-09-10T08:00:00.000Z',
    });
    expect(bounded).toMatchObject({
      freshUntil: '2026-09-10T07:00:00.000Z',
      displayUntil: '2026-09-10T07:30:00.000Z',
      retentionUntil: '2026-09-10T08:00:00.000Z',
    });
    expect(
      intersectHotPepperOpeningRetention(baseRetention, { ...hpRetention, freshUntil: null }),
    ).toBeUndefined();
    expect(v.safeParse(OpeningHoursSchema, baseOpening).success).toBe(true);
  });
});
