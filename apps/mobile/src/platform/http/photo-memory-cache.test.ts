import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhotoMemoryCache } from '@mobile/platform/http/photo-memory-cache';

const asset = {
  uri: 'data:image/png;base64,AA==',
  contentType: 'image/png',
  expiresAt: '2026-10-02T01:30:00Z',
};
const now = Date.parse('2026-10-02T01:00:00Z');
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe('history photo memory lifetime', () => {
  it('forgets expired images even without a subsequent read', () => {
    vi.useFakeTimers();
    const cache = new PhotoMemoryCache();
    cache.selectScope('owner-a');
    cache.write('owner-a', 'photo', asset, now);
    expect(cache.read('photo', now)).toEqual(asset);
    vi.advanceTimersByTime(30 * 60_000);
    expect(cache.read('photo', now)).toBeUndefined();
  });
  it('does not restore late results after owner changes or conversation deletion', () => {
    vi.useFakeTimers();
    const cache = new PhotoMemoryCache();
    cache.selectScope('owner-a');
    cache.write('owner-a', 'photo', asset, now);
    cache.selectScope('owner-b');
    cache.write('owner-a', 'late', asset, now);
    expect(cache.read('photo', now)).toBeUndefined();
    expect(cache.read('late', now)).toBeUndefined();
    cache.clear();
    cache.write('owner-b', 'deleted', asset, now);
    expect(cache.read('deleted', now)).toBeUndefined();
  });
  it('bounds decoded image retention and discards an explicit retry target', () => {
    vi.useFakeTimers();
    const cache = new PhotoMemoryCache();
    cache.selectScope('owner');
    for (let i = 0; i < 13; i++) cache.write('owner', String(i), asset, now);
    expect(cache.read('0', now)).toBeUndefined();
    expect(cache.read('12', now)).toEqual(asset);
    expect(cache.read('12', now, true)).toBeUndefined();
    expect(cache.read('12', now)).toBeUndefined();
  });
});
