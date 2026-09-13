import { describe, expect, it } from 'vitest';
import { validateMessage, validateSubmitCards } from './submit-cards';
import {
  addObservation,
  makeFixture,
  makeInput,
  makeSelection,
  now,
  type EvidenceIds,
} from './submission/tests/submit-cards-fixtures';

const idsFor = (
  fixture: ReturnType<typeof makeFixture>,
  candidateId = 'candidate-1',
): EvidenceIds => {
  const ids = fixture.ids.get(candidateId);
  if (ids === undefined) throw new Error('fixture candidate missing');
  return ids;
};

describe('submit-cards pure validation and card assembly', () => {
  it('assembles observed facts and preserves why/diff text for one card', () => {
    const fixture = makeFixture();
    const result = validateSubmitCards(
      makeInput([makeSelection('candidate-1', idsFor(fixture))]),
      fixture.context,
      fixture.registry,
    );
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.response.hero.identity.name).toBe('店 candidate-1');
      expect(result.response.hero.price?.rawLabel).toBe('¥¥');
      expect(result.response.hero.photos?.photos[0]?.photoRef).toBe('photo-candidate-1');
      expect(result.response.hero.walkingRoute?.durationSeconds).toBe(600);
      expect(result.response.hero.why.text).toBe('理由 candidate-1');
      expect(result.response.message[0]?.evidence[0]?.observationId).toBe(idsFor(fixture).identity);
      expect(fixture.registry.listObservations(fixture.context.scope)).toHaveLength(5);
    }
  });

  it.each([1, 2, 3])('keeps exactly %s selected cards without padding', (count) => {
    const candidateIds = ['candidate-1', 'candidate-2', 'candidate-3'].slice(0, count);
    const fixture = makeFixture(candidateIds);
    const selections = candidateIds.map((candidateId, index) =>
      makeSelection(candidateId, idsFor(fixture, candidateId), index > 0),
    );
    const result = validateSubmitCards(makeInput(selections), fixture.context, fixture.registry);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') expect(result.response.alts).toHaveLength(count - 1);
  });

  it('supports message-only and rejects an empty message', () => {
    const fixture = makeFixture([], {
      originRef: null,
      maxWalkMinutes: null,
      requireLastOrderAtArrival: false,
    });
    const message = {
      text: '条件を確認しました',
      evidenceIds: [],
      basis: 'conversational' as const,
    };
    const result = validateMessage(message, fixture.context, fixture.registry);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') expect(result.response.presentation).toBe('keep');
    expect(
      validateMessage({ ...message, text: '' }, fixture.context, fixture.registry).status,
    ).toBe('invalid');
  });

  it('allows message-only clarification when home-station travel context is incomplete', () => {
    const fixture = makeFixture(['candidate-1'], {
      homeStationRef: 'home-1',
      travel: [],
    });
    const ids = idsFor(fixture);
    const result = validateMessage(
      { text: '終電条件を確認します', evidenceIds: [ids.identity], basis: 'grounded' },
      fixture.context,
      fixture.registry,
    );
    expect(result.status).toBe('valid');
  });

  it('requires walking only when an explicit walk limit exists', () => {
    const fixture = makeFixture();
    const ids = idsFor(fixture);
    const selection = makeSelection('candidate-1', ids);
    selection.evidenceIds = selection.evidenceIds.filter((id) => id !== ids.walking);
    const result = validateSubmitCards(makeInput([selection]), fixture.context, fixture.registry);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.some((item) => item.code === 'MISSING_EVIDENCE')).toBe(true);
    }

    const noLimit = makeFixture(['candidate-1'], {
      originRef: null,
      maxWalkMinutes: null,
      requireLastOrderAtArrival: false,
    });
    const noWalk = makeSelection('candidate-1', idsFor(noLimit));
    noWalk.evidenceIds = noWalk.evidenceIds.filter((id) => id !== idsFor(noLimit).walking);
    expect(validateSubmitCards(makeInput([noWalk]), noLimit.context, noLimit.registry).status).toBe(
      'valid',
    );
  });

  it('rejects stale evidence and registered conflicting values', () => {
    const fixture = makeFixture();
    const ids = idsFor(fixture);
    const staleContext = {
      ...fixture.context.expectedObservationContext,
      timeContext: 'old-turn',
    };
    const staleId = addObservation(
      fixture.registry,
      fixture.context,
      'candidate-1',
      'identity',
      {
        name: '古い店',
        area: '恵比寿',
        address: null,
        category: 'cafe',
        businessStatus: 'operational',
        sourceUrl: null,
      },
      staleContext,
    );
    const staleSelection = makeSelection('candidate-1', ids);
    staleSelection.evidenceIds[0] = staleId;
    const stale = validateSubmitCards(
      makeInput([staleSelection]),
      fixture.context,
      fixture.registry,
    );
    expect(stale.status).toBe('invalid');
    if (stale.status === 'invalid') {
      expect(stale.issues.some((item) => item.code === 'STALE_EVIDENCE')).toBe(true);
    }

    addObservation(fixture.registry, fixture.context, 'candidate-1', 'opening_hours', {
      timeZone: 'UTC',
      intervals: [{ startAt: '2026-09-10T11:00:00Z', endAt: '2026-09-10T15:00:00Z' }],
      weeklyText: ['11:00-15:00'],
      evaluatedAt: now,
      listedOpenAtEvaluation: true,
      nextBoundaryAt: '2026-09-10T15:00:00Z',
      lastOrderAt: '2026-09-10T13:30:00Z',
      lastOrderRaw: '13:30',
    });
    const conflict = validateSubmitCards(
      makeInput([makeSelection('candidate-1', ids)]),
      fixture.context,
      fixture.registry,
    );
    expect(conflict.status).toBe('invalid');
    if (conflict.status === 'invalid') {
      expect(conflict.issues.some((item) => item.message.includes('conflict'))).toBe(true);
    }
  });

  it('accepts equivalent duplicate field observations and rejects a missing required field', () => {
    const fixture = makeFixture();
    const ids = idsFor(fixture);
    const duplicateOpeningId = addObservation(
      fixture.registry,
      fixture.context,
      'candidate-1',
      'opening_hours',
      {
        timeZone: 'UTC',
        intervals: [{ startAt: '2026-09-10T11:00:00Z', endAt: '2026-09-10T15:00:00Z' }],
        weeklyText: ['11:00-15:00'],
        evaluatedAt: now,
        listedOpenAtEvaluation: true,
        nextBoundaryAt: '2026-09-10T15:00:00Z',
        lastOrderAt: '2026-09-10T14:00:00Z',
        lastOrderRaw: '14:00',
      },
    );
    const duplicate = makeSelection('candidate-1', ids);
    duplicate.evidenceIds.splice(2, 0, duplicateOpeningId);
    expect(
      validateSubmitCards(makeInput([duplicate]), fixture.context, fixture.registry).status,
    ).toBe('valid');

    const missing = makeSelection('candidate-1', ids);
    missing.evidenceIds = missing.evidenceIds.filter((id) => id !== ids.opening);
    const invalid = validateSubmitCards(makeInput([missing]), fixture.context, fixture.registry);
    expect(invalid.status).toBe('invalid');
    if (invalid.status === 'invalid') {
      expect(invalid.issues.some((item) => item.missingFields.includes('opening_hours'))).toBe(
        true,
      );
    }
  });

  it('rejects an observation ID suppressed by refresh even when a newer ID is reusable', () => {
    const fixture = makeFixture();
    const ids = idsFor(fixture);
    fixture.registry.invalidateObservationReuse(fixture.context.scope, 'candidate-1', 'identity');
    const refreshedIdentity = addObservation(
      fixture.registry,
      fixture.context,
      'candidate-1',
      'identity',
      {
        name: '店 candidate-1 refreshed',
        area: '恵比寿',
        address: null,
        category: 'cafe',
        businessStatus: 'operational',
        sourceUrl: null,
      },
    );
    expect(
      fixture.registry.restoreObservationReuse(fixture.context.scope, 'candidate-1', 'identity', [
        refreshedIdentity,
      ]),
    ).toBe(true);

    const oldSelection = makeSelection('candidate-1', ids);
    expect(
      validateSubmitCards(makeInput([oldSelection]), fixture.context, fixture.registry).status,
    ).toBe('invalid');

    const newSelection = makeSelection('candidate-1', ids);
    newSelection.evidenceIds = newSelection.evidenceIds.map((id) =>
      id === ids.identity ? refreshedIdentity : id,
    );
    newSelection.why.evidenceIds = [refreshedIdentity];
    expect(
      validateSubmitCards(makeInput([newSelection]), fixture.context, fixture.registry).status,
    ).toBe('valid');
  });
});
