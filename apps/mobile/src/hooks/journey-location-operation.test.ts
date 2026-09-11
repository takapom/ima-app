import type { LocationSnapshot } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import {
  locationDraftScopeMatches,
  prepareJourneyLocation,
  unavailableJourneyLocation,
} from './journey-location-operation';

const snapshot: LocationSnapshot = {
  status: 'available',
  lat: 35.6595,
  lng: 139.7005,
  accuracyMeters: 24,
  precise: true,
  capturedAt: '2026-09-11T03:00:00.000Z',
};

describe('prepareJourneyLocation', () => {
  it('keeps requests usable without a host location service', async () => {
    const controller = new AbortController();

    await expect(prepareJourneyLocation(undefined, controller.signal)).resolves.toEqual({
      kind: 'ready',
      snapshot: unavailableJourneyLocation(),
    });
  });

  it('forwards the submit-owned signal and preserves the service snapshot', async () => {
    let receivedSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const service = {
      acquire: ({ signal }: { readonly signal?: AbortSignal } = {}) => {
        receivedSignal = signal;
        return Promise.resolve(snapshot);
      },
    };

    await expect(prepareJourneyLocation(service, controller.signal)).resolves.toEqual({
      kind: 'ready',
      snapshot,
    });
    expect(receivedSignal).toBe(controller.signal);
  });

  it('drops a service cancellation and a caller abort before native work can be adopted', async () => {
    const cancelled = {
      acquire: () => Promise.resolve({ status: 'cancelled' as const }),
    };
    await expect(prepareJourneyLocation(cancelled, new AbortController().signal)).resolves.toEqual({
      kind: 'cancelled',
    });

    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const aborted = {
      acquire: () => {
        calls += 1;
        return Promise.resolve(snapshot);
      },
    };
    await expect(prepareJourneyLocation(aborted, controller.signal)).resolves.toEqual({
      kind: 'cancelled',
    });
    expect(calls).toBe(0);
  });

  it('maps an unexpected host failure to an unavailable snapshot', async () => {
    const service = {
      acquire: () => Promise.reject(new Error('host failure')),
    };

    await expect(prepareJourneyLocation(service, new AbortController().signal)).resolves.toEqual({
      kind: 'ready',
      snapshot: unavailableJourneyLocation(),
    });
  });

  it('allows a cancelled draft to retry only in its original thread scope', () => {
    const draft = { threadId: 'thread-a', revision: 3, turnId: 'turn-a' };

    expect(locationDraftScopeMatches(draft, draft)).toBe(true);
    expect(locationDraftScopeMatches(draft, { ...draft, threadId: 'thread-b' })).toBe(false);
    expect(locationDraftScopeMatches(draft, { ...draft, revision: 4 })).toBe(false);
    expect(locationDraftScopeMatches(draft, { ...draft, turnId: 'turn-b' })).toBe(false);
  });
});
