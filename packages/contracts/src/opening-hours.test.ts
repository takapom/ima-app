import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { OpeningHoursSchema } from '@contracts/values';

describe('public opening-hours intervals', () => {
  it('allows an open-ended provider interval without inventing a close', () => {
    const result = v.safeParse(OpeningHoursSchema, {
      timeZone: 'UTC',
      intervals: [{ startAt: '2026-09-10T00:00:00Z', endAt: null }],
      weeklyText: ['24 hours'],
      evaluatedAt: '2026-09-10T00:00:00Z',
      listedOpenAtEvaluation: true,
      nextBoundaryAt: null,
      lastOrderAt: null,
      lastOrderRaw: null,
    });
    expect(result.success).toBe(true);
  });
});
