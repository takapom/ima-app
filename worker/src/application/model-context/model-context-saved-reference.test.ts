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
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
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
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['saved-fixture'] as const,
  },
};

const source = (savedReferences: unknown) => ({
  harness,
  userText: '保存した店を確認',
  history: [],
  cardSet: null,
  conditions: { maxWalkMinutes: null, homeStationRef: null, minimumStayMinutes: null },
  evidence: [],
  savedReferences,
});

describe('saved references in model context', () => {
  it('projects only opaque saved references', () => {
    const projected = projectModelContext(source([{ savedPlaceRef: 'saved-1' }]));

    expect(projected.savedReferences).toEqual([{ savedPlaceRef: 'saved-1' }]);
    expect(JSON.stringify(projected)).not.toContain('"provider"');
    expect(JSON.stringify(projected)).not.toContain('"recordRef"');
    expect(JSON.stringify(projected)).not.toContain('"ownerScopeRef"');
  });

  it('rejects duplicate, over-bound, or enriched references before model projection', () => {
    expect(() =>
      projectModelContext(source([{ savedPlaceRef: 'saved-1' }, { savedPlaceRef: 'saved-1' }])),
    ).toThrowError(ModelContextError);
    expect(() =>
      projectModelContext(
        source(Array.from({ length: 51 }, (_, index) => ({ savedPlaceRef: `saved-${index + 1}` }))),
      ),
    ).toThrowError(ModelContextError);
    expect(() =>
      projectModelContext(source([{ savedPlaceRef: 'saved-1', provider: 'google' }])),
    ).toThrowError(ModelContextError);
  });
});
