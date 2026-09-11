import { describe, expect, it } from 'vitest';
import type { GetPlaceDetailsOutput, PlaceDetailsPort, Result } from '@ima/core';
import { createHotPepperReuseFilter } from '../../../src/providers/hot-pepper/composition';
import { denyHotPepperFieldPolicy } from '../../../src/providers/hot-pepper/types';
import { context, execution, makeFixture, readInput } from '../places-details/adapter-fixtures';

const mixedOpeningResult = async (): Promise<{
  readonly candidateId: string;
  readonly google: Result<GetPlaceDetailsOutput>;
  readonly mixed: Result<GetPlaceDetailsOutput>;
}> => {
  const fixture = makeFixture();
  const candidateId = fixture.candidateIds[0];
  if (candidateId === undefined) throw new Error('opening-hours candidate is missing');
  const google = await fixture.adapter.read(
    readInput(candidateId, ['opening_hours']),
    context,
    execution,
    { isCancelled: () => false },
  );
  if (google.status !== 'ok') throw new Error('Google opening fixture is invalid');
  const items: GetPlaceDetailsOutput['items'] = google.data.items.map((item) => {
    const opening = item.fields.opening_hours;
    if (opening?.status !== 'known') throw new Error('Google opening field is missing');
    return {
      ...item,
      fields: {
        ...item.fields,
        opening_hours: {
          status: 'known' as const,
          observations: opening.observations.map((observation) => ({
            ...observation,
            value: { ...observation.value, lastOrderRaw: '料理L.O. 21:00' },
            sources: [
              ...observation.sources,
              {
                provider: 'hotpepper',
                recordRef: 'hp-opening',
                attribution: 'ホットペッパー',
                publicUrl: 'https://www.hotpepper.jp',
              },
            ],
          })),
        },
      },
    };
  });
  return { candidateId, google, mixed: { status: 'ok', data: { items }, warnings: [] } };
};

describe('Hot Pepper opening-hours reuse recovery', () => {
  it('reserves an extra Google read and rejects an unbudgeted recovery', async () => {
    const fixture = await mixedOpeningResult();
    const run = async (
      allowRecovery: boolean,
      refreshed: Result<GetPlaceDetailsOutput> = fixture.google,
    ) => {
      let reads = 0;
      let reservations = 0;
      const inner: PlaceDetailsPort = {
        read: (input) => {
          reads += 1;
          return Promise.resolve(input.freshness === 'refresh' ? refreshed : fixture.mixed);
        },
      };
      const filter = createHotPepperReuseFilter(inner, denyHotPepperFieldPolicy, 'live', () => {
        reservations += 1;
        return allowRecovery;
      });
      const result = await filter.read(
        readInput(fixture.candidateId, ['opening_hours'], 'reuse_valid'),
        context,
        execution,
        { isCancelled: () => false },
      );
      return { reads, reservations, result };
    };

    const denied = await run(false);
    expect(denied.reads).toBe(1);
    expect(denied.reservations).toBe(1);
    expect(denied.result).toMatchObject({
      status: 'partial',
      data: { items: [{ fields: { opening_hours: { status: 'unsupported' } } }] },
    });

    const recovered = await run(true);
    expect(recovered.reads).toBe(2);
    expect(recovered.reservations).toBe(1);
    expect(recovered.result).toMatchObject({
      status: 'ok',
      data: {
        items: [
          {
            fields: {
              opening_hours: {
                status: 'known',
                observations: [
                  {
                    value: { lastOrderRaw: null },
                    sources: [{ provider: 'google_places' }],
                  },
                ],
              },
            },
          },
        ],
      },
    });

    const mixedRecovery = await run(true, fixture.mixed);
    expect(mixedRecovery.reads).toBe(2);
    expect(mixedRecovery.reservations).toBe(1);
    expect(mixedRecovery.result).toMatchObject({
      status: 'partial',
      data: { items: [{ fields: { opening_hours: { status: 'unsupported' } } }] },
    });
  });
});
