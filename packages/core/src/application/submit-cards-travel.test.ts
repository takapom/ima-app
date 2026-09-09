import { describe, expect, it } from 'vitest';
import { validateSubmitCards } from './submit-cards';
import { makeFixture, makeInput, makeSelection } from './submit-cards-fixtures';

describe('submit-cards arrival and last-train validation', () => {
  it('checks last order independently from opening hours and validates last-train arithmetic', () => {
    const fixture = makeFixture(['candidate-1'], {
      homeStationRef: 'home-1',
      minimumStayMinutes: 20,
    });
    const ids = fixture.ids.get('candidate-1');
    if (ids === undefined || ids.lastTrain === undefined) throw new Error('travel fixture missing');
    const valid = validateSubmitCards(
      makeInput([makeSelection('candidate-1', ids)]),
      fixture.context,
      fixture.registry,
    );
    expect(valid.status).toBe('valid');

    const lateOrder = makeFixture(['candidate-1'], {
      homeStationRef: 'home-1',
      minimumStayMinutes: 20,
      lastOrderAt: '2026-09-10T12:05:00Z',
    });
    const lateOrderIds = lateOrder.ids.get('candidate-1');
    if (lateOrderIds === undefined) throw new Error('late-order fixture missing');
    const lateOrderResult = validateSubmitCards(
      makeInput([makeSelection('candidate-1', lateOrderIds)]),
      lateOrder.context,
      lateOrder.registry,
    );
    expect(lateOrderResult.status).toBe('invalid');

    const badArithmetic = makeFixture(['candidate-1'], {
      homeStationRef: 'home-1',
      minimumStayMinutes: 20,
      lastTrainVariant: 'bad-arithmetic',
    });
    const badIds = badArithmetic.ids.get('candidate-1');
    if (badIds === undefined) throw new Error('bad-train fixture missing');
    const badResult = validateSubmitCards(
      makeInput([makeSelection('candidate-1', badIds)]),
      badArithmetic.context,
      badArithmetic.registry,
    );
    expect(badResult.status).toBe('invalid');
  });

  it('treats an opening interval end as exclusive', () => {
    const atEnd = makeFixture(['candidate-1'], {
      maxWalkMinutes: null,
      requireLastOrderAtArrival: false,
      walkingDurationSeconds: 10_800,
      openingEndAt: '2026-09-10T15:00:00Z',
    });
    const endIds = atEnd.ids.get('candidate-1');
    if (endIds === undefined) throw new Error('end fixture missing');
    const endSelection = makeSelection('candidate-1', endIds);
    const atEndResult = validateSubmitCards(
      makeInput([endSelection]),
      atEnd.context,
      atEnd.registry,
    );
    expect(atEndResult.status).toBe('invalid');
  });

  it('requires the candidate to be open both now and at its arrival', () => {
    const closedNow = makeFixture(['candidate-1'], {
      maxWalkMinutes: null,
      requireLastOrderAtArrival: false,
      openingStartAt: '2026-09-10T12:05:00Z',
    });
    const closedNowIds = closedNow.ids.get('candidate-1');
    if (closedNowIds === undefined) throw new Error('closed-now fixture missing');
    expect(
      validateSubmitCards(
        makeInput([makeSelection('candidate-1', closedNowIds)]),
        closedNow.context,
        closedNow.registry,
      ).status,
    ).toBe('invalid');

    const closedOnArrival = makeFixture(['candidate-1'], {
      maxWalkMinutes: null,
      requireLastOrderAtArrival: false,
      openingEndAt: '2026-09-10T12:05:00Z',
    });
    const closedOnArrivalIds = closedOnArrival.ids.get('candidate-1');
    if (closedOnArrivalIds === undefined) throw new Error('closed-arrival fixture missing');
    expect(
      validateSubmitCards(
        makeInput([makeSelection('candidate-1', closedOnArrivalIds)]),
        closedOnArrival.context,
        closedOnArrival.registry,
      ).status,
    ).toBe('invalid');
  });

  it('requires walking evidence for a home-station last-train constraint', () => {
    const fixture = makeFixture(['candidate-1'], {
      homeStationRef: 'home-1',
      maxWalkMinutes: null,
    });
    const ids = fixture.ids.get('candidate-1');
    if (ids === undefined) throw new Error('home-station fixture missing');
    const selection = makeSelection('candidate-1', ids);
    selection.evidenceIds = selection.evidenceIds.filter((id) => id !== ids.walking);
    const result = validateSubmitCards(makeInput([selection]), fixture.context, fixture.registry);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.some((item) => item.missingFields.includes('walking_route'))).toBe(true);
    }
  });

  it('includes the opening interval in the minimum-stay calculation', () => {
    const fixture = makeFixture(['candidate-1'], {
      homeStationRef: 'home-1',
      minimumStayMinutes: 20,
      openingEndAt: '2026-09-10T12:20:00Z',
    });
    const ids = fixture.ids.get('candidate-1');
    if (ids === undefined) throw new Error('short-opening fixture missing');
    const result = validateSubmitCards(
      makeInput([makeSelection('candidate-1', ids)]),
      fixture.context,
      fixture.registry,
    );
    expect(result.status).toBe('invalid');
  });

  it('enforces minimum stay without requiring a home station', () => {
    const validFixture = makeFixture(['candidate-1'], {
      homeStationRef: null,
      minimumStayMinutes: 20,
      maxWalkMinutes: null,
    });
    const validIds = validFixture.ids.get('candidate-1');
    if (validIds === undefined) throw new Error('minimum-stay fixture missing');
    expect(
      validateSubmitCards(
        makeInput([makeSelection('candidate-1', validIds)]),
        validFixture.context,
        validFixture.registry,
      ).status,
    ).toBe('valid');

    const shortFixture = makeFixture(['candidate-1'], {
      homeStationRef: null,
      minimumStayMinutes: 20,
      maxWalkMinutes: null,
      openingEndAt: '2026-09-10T12:20:00Z',
    });
    const shortIds = shortFixture.ids.get('candidate-1');
    if (shortIds === undefined) throw new Error('short minimum-stay fixture missing');
    expect(
      validateSubmitCards(
        makeInput([makeSelection('candidate-1', shortIds)]),
        shortFixture.context,
        shortFixture.registry,
      ).status,
    ).toBe('invalid');

    const unknownArrival = makeSelection('candidate-1', validIds);
    unknownArrival.evidenceIds = unknownArrival.evidenceIds.filter((id) => id !== validIds.walking);
    const unknownResult = validateSubmitCards(
      makeInput([unknownArrival]),
      validFixture.context,
      validFixture.registry,
    );
    expect(unknownResult.status).toBe('invalid');
    if (unknownResult.status === 'invalid') {
      expect(
        unknownResult.issues.some((item) => item.missingFields.includes('walking_route')),
      ).toBe(true);
    }
  });

  it('rejects an unrepresentable walking arrival without throwing', () => {
    const fixture = makeFixture(['candidate-1'], {
      maxWalkMinutes: null,
      requireLastOrderAtArrival: false,
      walkingDurationSeconds: Number.MAX_SAFE_INTEGER,
    });
    const ids = fixture.ids.get('candidate-1');
    if (ids === undefined) throw new Error('large-duration fixture missing');
    const result = validateSubmitCards(
      makeInput([makeSelection('candidate-1', ids)]),
      fixture.context,
      fixture.registry,
    );
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.some((item) => item.missingFields.includes('durationSeconds'))).toBe(
        true,
      );
    }
  });
});
