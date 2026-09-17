import { describe, expect, it } from 'vitest';
import { createJourneyHistoryService } from '@mobile/services/journey-history';
import type { ThreadRecord } from '@mobile/services/sqlite/types';

const thread = (overrides: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 'thread-a',
  createdAt: '2026-09-07T19:20:00.000Z',
  expiresAt: '2026-09-07T20:00:00.000Z',
  ...overrides,
});

describe('journey history service', () => {
  it('projects store order into reference-only history rows', () => {
    const result = createJourneyHistoryService({
      sqlite: {
        listThreads: () => [
          thread({ id: 'thread-new', createdAt: '2026-09-07T19:20:00.000Z' }),
          thread({ id: 'thread-old', createdAt: '2026-09-07T18:30:00.000Z' }),
        ],
      },
    }).list();

    expect(result).toEqual({
      status: 'available',
      items: [
        { id: 'thread-new', label: '検索履歴', query: '', time: '9/8 04:20' },
        { id: 'thread-old', label: '検索履歴', query: '', time: '9/8 03:30' },
      ],
      nextExpiryAt: '2026-09-07T20:00:00.000Z',
    });
    if (result.status !== 'available') throw new Error('expected history');
    expect(Object.keys(result.items[0] ?? {}).sort()).toEqual(['id', 'label', 'query', 'time']);
    expect(JSON.stringify(result)).not.toContain('provider-place');
    expect(JSON.stringify(result)).not.toContain('original query');
  });

  it('drops malformed rows without turning them into visible history', () => {
    const result = createJourneyHistoryService({
      sqlite: {
        listThreads: () => [
          thread({ id: 'bad/id' }),
          thread({ id: 'bad-date', createdAt: 'invalid' }),
          thread({ id: 'bad-order', expiresAt: '2026-09-07T19:20:00.000Z' }),
          thread({ id: '' }),
        ],
      },
    }).list();

    expect(result).toEqual({ status: 'available', items: [], nextExpiryAt: null });
  });

  it('distinguishes missing and failed storage from an empty history', () => {
    expect(createJourneyHistoryService().list()).toEqual({
      status: 'unavailable',
      reason: 'storage_unavailable',
    });
    expect(createJourneyHistoryService({ sqlite: { listThreads: () => [] } }).list()).toEqual({
      status: 'available',
      items: [],
      nextExpiryAt: null,
    });
    expect(
      createJourneyHistoryService({
        sqlite: {
          listThreads: () => {
            throw new Error('storage unavailable');
          },
        },
      }).list(),
    ).toEqual({ status: 'unavailable', reason: 'storage_unavailable' });
  });
});
