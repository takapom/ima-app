import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { OpeningHoursSchema } from '@worker/domain/places/place-values';
import { validateSubmitCards } from '@worker/application/use-cases/submit-response/validation/submit-cards';
import { openIntervalAt } from '@worker/application/use-cases/submit-response/validation/submit-cards-opening';
import {
  makeFixture,
  makeInput,
  makeSelection,
  now,
} from '@worker/application/use-cases/submit-response/tests/submit-cards-fixtures';

const statusFor = (fixture: ReturnType<typeof makeFixture>) => {
  const ids = fixture.ids.get('candidate-1');
  if (ids === undefined) throw new Error('fixture candidate missing');
  return validateSubmitCards(
    makeInput([makeSelection('candidate-1')]),
    fixture.context,
    fixture.registry,
  );
};

describe('submit-cards opening validation at the server time', () => {
  it('accepts a candidate open now and before its last order', () => {
    expect(statusFor(makeFixture()).status).toBe('valid');
  });

  it('rejects a candidate that has not opened yet', () => {
    const result = statusFor(
      makeFixture(['candidate-1'], { openingStartAt: '2026-09-10T12:05:00Z' }),
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid')
      expect(result.issues.map((item) => item.message)).toContain(
        'candidate is not open at the current server time',
      );
  });

  it('treats an opening interval end as exclusive', () => {
    expect(statusFor(makeFixture(['candidate-1'], { openingEndAt: now })).status).toBe('invalid');
  });

  it('checks last order at the server time only when the Harness requires it', () => {
    const late = { lastOrderAt: '2026-09-10T11:59:00Z' };
    const required = statusFor(makeFixture(['candidate-1'], late));
    expect(required.status).toBe('invalid');
    if (required.status === 'invalid')
      expect(required.issues.map((item) => item.message)).toContain(
        'current time is after last order',
      );
    expect(
      statusFor(makeFixture(['candidate-1'], { ...late, requireLastOrderAtArrival: false })).status,
    ).toBe('valid');
  });

  it('accepts a provider interval without a fabricated closing timestamp', () => {
    const result = v.safeParse(OpeningHoursSchema, {
      timeZone: 'UTC',
      intervals: [{ startAt: '2026-09-10T00:00:00Z', endAt: null }],
      weeklyText: ['24 hours'],
      evaluatedAt: now,
      listedOpenAtEvaluation: true,
      nextBoundaryAt: null,
      lastOrderAt: null,
      lastOrderRaw: null,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('open-ended hours should satisfy Core schema');
    expect(openIntervalAt(result.output, '2026-09-11T23:59:00Z')?.endAt).toBeNull();
    expect(
      statusFor(
        makeFixture(['candidate-1'], { openingEndAt: null, requireLastOrderAtArrival: false }),
      ).status,
    ).toBe('valid');
  });
});
