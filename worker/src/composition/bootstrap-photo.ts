import { HttpBoundaryError } from '@worker/adapters/in/http/errors';
import type { PhotoBodyHandler } from '@worker/adapters/in/http/handler';
import { createPhotoBodyHandler } from '@worker/adapters/in/http/photo-body-handler';
import { configuredPhotoTokenCodec } from '@worker/composition/photo-token-configuration';
import { createHotPepperPhotoTransport } from '@worker/adapters/out/providers/hot-pepper/photo-transport';
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
