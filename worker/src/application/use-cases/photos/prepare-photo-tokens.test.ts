import { describe, expect, it, vi } from 'vitest';
import {
  preparePhotoTokens,
  PhotoTokenPreparationError,
} from '@worker/application/use-cases/photos/prepare-photo-tokens';
import type { PhotoTokenIssuer } from '@worker/application/ports/photo-token-issuer';

const context = {
  ownerScopeRef: 'owner',
  threadId: 'thread',
  sourceTurnId: 'turn',
  sourceRevision: 1,
  deviceId: 'device',
  now: '2026-09-10T12:00:00.000Z',
};
const observation = {
  candidateId: 'candidate',
  photoRef: 'opaque-reference',
  displayAllowed: true,
  sessionExpiresAt: '2026-09-10T13:00:00.000Z',
  displayUntil: '2026-09-10T12:20:00.000Z',
  providerExpiresAt: '2026-09-10T12:10:00.000Z',
};

describe('photo token issuance through the application port', () => {
  it('intersects duplicate evidence lifetimes before issuing one scoped token', async () => {
    const issue = vi.fn<PhotoTokenIssuer['issue']>(() =>
      Promise.resolve({ status: 'issued', token: 'token' }),
    );
    const result = await preparePhotoTokens(
      { issue },
      [
        observation,
        {
          ...observation,
          displayUntil: '2026-09-10T12:05:00.000Z',
        },
      ],
      context,
    );
    expect(issue).toHaveBeenCalledExactlyOnceWith(
      {
        ownerScopeRef: 'owner',
        threadId: 'thread',
        turnId: 'turn',
        revision: 1,
        deviceId: 'device',
        photoRef: 'opaque-reference',
        expiresAt: '2026-09-10T12:05:00.000Z',
      },
      context.now,
    );
    expect(result.resolve('candidate', 'opaque-reference')).toBe('token');
  });

  it('withholds the whole duplicate group if any observation denies display', async () => {
    const issue = vi.fn<PhotoTokenIssuer['issue']>(() =>
      Promise.resolve({ status: 'issued', token: 'token' }),
    );
    const result = await preparePhotoTokens(
      { issue },
      [observation, { ...observation, displayAllowed: false }],
      context,
    );
    expect(issue).not.toHaveBeenCalled();
    expect(result.withheldCount).toBe(1);
  });

  it('distinguishes an adapter withholding a token from an unexpected failure', async () => {
    const issue = vi.fn<PhotoTokenIssuer['issue']>(() => Promise.resolve({ status: 'withheld' }));
    const result = await preparePhotoTokens({ issue }, [observation], context);
    expect(result.issuedCount).toBe(0);
    expect(result.resolve('candidate', 'opaque-reference')).toBeUndefined();
    issue.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(preparePhotoTokens({ issue }, [observation], context)).rejects.toThrow(
      'storage unavailable',
    );
  });

  it('does not call the issuer with an invalid execution context', async () => {
    const issue = vi.fn<PhotoTokenIssuer['issue']>(() => Promise.resolve({ status: 'withheld' }));
    await expect(
      preparePhotoTokens({ issue }, [observation], { ...context, sourceRevision: 0 }),
    ).rejects.toThrow(PhotoTokenPreparationError);
    expect(issue).not.toHaveBeenCalled();
  });
});
