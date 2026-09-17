import { HttpBoundaryError } from '@api/http/errors';
import type { PhotoBodyHandler } from '@api/http/handler';
import { createPhotoBodyHandler } from '@api/providers/photo/http';
import { configuredPhotoTokenCodec } from '@api/providers/photo/configuration';
import { createHotPepperPhotoTransport } from '@api/providers/hot-pepper/photo-transport';
import { resolveRuntimeOperationalGate } from '@api/runtime/composition/runtime-operational-gate';

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
