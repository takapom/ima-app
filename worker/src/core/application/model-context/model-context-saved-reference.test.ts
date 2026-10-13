import { describe, expect, it } from 'vitest';
import {
  ModelContextError,
  projectModelContext,
} from '@worker/application/model-context/model-context';

const harness = {
  threadId: 'thread-saved',
  turnId: 'turn-saved',
  revision: 1,
  serverNow: '2026-09-10T12:00:00Z',
  ownerScopeRef: 'owner-saved',
  location: {
    status: 'unavailable' as const,
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision: 1,
  },
  preferences: {
    areaText: null,
    budget: null,
  },
  budget: {
    wallClockMs: 1_000,
    finalReserveMs: 100,
    modelCallsRemaining: 1,
    readCallsRemaining: 1,
    providerHttpRequestsRemaining: 1,
    retriesRemaining: 0,
  },
  capabilities: {
    version: 'saved-v1',
    detailFields: ['identity'] as const,
    supportedScopes: ['saved-fixture'] as const,
  },
};

const source = (savedReferences: unknown) => ({
  harness,
  userText: '保存した店を確認',
  history: [],
  cardSet: null,
  evidence: [],
  savedReferences,
});

describe('saved references in model context', () => {
  it('rejects saved references removed from the model context (#54)', () => {
    expect(() => projectModelContext(source([{ savedPlaceRef: 'saved-1' }]))).toThrowError(
      ModelContextError,
    );
  });
});
