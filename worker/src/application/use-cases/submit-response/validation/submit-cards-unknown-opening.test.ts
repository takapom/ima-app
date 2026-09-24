import { describe, expect, it } from 'vitest';
import { validateSubmitCards } from '@worker/application/use-cases/submit-response/validation/submit-cards';
import {
  addObservation,
  makeFixture,
  makeInput,
  makeSelection,
  now,
} from '@worker/application/use-cases/submit-response/tests/submit-cards-fixtures';

const fixtureFor = (listedOpenAtEvaluation: boolean | null = null) => {
  const fixture = makeFixture(['candidate-1'], { requireLastOrderAtArrival: false });
  const ids = fixture.ids.get('candidate-1');
  if (ids === undefined) throw new Error('Fixture missing');
  fixture.registry.invalidateObservationReuse(
    fixture.context.scope,
    'candidate-1',
    'opening_hours',
  );
  const opening = addObservation(
    fixture.registry,
    fixture.context,
    'candidate-1',
    'opening_hours',
    {
      timeZone: 'Asia/Tokyo',
      intervals: [],
      weeklyText: ['営業時間は店舗にお問い合わせください'],
      evaluatedAt: now,
      listedOpenAtEvaluation,
      nextBoundaryAt: null,
      lastOrderAt: null,
      lastOrderRaw: null,
    },
  );
  fixture.registry.restoreObservationReuse(fixture.context.scope, 'candidate-1', 'opening_hours', [
    opening,
  ]);
  const input = makeInput([makeSelection('candidate-1', { ...ids, opening })]);
  return { ...fixture, input };
};

describe('unconfirmed opening status', () => {
  it('accepts listed text only when the host explicitly permits unknown opening status', () => {
    const f = fixtureFor();
    expect(validateSubmitCards(f.input, f.context, f.registry).status).toBe('invalid');
    const result = validateSubmitCards(
      f.input,
      { ...f.context, allowUnknownOpening: true },
      f.registry,
    );
    expect(result.status).toBe('valid');
    if (result.status === 'valid')
      expect(result.response.hero.openingHours.listedOpenAtEvaluation).toBeNull();
  });
  it('still rejects an explicitly closed shop', () => {
    const f = fixtureFor(false);
    expect(
      validateSubmitCards(f.input, { ...f.context, allowUnknownOpening: true }, f.registry).status,
    ).toBe('invalid');
  });
});
