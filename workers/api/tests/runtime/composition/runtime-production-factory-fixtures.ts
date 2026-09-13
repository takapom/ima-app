import type { ThreadTurnRequest } from '@ima/contracts';
import type { CommitPort, ModelContextFieldPolicy, RetentionMetadata } from '@ima/core';

export const NOW = '2026-09-10T00:00:00.000Z';

/** Explicitly injected provider gates for tests that use fixture model/fetch implementations. */
export const FIXTURE_OPERATIONAL_ENV = {
  IMA_RUNTIME_MODE: 'fixture',
  IMA_PROVIDER_OPENAI: 'true',
  IMA_PROVIDER_PLACES: 'true',
  IMA_PROVIDER_ROUTES: 'true',
  IMA_PROVIDER_LAST_TRAIN: 'true',
  IMA_PROVIDER_HOTPEPPER: 'false',
  IMA_KILL_SWITCH: 'false',
} as const;

export const ALLOW_RETENTION = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T04:00:00.000Z',
  freshUntil: '2026-09-10T01:00:00.000Z',
  displayUntil: '2026-09-10T02:00:00.000Z',
  retentionUntil: '2026-09-10T03:00:00.000Z',
  deletionScheduledAt: '2026-09-10T03:00:00.000Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
} satisfies RetentionMetadata;

export const ALLOW_MODEL_CONTEXT_FIELDS: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    photos: 'allow',
    contact: 'allow',
    facilities: 'allow',
    walking_route: 'allow',
    last_train: 'allow',
  },
  history: 'deny',
  cardSet: 'deny',
  displayName: 'deny',
};

export const requestInput: ThreadTurnRequest = {
  schemaVersion: 'v1',
  requestId: 'request-production-factory',
  turnId: 'turn-production-factory',
  revision: 1,
  text: '静かなカフェを探して',
  clientNow: NOW,
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
  idempotencyKey: 'idempotency-production-factory',
};

export const buildRequest = {
  ownerScopeRef: 'owner-production-factory',
  threadId: 'thread-production-factory',
  turnId: 'turn-production-factory',
  revision: 1,
  messages: [],
  runtimeInput: requestInput,
  serverNow: NOW,
};

export const readOnlyCommit: CommitPort = {
  commit: () => ({
    status: 'conflict',
    conflict: { code: 'STALE_REVISION', message: 'read-only factory test' },
  }),
};
