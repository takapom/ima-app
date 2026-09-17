import { describe, expect, it } from 'vitest';
import { validateSubmitCards } from '@core/application/submission/submit-cards';
import {
  addObservation,
  makeFixture,
  makeInput,
  makeSelection,
  now,
} from '@core/application/submission/tests/submit-cards-fixtures';

const fixtureFor = (
  listedOpenAtEvaluation: boolean | null = null,
  minimumStayMinutes: number | null = null,
) => {
  const fixture = makeFixture(['candidate-1'], {
    originRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes,
    requireLastOrderAtArrival: false,
  });
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
  const selection = makeSelection('candidate-1', { ...ids, opening });
  const input = makeInput([{ ...selection, evidenceIds: [ids.identity, opening] }]);
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
  it('does not waive an unverified minimum stay requirement', () => {
    const f = fixtureFor(null, 20);
    expect(
      validateSubmitCards(f.input, { ...f.context, allowUnknownOpening: true }, f.registry).status,
    ).toBe('invalid');
  });
});
