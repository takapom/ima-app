import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { PreferencesSchema, SearchRequestSchema } from '@contracts/preferences';

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

describe('legacy travel preference keys', () => {
  const legacy = {
    homeStationRef: 'station-shibuya',
    maxWalkMinutes: 15,
    minimumStayMinutes: null,
    areaText: '恵比寿',
    budget: 'normal',
  };

  it('accepts keys sent by builds before #55 and drops them from the output', () => {
    const parsed = v.safeParse(PreferencesSchema, legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.output).toEqual({ areaText: '恵比寿', budget: 'normal' });
    const request = v.safeParse(SearchRequestSchema, { ...baseRequest, prefs: legacy });
    expect(request.success).toBe(true);
    if (request.success)
      expect(request.output.prefs).toEqual({ areaText: '恵比寿', budget: 'normal' });
  });

  it('still rejects invalid legacy values and unrelated keys', () => {
    expect(v.safeParse(PreferencesSchema, { ...legacy, maxWalkMinutes: 0 }).success).toBe(false);
    expect(v.safeParse(PreferencesSchema, { ...legacy, stationLabel: '渋谷' }).success).toBe(false);
  });
});
