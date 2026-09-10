import { describe, expect, it, vi } from 'vitest';
import { createJourneyApiComposition } from './composition';

const options = {
  baseUrl: 'http://localhost:8787',
  mode: 'fixture' as const,
  appVersion: 'test',
  credentials: {
    appToken: 'app',
    deviceId: 'device',
    ownerCredential: 'A'.repeat(42) + 'A',
  },
  requestIdFactory: () => 'request-composition',
  fetchImpl: vi.fn(),
};

describe('Journey API composition', () => {
  it('keeps fixture/live selection explicit and reports unavailable local restore', async () => {
    const fixture = createJourneyApiComposition(options);
    expect(fixture.getState().mode).toBe('fixture');
    await expect(fixture.restoreLocal('thread-1')).resolves.toEqual({
      status: 'unavailable',
      reason: 'not_configured',
    });
    expect(fixture.getState().error?.kind).toBe('contract');
  });
});
