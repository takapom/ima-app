import { describe, expect, it } from 'vitest';
import { createSavedPlaceListService } from './saved-place-list';
import type { SavedPlaceRecord } from './sqlite/types';
import type { ServerSavedPlaceRef, LocalSavedEntryId } from './saved-place-types';

const now = '2026-09-11T03:00:00.000Z';

const asLocal = (value: string): LocalSavedEntryId => value as LocalSavedEntryId;
const asServer = (value: string): ServerSavedPlaceRef => value as ServerSavedPlaceRef;

const record = (overrides: Partial<SavedPlaceRecord> = {}): SavedPlaceRecord => ({
  localSavedEntryId: asLocal('local-1'),
  serverSavedPlaceRef: asServer('saved-ref-1'),
  name: '夜カフェ',
  area: '恵比寿',
  savedAt: '2026-09-10T12:00:00.000Z',
  starred: true,
  decidedAt: null,
  sessionExpiresAt: '2026-09-11T05:00:00.000Z',
  displayUntil: '2026-09-11T04:30:00.000Z',
  retentionUntil: '2026-09-11T05:00:00.000Z',
  deletionScheduledAt: '2026-09-11T05:00:00.000Z',
  restoreMode: 'full',
  needsRefetch: false,
  ...overrides,
});

describe('saved place list service', () => {
  it('keeps visible full rows and redacts names from reference-only rows', () => {
    const rows = [
      record(),
      record({
        localSavedEntryId: asLocal('local-reference'),
        serverSavedPlaceRef: asServer('saved-ref-reference'),
        name: 'provider name that must stay withheld',
        area: 'provider area that must stay withheld',
        sessionExpiresAt: '2026-09-10T20:00:00.000Z',
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        restoreMode: 'reference_only',
        needsRefetch: true,
      }),
      record({
        localSavedEntryId: asLocal('local-expired'),
        serverSavedPlaceRef: asServer('saved-ref-expired'),
        sessionExpiresAt: '2026-09-11T02:00:00.000Z',
      }),
      record({
        localSavedEntryId: asLocal('local-display-expired'),
        serverSavedPlaceRef: asServer('saved-ref-display-expired'),
        displayUntil: '2026-09-11T03:00:00.000Z',
      }),
      record({
        localSavedEntryId: asLocal('local-not-starred'),
        serverSavedPlaceRef: asServer('saved-ref-not-starred'),
        starred: false,
      }),
      record({
        localSavedEntryId: asLocal('local-unavailable'),
        serverSavedPlaceRef: asServer('saved-ref-unavailable'),
        restoreMode: 'unavailable',
      }),
      record({
        localSavedEntryId: asLocal('local-invalid'),
        serverSavedPlaceRef: asServer('invalid ref'),
      }),
      record({
        localSavedEntryId: asLocal('local-incomplete'),
        serverSavedPlaceRef: asServer('saved-ref-incomplete'),
        name: null,
      }),
      record({
        localSavedEntryId: asLocal('local-invalid-date'),
        serverSavedPlaceRef: asServer('saved-ref-invalid-date'),
        displayUntil: 'invalid-date',
      }),
    ];
    const service = createSavedPlaceListService({
      sqlite: { listSavedPlaces: () => rows },
      now: () => now,
    });

    const result = service.list();
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected an available list');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      localSavedEntryId: 'local-1',
      serverSavedPlaceRef: 'saved-ref-1',
      name: '夜カフェ',
      area: '恵比寿',
      restoreMode: 'full',
      needsRefetch: false,
    });
    expect(result.items[1]).toMatchObject({
      localSavedEntryId: 'local-reference',
      serverSavedPlaceRef: 'saved-ref-reference',
      name: null,
      area: null,
      restoreMode: 'reference_only',
      needsRefetch: true,
    });
  });

  it('treats a deadline at now as expired in the list projection', () => {
    const result = createSavedPlaceListService({
      sqlite: {
        listSavedPlaces: () => [
          record({
            serverSavedPlaceRef: asServer('saved-ref-visible'),
          }),
          record({
            localSavedEntryId: asLocal('local-expired'),
            serverSavedPlaceRef: asServer('saved-ref-expired'),
            displayUntil: now,
          }),
        ],
      },
      now: () => now,
    }).list();

    expect(result).toMatchObject({
      status: 'available',
      items: [{ serverSavedPlaceRef: 'saved-ref-visible' }],
    });
  });

  it('distinguishes unavailable storage and an unusable clock from an empty list', () => {
    expect(createSavedPlaceListService().list()).toEqual({
      status: 'unavailable',
      reason: 'storage_unavailable',
    });
    expect(
      createSavedPlaceListService({
        sqlite: { listSavedPlaces: () => [] },
      }).list(),
    ).toEqual({ status: 'available', items: [] });
    expect(
      createSavedPlaceListService({
        sqlite: { listSavedPlaces: () => [] },
        now: () => 'not-a-timestamp',
      }).list(),
    ).toEqual({ status: 'unavailable', reason: 'clock_unavailable' });
    expect(
      createSavedPlaceListService({
        sqlite: {
          listSavedPlaces: () => {
            throw new Error('storage offline');
          },
        },
        now: () => now,
      }).list(),
    ).toEqual({ status: 'unavailable', reason: 'storage_unavailable' });
  });

  it('fails closed after a raw clock rollback and does not recover', () => {
    let current = now;
    const service = createSavedPlaceListService({
      sqlite: { listSavedPlaces: () => [record()] },
      now: () => current,
    });

    expect(service.list()).toMatchObject({ status: 'available' });
    current = '2026-09-11T02:00:00.000Z';
    expect(service.list()).toEqual({ status: 'unavailable', reason: 'clock_unavailable' });
    current = '2026-09-11T04:00:00.000Z';
    expect(service.list()).toEqual({ status: 'unavailable', reason: 'clock_unavailable' });
  });
});
