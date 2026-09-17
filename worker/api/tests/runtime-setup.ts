import { afterEach, beforeEach, expect, vi } from 'vitest';

// Service/DO bindings still execute locally; outbound network calls must never escape a fixture.
const outboundFetch = vi.fn<typeof fetch>(() =>
  Promise.reject(new Error('RUNTIME_FIXTURE_OUTBOUND_FETCH_FORBIDDEN')),
);

beforeEach(() => {
  outboundFetch.mockClear();
  vi.stubGlobal('fetch', outboundFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(outboundFetch).not.toHaveBeenCalled();
});
