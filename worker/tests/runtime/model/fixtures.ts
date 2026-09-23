import {
  projectModelContext,
  type ProjectedModelContext,
} from '@worker/application/model-context/model-context';

export const createModelContext = (): ProjectedModelContext =>
  projectModelContext({
    harness: {
      threadId: 'thread-1',
      turnId: 'turn-4',
      revision: 4,
      serverNow: '2026-09-10T12:00:00Z',
      ownerScopeRef: 'owner-1',
      location: {
        status: 'available',
        coordinates: { lat: 35.6, lng: 139.7 },
        accuracyMeters: 25,
        precise: true,
        capturedAt: '2026-09-10T11:59:00Z',
        revision: 2,
      },
      preferences: {
        homeStationRef: 'station-shibuya',
        maxWalkMinutes: 15,
        minimumStayMinutes: 30,
        areaText: '恵比寿',
        budget: 'normal',
      },
      budget: {
        wallClockMs: 8_000,
        finalReserveMs: 2_000,
        modelCallsRemaining: 3,
        readCallsRemaining: 6,
        providerHttpRequestsRemaining: 12,
        retriesRemaining: 1,
      },
      capabilities: {
        version: 'places-v1',
        detailFields: ['identity', 'opening_hours'],
        supportedScopes: ['fixture'],
      },
    },
    userText: 'なぜ二つ目？ もう少し近く、静かさは維持して。',
    history: [
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        role: 'user',
        text: '静かで甘いものがある店',
        evidenceIds: [],
        basis: 'conversational',
      },
      {
        threadId: 'thread-1',
        turnId: 'turn-2',
        role: 'assistant',
        text: '候補を3つ出しました。',
        evidenceIds: [],
        basis: 'conversational',
      },
    ],
    cardSet: null,
    evidence: [],
  });
