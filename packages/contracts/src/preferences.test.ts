import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { SearchRequestSchema } from '@contracts/preferences';

const baseRequest = {
  schemaVersion: 'v1',
  requestId: 'request-1',
  threadId: 'thread-1',
  turnId: null,
  revision: 1,
  text: '静かな店',
  clientNow: '2026-09-10T12:00:00Z',
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: null,
    budget: 'normal',
  },
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: 'idempotency-1',
};

describe('display context request fields', () => {
  it('is optional for older clients and validates the displayed order when supplied', () => {
    expect(v.safeParse(SearchRequestSchema, baseRequest).success).toBe(true);
    expect(
      v.safeParse(SearchRequestSchema, {
        ...baseRequest,
        cardSetId: 'card-set-1',
        promotedCandidateId: 'candidate-2',
        selectedCandidateId: 'candidate-2',
        candidateOrder: ['candidate-2', 'candidate-1'],
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(SearchRequestSchema, {
        ...baseRequest,
        cardSetId: 'card-set-1',
        candidateOrder: ['candidate-1', 'candidate-1'],
      }).success,
    ).toBe(false);
  });
});
