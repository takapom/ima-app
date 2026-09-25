import { expect, it, vi } from 'vitest';
import { createPhotoTokenIssuer } from '@worker/adapters/out/security/photo-token-issuer';
import type { PhotoTokenCodec } from '@worker/runtime/ports/photo';

it('rejects an untrusted photo URL before invoking signing or storage', async () => {
  const issue = vi.fn<PhotoTokenCodec['issue']>(() => Promise.resolve('token'));
  const issuer = createPhotoTokenIssuer({
    issue,
    verify: () => Promise.reject(new Error('unused')),
  });
  expect(
    await issuer.issue(
      {
        ownerScopeRef: 'owner',
        threadId: 'thread',
        turnId: 'turn',
        revision: 1,
        deviceId: 'device',
        photoRef: 'https://untrusted.example/image.jpg',
        expiresAt: '2026-09-10T12:05:00.000Z',
      },
      '2026-09-10T12:00:00.000Z',
    ),
  ).toEqual({ status: 'withheld' });
  expect(issue).not.toHaveBeenCalled();
});
