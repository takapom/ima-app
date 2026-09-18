import { HttpBoundaryError } from '@worker/infrastructure/adapters/inbound/http/errors';
import type { PhotoBodyHandler } from '@worker/infrastructure/adapters/inbound/http/handler';
import { createPhotoBodyHandler } from '@worker/infrastructure/adapters/inbound/http/photo-body-handler';
import { configuredPhotoTokenCodec } from '@worker/composition/photo-token-configuration';
import { createHotPepperPhotoTransport } from '@worker/infrastructure/adapters/outbound/providers/hot-pepper/photo-transport';
import { resolveRuntimeOperationalGate } from '@worker/composition/runtime-operational-gate';

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
