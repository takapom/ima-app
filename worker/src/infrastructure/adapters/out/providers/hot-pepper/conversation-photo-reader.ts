import type { ConversationPhotoReader } from '@worker/runtime/ports/conversation-photo';
import type { PhotoMediaTransport } from '@worker/runtime/ports/photo-media';
import { PhotoProviderError } from '@worker/runtime/ports/photo-media';
import type { HotPepperTransport } from '@worker/adapters/out/providers/hot-pepper/transport';
import { HotPepperError } from '@worker/adapters/out/providers/hot-pepper/types';
import { HotPepperPhotoUrlSchema } from '@worker/security/photo-resource-policy';
import * as v from 'valibot';

export const createHotPepperConversationPhotoReader = (
  transport: HotPepperTransport,
  images: PhotoMediaTransport,
): ConversationPhotoReader => ({
  async read(recordRef, signal) {
    try {
      const page = await transport.search({ id: [recordRef], count: 1 }, signal);
      const shop = page.shops.find((entry) => entry.id === recordRef);
      if (shop === undefined) {
        if (page.shops.length > 0) throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
        return null;
      }
      const photo = shop.photo?.pc;
      const url = [photo?.l, photo?.m, photo?.s].find((value) =>
        v.is(HotPepperPhotoUrlSchema, value),
      );
      if (url === undefined || url === null) {
        if (
          [photo?.l, photo?.m, photo?.s].some(
            (value) => typeof value === 'string' && value.trim().length > 0,
          )
        )
          throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
        return null;
      }
      return await images.read(url, signal);
    } catch (error) {
      if (error instanceof HotPepperError) {
        if (error.code === 'NOT_FOUND') return null;
        throw new PhotoProviderError(
          error.code === 'TIMEOUT' || error.code === 'CANCELLED' || error.code === 'RATE_LIMITED'
            ? error.code
            : 'UPSTREAM_UNAVAILABLE',
          error.retryAfterMs,
        );
      }
      throw error;
    }
  },
});
