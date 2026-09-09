import { describe, expect, it } from 'vitest';
import { projectModelRequest } from './turn';

describe('core application boundary', () => {
  it('projects Harness location and ownership out of model input', () => {
    const request = projectModelRequest({
      userText: '近くの店',
      context: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        revision: 1,
        serverNow: '2026-09-09T12:00:00Z',
        ownerScopeRef: 'owner-1',
        location: {
          status: 'available',
          coordinates: { lat: 35.6, lng: 139.7 },
          accuracyMeters: 50,
          precise: true,
          capturedAt: '2026-09-09T11:59:00Z',
          revision: 1,
        },
        preferences: {
          homeStationRef: null,
          maxWalkMinutes: 15,
          minimumStayMinutes: null,
          areaText: null,
          budget: 'normal',
        },
        budget: {
          wallClockMs: 8_000,
          finalReserveMs: 2_000,
          modelCallsRemaining: 4,
          readCallsRemaining: 8,
          providerHttpRequestsRemaining: 20,
          retriesRemaining: 1,
        },
        capabilities: {
          version: 'fixture-v1',
          detailFields: ['identity'],
          walkingRoute: true,
          lastTrain: true,
          supportedScopes: ['fixture'],
        },
      },
    });
    expect('ownerScopeRef' in request.context).toBe(false);
    expect('coordinates' in request.context.location).toBe(false);
    expect(request.context.location.status).toBe('available');
    expect(request.context.location.accuracyMeters).toBe(50);
    expect(request.context.location.capturedAt).toBe('2026-09-09T11:59:00Z');
  });
});
