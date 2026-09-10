import { describe, expect, it } from 'vitest';
import type { PhotoAsset } from '../services/api/photo-client';
import {
  canCommitPhotoResult,
  isPhotoImageReadyFor,
  photoExpiryDeadline,
  shouldExpirePhoto,
  type PhotoImageIdentity,
  type PhotoImageState,
} from './photo-image-state';

const asset: PhotoAsset = {
  uri: 'data:image/png;base64,AAEC',
  contentType: 'image/png',
  expiresAt: '2026-09-10T12:05:00.000Z',
};

describe('photo image state gates', () => {
  it('does not render a ready image after token, client, or deadline identity changes', () => {
    const client = {};
    const otherClient = {};
    const state: PhotoImageState = {
      status: 'ready',
      token: 'token-1',
      client,
      displayUntil: '2026-09-10T12:05:00.000Z',
      asset,
    };
    const identity: PhotoImageIdentity = {
      client,
      token: 'token-1',
      displayUntil: '2026-09-10T12:05:00.000Z',
    };

    expect(isPhotoImageReadyFor(state, identity)).toBe(true);
    expect(isPhotoImageReadyFor(state, { ...identity, token: 'token-2' })).toBe(false);
    expect(isPhotoImageReadyFor(state, { ...identity, client: otherClient })).toBe(false);
    expect(
      isPhotoImageReadyFor(state, { ...identity, displayUntil: '2026-09-10T12:04:00.000Z' }),
    ).toBe(false);
  });

  it('rejects late results after the active request changes or is cancelled', () => {
    const identity: PhotoImageIdentity = {
      client: {},
      token: 'token-1',
      displayUntil: null,
    };
    expect(canCommitPhotoResult(identity, identity, true, false)).toBe(true);
    expect(canCommitPhotoResult(identity, null, true, false)).toBe(false);
    expect(canCommitPhotoResult(identity, { ...identity, token: 'token-2' }, true, false)).toBe(
      false,
    );
    expect(canCommitPhotoResult(identity, identity, false, false)).toBe(false);
    expect(canCommitPhotoResult(identity, identity, true, true)).toBe(false);
  });

  it('expires at the boundary and stays expired when the clock moves backward', () => {
    const deadline = photoExpiryDeadline(asset, '2026-09-10T12:06:00.000Z');
    if (deadline === null) throw new Error('expected an asset deadline');
    expect(deadline).toBe(Date.parse('2026-09-10T12:05:00.000Z'));
    const expired = new Set<string>();
    expect(shouldExpirePhoto('token-1', deadline, deadline - 1, expired)).toBe(false);
    expect(shouldExpirePhoto('token-1', deadline, deadline, expired)).toBe(true);
    expired.add('token-1');
    expect(shouldExpirePhoto('token-1', deadline, deadline - 60_000, expired)).toBe(true);
  });
});
