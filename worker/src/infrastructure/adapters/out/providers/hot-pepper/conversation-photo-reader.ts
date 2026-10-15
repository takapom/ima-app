import type { ConversationPhotoReader } from '@worker/infrastructure/runtime/ports/conversation-photo';
import type { PhotoMediaTransport } from '@worker/infrastructure/runtime/ports/photo-media';
import { PhotoProviderError } from '@worker/infrastructure/runtime/ports/photo-media';
import { isHotPepperPhotoRecordRef } from '@worker/infrastructure/adapters/out/providers/hot-pepper/conversation-photo-reference';
import type { HotPepperTransport } from '@worker/infrastructure/adapters/out/providers/hot-pepper/transport';
import { HotPepperError } from '@worker/infrastructure/adapters/out/providers/hot-pepper/types';
import { HotPepperPhotoUrlSchema } from '@worker/policy/security/photo-resource-policy';
import * as v from 'valibot';

export const createHotPepperConversationPhotoReader = (
  transport: HotPepperTransport,
  images: PhotoMediaTransport,
): ConversationPhotoReader => ({
  async read(recordRef, signal) {
    /** 形式外のIDを検索へ渡すと、入力異常が掲載終了の null と区別できなくなる。 */
    if (!isHotPepperPhotoRecordRef(recordRef)) throw new PhotoProviderError('INVALID_REQUEST');
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
