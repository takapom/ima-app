import { HttpBoundaryError } from '@worker/infrastructure/adapters/in/http/errors';
import { PhotoProviderError } from '@worker/infrastructure/runtime/ports/photo-media';
import { isHotPepperPhotoIdentity } from '@worker/infrastructure/adapters/out/providers/hot-pepper/conversation-photo-reference';
import type { PhotoBodyHandler } from '@worker/infrastructure/adapters/in/http/handler';
import { createPhotoBodyHandler } from '@worker/infrastructure/adapters/in/http/photo-body-handler';
import { configuredPhotoTokenCodec } from '@worker/platform/composition/photo-token-configuration';
import { createHotPepperPhotoTransport } from '@worker/infrastructure/adapters/out/providers/hot-pepper/photo-transport';
import { resolveRuntimeOperationalGate } from '@worker/platform/composition/runtime-operational-gate';
import { createHotPepperTransport } from '@worker/infrastructure/adapters/out/providers/hot-pepper/transport';
import { createHotPepperConversationPhotoReader } from '@worker/infrastructure/adapters/out/providers/hot-pepper/conversation-photo-reader';
import type { ConversationPhotoReader } from '@worker/infrastructure/runtime/ports/conversation-photo';

export const createConfiguredConversationPhotos = (env: {
  readonly HOTPEPPER_API_KEY?: string;
}): ConversationPhotoReader => ({
  async read(source, signal) {
    /** 未対応や不正な参照を停止や0件へまとめると、誤った取得先が隠れる。 */
    if (!isHotPepperPhotoIdentity(source)) throw new PhotoProviderError('INVALID_REQUEST');
    const gate = resolveRuntimeOperationalGate(env);
    if (gate.modeFor('hotpepper') !== 'live')
      throw new HttpBoundaryError({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
    return createHotPepperConversationPhotoReader(
      createHotPepperTransport({
        ...(env.HOTPEPPER_API_KEY === undefined ? {} : { apiKey: env.HOTPEPPER_API_KEY }),
      }),
      createHotPepperPhotoTransport(),
    ).read(source, signal);
  },
});

export const createConfiguredPhoto = (env: unknown): PhotoBodyHandler => {
  const gate = resolveRuntimeOperationalGate(env);
  const tokenCodec = configuredPhotoTokenCodec(env);
  if (tokenCodec === undefined || gate.modeFor('hotpepper') !== 'live')
    return {
      read: () =>
        Promise.reject(new HttpBoundaryError({ status: 502, code: 'PROVIDER_UNAVAILABLE' })),
    };
  return createPhotoBodyHandler({
    tokenCodec,
    transport: createHotPepperPhotoTransport(),
  });
};
