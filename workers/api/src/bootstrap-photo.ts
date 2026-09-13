import { HttpBoundaryError } from './http/errors';
import type { PhotoBodyHandler } from './http/handler';
import { createPhotoBodyHandler } from './providers/photo/http';
import { PhotoProviderError } from './providers/photo/media';
import { createGooglePhotoMediaTransport } from './providers/photo/transport';
import { createPhotoTokenCodec } from './providers/photo/token';
import { createPhotoReferenceStoreResolver } from './providers/photo/rpc';
import type { PhotoTokenCodec, PhotoTransportTraceIdentity } from './providers/photo/types';
import { createRuntimeProviderTransportObserver } from './providers/telemetry/runtime-provider-trace';
import { createRuntimeProductionTelemetrySinks } from './thread-runtime/runtime-production-telemetry';
import { createDurableTelemetryStore, type TelemetryNamespace } from './telemetry/telemetry-do';
import type { ThreadDO } from './thread-do';
import { resolveRuntimeOperationalGate } from './runtime/composition/runtime-operational-gate';
import { productionClock, productionMonotonicNow } from './runtime/runtime-production-support';
import {
  runtimeTraceModeFor,
  telemetryObjectNameForRuntimeTraceMode,
} from './runtime/runtime-turn-trace';
import {
  createDevFixturePhotoBodyHandler,
  devFixtureEnvironmentFor,
  isKeylessDevFixtureEnvironment,
} from './runtime/composition/runtime-dev-fixture';

type PhotoBootstrapEnv = {
  readonly GOOGLE_PLACES_API_KEY?: string;
  readonly PHOTO_TOKEN_SECRET?: string;
  readonly IMA_RUNTIME_MODE?: string;
  readonly THREADS: DurableObjectNamespace<ThreadDO>;
  readonly TELEMETRY?: TelemetryNamespace;
};

type PhotoBootstrapOptions = {
  readonly photoFetcher?: typeof fetch;
  readonly waitUntil?: (promise: Promise<void>) => void;
  readonly clock?: () => string;
};

const unavailablePhoto = (): HttpBoundaryError =>
  new HttpBoundaryError({ status: 502, code: 'PROVIDER_UNAVAILABLE' });

const createUnavailablePhoto = (tokenCodec?: PhotoTokenCodec): PhotoBodyHandler => {
  if (tokenCodec === undefined) {
    return {
      read() {
        return Promise.reject(unavailablePhoto());
      },
    };
  }
  return createPhotoBodyHandler({
    tokenCodec,
    transport: {
      read: () => Promise.reject(new PhotoProviderError('UPSTREAM_UNAVAILABLE')),
    },
  });
};

export const createConfiguredPhoto = (
  env: PhotoBootstrapEnv,
  options: PhotoBootstrapOptions,
): PhotoBodyHandler => {
  const keylessFixture = isKeylessDevFixtureEnvironment(env);
  const operational = resolveRuntimeOperationalGate(
    keylessFixture ? devFixtureEnvironmentFor(env) : env,
  );
  if (keylessFixture && operational.enabled('places')) {
    return createDevFixturePhotoBodyHandler((threadId) => env.THREADS.getByName(threadId));
  }
  const tokenSecret = env.PHOTO_TOKEN_SECRET?.trim();
  if (tokenSecret === undefined || tokenSecret.length === 0) return createUnavailablePhoto();
  const tokenCodec = createPhotoTokenCodec({
    secret: tokenSecret,
    referenceResolver: createPhotoReferenceStoreResolver((threadId) =>
      env.THREADS.getByName(threadId),
    ),
  });
  if (!operational.enabled('places')) return createUnavailablePhoto(tokenCodec);
  if (operational.mode === 'fixture' && options.photoFetcher === undefined) {
    // Fixture mode must receive an injected fetcher; it never falls through to global fetch.
    return createUnavailablePhoto(tokenCodec);
  }
  const apiKey = env.GOOGLE_PLACES_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) return createUnavailablePhoto(tokenCodec);
  const telemetryStore =
    env.TELEMETRY === undefined
      ? undefined
      : createDurableTelemetryStore(
          env.TELEMETRY,
          telemetryObjectNameForRuntimeTraceMode(runtimeTraceModeFor(env.IMA_RUNTIME_MODE)),
        );
  const telemetrySinks = createRuntimeProductionTelemetrySinks({
    store: telemetryStore,
    schedule:
      options.waitUntil ??
      ((promise) => {
        void promise.catch(() => undefined);
      }),
  });
  const providerTraceSink = telemetrySinks.provider;
  const providerTraceObserverFor =
    providerTraceSink === undefined
      ? undefined
      : (identity: PhotoTransportTraceIdentity) =>
          createRuntimeProviderTransportObserver({
            ...identity,
            clock: options.clock ?? productionClock,
            monotonicNow: productionMonotonicNow,
            sink: providerTraceSink,
          });
  const transport = createGooglePhotoMediaTransport({
    apiKey,
    fetcher: options.photoFetcher ?? fetch,
  });
  return createPhotoBodyHandler({
    tokenCodec,
    transport,
    ...(providerTraceObserverFor === undefined ? {} : { providerTraceObserverFor }),
  });
};
