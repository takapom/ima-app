import type { RespondInvalid } from '@worker/application/ports/submission';
import { describe, expect, it, vi } from 'vitest';
import {
  observeRuntimeSubmitRejection,
  runtimeSubmitRejectionFor,
  runtimeTurnObserverWriters,
  type RuntimeSubmitRejection,
  type RuntimeTurnOutcome,
} from '@worker/runtime/turn-execution/runtime-submit-diagnostic';

const invalid: RespondInvalid = {
  status: 'invalid',
  repairable: true,
  remainingRepairs: 2,
  issues: [
    {
      code: 'MISSING_EVIDENCE',
      path: 'hero.evidenceIds',
      candidateId: 'candidate-1',
      evidenceIds: ['obs-1'],
      message: 'opening-hours evidence is required',
      missingFields: ['opening_hours'],
    },
    {
      code: 'MISSING_EVIDENCE',
      path: 'alts.0.evidenceIds',
      candidateId: 'candidate-2',
      message: 'identity evidence is required',
      missingFields: ['identity'],
    },
  ],
};

describe('submit rejection diagnostic', () => {
  it('reports the structural reason a submit was refused', () => {
    expect(runtimeSubmitRejectionFor(invalid)).toEqual({
      repairable: true,
      remainingRepairs: 2,
      candidates: 2,
      issues: [
        {
          code: 'MISSING_EVIDENCE',
          path: 'hero.evidenceIds',
          message: 'opening-hours evidence is required',
          missingFields: ['opening_hours'],
        },
        {
          code: 'MISSING_EVIDENCE',
          path: 'alts.0.evidenceIds',
          message: 'identity evidence is required',
          missingFields: ['identity'],
        },
      ],
    });
  });

  it('counts candidates without exposing their IDs or any evidence ID', () => {
    const rejection = runtimeSubmitRejectionFor(invalid);
    const serialized = JSON.stringify(rejection);

    expect(rejection.candidates).toBe(2);
    expect(serialized).not.toContain('candidate-1');
    expect(serialized).not.toContain('obs-1');
  });

  it('counts only distinct candidates and tolerates issues without one', () => {
    const budgetDenial: RespondInvalid = {
      status: 'invalid',
      repairable: false,
      remainingRepairs: 0,
      issues: [
        { code: 'BUDGET_EXCEEDED', path: null, message: 'submit budget spent', missingFields: [] },
      ],
    };

    const first = invalid.issues[0];
    if (first === undefined) throw new Error('fixture requires an issue');

    expect(runtimeSubmitRejectionFor(budgetDenial).candidates).toBe(0);
    expect(
      runtimeSubmitRejectionFor({
        ...invalid,
        issues: [first, { ...first, path: 'hero.openingHours' }],
      }).candidates,
    ).toBe(1);
  });

  it('never lets a failing writer change the observed submit', () => {
    const seen: RuntimeSubmitRejection[] = [];

    expect(() =>
      observeRuntimeSubmitRejection(invalid, () => {
        throw new Error('writer unavailable');
      }),
    ).not.toThrow();
    observeRuntimeSubmitRejection(invalid, (rejection) => seen.push(rejection));
    expect(seen).toHaveLength(1);
  });
});

describe('runtime turn observer', () => {
  it('keeps the log lines and hands the same records to a host observer', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcomes: RuntimeTurnOutcome[] = [];
    const rejections: RuntimeSubmitRejection[] = [];
    const writers = runtimeTurnObserverWriters({
      outcome: (outcome) => outcomes.push(outcome),
      respondRejected: (rejection) => rejections.push(rejection),
    });
    const outcome = { committed: true, operations: { respond: 1 }, kind: 'ask' } as const;
    writers.onTurnOutcome(outcome);
    writers.onSubmitRejected(runtimeSubmitRejectionFor(invalid));

    expect(outcomes).toEqual([outcome]);
    expect(rejections).toEqual([runtimeSubmitRejectionFor(invalid)]);
    expect(info).toHaveBeenCalledWith(JSON.stringify({ event: 'turn_outcome', ...outcome }));
    expect(warn).toHaveBeenCalledTimes(1);
    info.mockRestore();
    warn.mockRestore();
  });
});
