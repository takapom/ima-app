import { HttpBoundaryError } from './http/errors';
import type { PhotoBodyHandler } from './http/handler';
import { createPhotoBodyHandler } from './providers/photo/http';
import { configuredPhotoTokenCodec } from './providers/photo/configuration';
import { createHotPepperPhotoTransport } from './providers/hot-pepper/photo-transport';
import { resolveRuntimeOperationalGate } from './runtime/composition/runtime-operational-gate';

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
