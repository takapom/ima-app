import { describe, expect, it } from 'vitest';
import {
  validateMessage,
  validateSubmitCards,
} from '@worker/application/use-cases/submit-response/validation/submit-cards';
import {
  addObservation,
  makeFixture,
  makeInput,
  makeSelection,
  now,
  type EvidenceIds,
} from '@worker/application/use-cases/submit-response/tests/submit-cards-fixtures';

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
      makeInput([makeSelection('candidate-1')]),
      fixture.context,
      fixture.registry,
    );
    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.response.hero.identity.name).toBe('店 candidate-1');
      expect(result.response.hero.price?.rawLabel).toBe('¥¥');
      expect(result.response.hero.photos?.photos[0]?.photoRef).toBe('photo-candidate-1');
      expect(result.response.hero.why).toBe('理由 candidate-1');
      expect(result.response.message).toEqual(['候補を提案します']);
      expect(fixture.registry.listObservations(fixture.context.scope)).toHaveLength(4);
    }
  });

  it('attaches every card field from the registry without model-copied IDs', () => {
    const fixture = makeFixture();
    const ids = idsFor(fixture);
    const facilities = addObservation(
      fixture.registry,
      fixture.context,
      'candidate-1',
      'facilities',
      {
        wifi: 'yes',
        nonSmoking: 'partial',
        privateRoom: 'unknown',
        parking: 'no',
        sourceText: [],
      },
    );
    const result = validateSubmitCards(
      makeInput([makeSelection('candidate-1')]),
      fixture.context,
      fixture.registry,
    );

    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.response.hero.identity.name).toBe('店 candidate-1');
      expect(result.response.hero.price?.rawLabel).toBe('¥¥');
      expect(result.response.hero.photos?.photos[0]?.photoRef).toBe('photo-candidate-1');
      expect(result.response.hero.facilities?.nonSmoking).toBe('partial');
      // Attribution and photo tokens are keyed off card evidence, so every attached id is there.
      expect([...result.response.hero.evidenceIds].sort()).toEqual(
        [ids.identity, ids.opening, ids.price, ids.photos, facilities].sort(),
      );
    }
  });

  it('rejects the retired card evidenceIds input instead of ignoring it', () => {
    const fixture = makeFixture();
    const ids = idsFor(fixture);
    const legacy = { ...makeSelection('candidate-1'), evidenceIds: [ids.identity] };
    const result = validateSubmitCards(makeInput([legacy]), fixture.context, fixture.registry);
    expect(result).toMatchObject({ status: 'invalid', issues: [{ code: 'INVALID_ARGUMENT' }] });
  });

  it('requires a usable identity and opening-hours observation for the candidate itself', () => {
    const fixture = makeFixture();
    const bare = fixture.registry.registerCandidate({
      ...fixture.context.scope,
      provider: 'fixture',
      recordRef: 'record-bare',
      displayName: '観測のない店',
      status: 'operational',
    });
    const result = validateSubmitCards(
      makeInput([makeSelection(bare.candidateId)]),
      fixture.context,
      fixture.registry,
    );

    // Candidate-1's observations exist in the same scope but never attach to another candidate.
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      const missing = result.issues.filter((entry) => entry.code === 'MISSING_EVIDENCE');
      expect(missing.flatMap((entry) => entry.missingFields).sort()).toEqual(
        ['identity', 'opening_hours'].sort(),
      );
    }
  });

  it.each([1, 2, 3])('keeps exactly %s selected cards without padding', (count) => {
    const candidateIds = ['candidate-1', 'candidate-2', 'candidate-3'].slice(0, count);
    const fixture = makeFixture(candidateIds);
    const selections = candidateIds.map((candidateId, index) =>
      makeSelection(candidateId, index > 0),
    );
    const result = validateSubmitCards(makeInput(selections), fixture.context, fixture.registry);
    expect(result.status).toBe('valid');
    if (result.status === 'valid') expect(result.response.alts).toHaveLength(count - 1);
  });

  it('supports message-only and rejects an empty message', () => {
    const fixture = makeFixture([], { requireLastOrder: false });
    const result = validateMessage({ kind: 'ask', message: '条件を確認しました' }, fixture.context);
    expect(result).toMatchObject({
      status: 'valid',
      response: { presentation: 'keep', kind: 'ask', message: '条件を確認しました' },
    });
    expect(validateMessage({ kind: 'answer', message: '' }, fixture.context).status).toBe(
      'invalid',
    );
    // Cards are proposed through the card path only.
    expect(validateMessage({ kind: 'propose', message: 'x' }, fixture.context).status).toBe(
      'invalid',
    );
  });

  it('rejects the retired self-reported basis and citations on generated text', () => {
    const fixture = makeFixture();
    const cited = { text: '理由', evidenceIds: [idsFor(fixture).identity], basis: 'grounded' };
    expect(validateMessage({ kind: 'answer', message: cited }, fixture.context).status).toBe(
      'invalid',
    );
    const selection = { ...makeSelection('candidate-1'), why: cited as unknown as string };
    expect(
      validateSubmitCards(makeInput([selection]), fixture.context, fixture.registry),
    ).toMatchObject({ status: 'invalid', issues: [{ code: 'INVALID_ARGUMENT' }] });
    expect(
      validateSubmitCards(
        { ...makeInput([makeSelection('candidate-1')]), message: [cited as unknown as string] },
        fixture.context,
        fixture.registry,
      ).status,
    ).toBe('invalid');
  });

  it('skips observations from another turn context and rejects registered conflicts', () => {
    const fixture = makeFixture();
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
        stationName: null,
        accessText: null,
        businessStatus: 'operational',
        sourceUrl: null,
      },
      { ...fixture.context.expectedObservationContext, timeContext: 'old-turn' },
    );
    const skipped = validateSubmitCards(
      makeInput([makeSelection('candidate-1')]),
      fixture.context,
      fixture.registry,
    );
    expect(skipped.status).toBe('valid');
    if (skipped.status === 'valid') {
      expect(skipped.response.hero.identity.name).toBe('店 candidate-1');
      expect(skipped.response.hero.evidenceIds).not.toContain(staleId);
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
      makeInput([makeSelection('candidate-1')]),
      fixture.context,
      fixture.registry,
    );
    expect(conflict.status).toBe('invalid');
    if (conflict.status === 'invalid') {
      expect(conflict.issues.some((item) => item.message.includes('conflict'))).toBe(true);
    }
  });

  it('accepts equivalent duplicate field observations', () => {
    const fixture = makeFixture();
    addObservation(fixture.registry, fixture.context, 'candidate-1', 'opening_hours', {
      timeZone: 'UTC',
      intervals: [{ startAt: '2026-09-10T11:00:00Z', endAt: '2026-09-10T15:00:00Z' }],
      weeklyText: ['11:00-15:00'],
      evaluatedAt: now,
      listedOpenAtEvaluation: true,
      nextBoundaryAt: '2026-09-10T15:00:00Z',
      lastOrderAt: '2026-09-10T14:00:00Z',
      lastOrderRaw: '14:00',
    });
    expect(
      validateSubmitCards(
        makeInput([makeSelection('candidate-1')]),
        fixture.context,
        fixture.registry,
      ).status,
    ).toBe('valid');
  });

  it('attaches the refreshed observation instead of one suppressed by refresh', () => {
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
        stationName: null,
        accessText: null,
        businessStatus: 'operational',
        sourceUrl: null,
      },
    );
    expect(
      fixture.registry.restoreObservationReuse(fixture.context.scope, 'candidate-1', 'identity', [
        refreshedIdentity,
      ]),
    ).toBe(true);

    // The Core attaches the reusable refreshed identity, never the suppressed one.
    const refreshed = validateSubmitCards(
      makeInput([makeSelection('candidate-1')]),
      fixture.context,
      fixture.registry,
    );
    expect(refreshed.status).toBe('valid');
    if (refreshed.status === 'valid') {
      expect(refreshed.response.hero.identity.name).toBe('店 candidate-1 refreshed');
      expect(refreshed.response.hero.evidenceIds).not.toContain(ids.identity);
    }
  });
});
