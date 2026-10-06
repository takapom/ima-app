import { describe, expect, it } from 'vitest';
import { searchOutcomeOf } from '@worker/runtime/response/runtime-search-outcome';

const searchOutput = (candidates: number, status: 'ok' | 'partial' = 'ok') => ({
  status,
  data: {
    searchId: 'search-1',
    candidates: Array.from({ length: candidates }, (_, index) => ({
      candidateId: `candidate-${index}`,
    })),
    applied: { areaDescription: '現在地周辺', excludedCount: 0 },
    nextCursor: null,
    coverage: 'provider_results',
  },
  warnings: [],
});
const searchError = {
  status: 'error',
  error: { code: 'PROVIDER_UNAVAILABLE', field: null, message: 'search failed' },
};
const search = (output: unknown) => ({ toolName: 'search_places', output });

describe('search outcome of a turn', () => {
  it('reports no candidates when every search in the turn ran and found none', () => {
    expect(searchOutcomeOf([search(searchOutput(0))])).toBe('no_candidates');
    expect(searchOutcomeOf([search(searchOutput(0)), search(searchOutput(0))])).toBe(
      'no_candidates',
    );
  });

  it('reports nothing once any search found a candidate, even after empty ones', () => {
    expect(searchOutcomeOf([search(searchOutput(0)), search(searchOutput(2))])).toBeUndefined();
  });

  it('reports nothing when the turn did not search', () => {
    expect(searchOutcomeOf([])).toBeUndefined();
    expect(
      searchOutcomeOf([{ toolName: 'get_place_details', output: { status: 'ok' } }]),
    ).toBeUndefined();
  });

  it('does not turn a failed or partial search into "found nothing"', () => {
    expect(searchOutcomeOf([search(searchError)])).toBeUndefined();
    expect(searchOutcomeOf([search(searchOutput(0, 'partial'))])).toBeUndefined();
    expect(searchOutcomeOf([search(searchOutput(0)), search(searchError)])).toBeUndefined();
  });

  it('ignores the respond result and treats an unreadable search result as unknown', () => {
    expect(
      searchOutcomeOf([search(searchOutput(0)), { toolName: 'respond', output: { ok: true } }]),
    ).toBe('no_candidates');
    expect(searchOutcomeOf([search({ status: 'ok' })])).toBeUndefined();
  });
});
