import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { OpeningHoursSchema } from '../domain/place-values';
import { makeFixture, now } from './submit-cards-fixtures';
import { minimumStayIssue, openIntervalAt } from './submit-cards-stay';
import { resolveObservation } from './submit-cards-evidence';

const openEndedHours = {
  timeZone: 'UTC',
  intervals: [{ startAt: '2026-09-10T00:00:00Z', endAt: null }],
  weeklyText: ['24 hours'],
  evaluatedAt: now,
  listedOpenAtEvaluation: true,
  nextBoundaryAt: null,
  lastOrderAt: null,
  lastOrderRaw: null,
};

describe('open-ended opening intervals', () => {
  it('accepts a provider interval without a fabricated closing timestamp', () => {
    const result = v.safeParse(OpeningHoursSchema, openEndedHours);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('open-ended hours should satisfy Core schema');
    const parsed = result.output;
    expect(openIntervalAt(parsed, '2026-09-11T23:59:00Z')?.endAt).toBeNull();
  });

  it('does not turn an open-ended interval into a minimum-stay failure', () => {
    const fixture = makeFixture(['candidate-1'], {
      maxWalkMinutes: null,
      requireLastOrderAtArrival: false,
      openingEndAt: null,
    });
    const candidateId = 'candidate-1';
    const ids = fixture.ids.get(candidateId);
    if (ids === undefined) throw new Error('open-ended fixture is missing');
    const resolved = resolveObservation(
      ids.opening,
      candidateId,
      'hero.evidenceIds[0]',
      fixture.context,
      fixture.registry,
    );
    if (resolved.resolved === undefined) throw new Error('open-ended observation was not resolved');
    const issue = minimumStayIssue(
      candidateId,
      'hero',
      new Map([['opening_hours', resolved.resolved]]),
      now,
      180,
    );
    expect(issue).toBeUndefined();

    const expiredContext = {
      ...fixture.context,
      serverNow: '2026-09-10T14:00:00Z',
      departureAt: '2026-09-10T14:00:00Z',
    };
    const expired = resolveObservation(
      ids.opening,
      candidateId,
      'hero.evidenceIds[0]',
      expiredContext,
      fixture.registry,
    );
    expect(expired.resolved).toBeUndefined();
    expect(expired.issue?.code).toBe('STALE_EVIDENCE');
  });

  it('floors fractional arrival time against a finite deadline without overestimating stay', () => {
    const fixture = makeFixture(['candidate-1'], {
      maxWalkMinutes: null,
      requireLastOrderAtArrival: false,
      openingEndAt: null,
    });
    const ids = fixture.ids.get('candidate-1');
    if (ids === undefined) throw new Error('fractional fixture is missing');
    const resolved = resolveObservation(
      ids.opening,
      'candidate-1',
      'hero.evidenceIds[0]',
      fixture.context,
      fixture.registry,
    );
    if (resolved.resolved === undefined) throw new Error('fractional observation was not resolved');
    const observations = new Map([['opening_hours', resolved.resolved]] as const);

    expect(
      minimumStayIssue(
        'candidate-1',
        'hero',
        observations,
        '2026-09-10T12:00:00.123Z',
        20,
        '2026-09-10T12:30:00Z',
      ),
    ).toBeUndefined();
    expect(
      minimumStayIssue(
        'candidate-1',
        'hero',
        observations,
        '2026-09-10T12:00:00.123Z',
        20,
        '2026-09-10T12:20:00.122Z',
      )?.code,
    ).toBe('CONSTRAINT_VIOLATION');
  });
});
