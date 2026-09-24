/**
 * Shared DTO fixtures for the contracts test suite. This module stays out of the
 * package's public exports: it is test data, not part of the published contract.
 */
export const timestamp = '2026-09-09T12:00:00Z';
export const retention = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T05:00:00+09:00',
  freshUntil: timestamp,
  displayUntil: '2026-09-09T13:00:00Z',
  retentionUntil: '2026-09-10T05:00:00+09:00',
  deletionScheduledAt: '2026-09-10T05:00:00+09:00',
  attribution: { label: 'Example source', sourceLink: 'https://example.com/source' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};
export const evidence = {
  evidenceId: 'obs-1',
  attribution: { label: 'Example source', sourceLink: 'https://example.com/source' },
  retention,
};
export const message = {
  text: '徒歩で行きやすい候補です',
  retention,
};
export const identity = {
  status: 'known',
  value: {
    name: 'Melt',
    area: '恵比寿',
    address: null,
    category: 'cafe',
    stationName: null,
    accessText: null,
    businessStatus: 'operational',
    sourceUrl: 'https://example.com/place',
  },
  evidence: [evidence],
};
export const card = {
  candidateId: 'candidate-1',
  facts: { identity },
  why: message,
};
export const searchRequest = {
  schemaVersion: 'v1',
  requestId: 'request-1',
  threadId: 'thread-1',
  turnId: null,
  revision: 1,
  text: '静かで甘いもの',
  clientNow: timestamp,
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    areaText: '恵比寿',
    budget: 'normal',
  },
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: 'idem-1',
};
