import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveOwnerScopeRef } from '@worker/adapters/in/http/auth';
import { createHttpRouterConfig, createThreadScopeAuthorizer } from '@worker/composition/bootstrap';
import { routeRequest } from '@worker/adapters/in/http/router';
import { createPhotoReferenceStoreResolver } from '@worker/adapters/out/persistence/photo/rpc';
import { createPhotoTokenCodec } from '@worker/adapters/out/security/photo-token-codec';
import type { TelemetryDO } from '@worker/adapters/out/persistence/telemetry/telemetry-do';
import type { RateLimitDO, ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';

type PhotoHttpEnv = Cloudflare.Env & {
  readonly APP_TOKEN: string;
  readonly THREADS: DurableObjectNamespace<ThreadDO>;
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitDO>;
  readonly TELEMETRY: DurableObjectNamespace<TelemetryDO>;
};

const hasPhotoHttpBindings = (value: typeof env): value is PhotoHttpEnv =>
  typeof value === 'object' &&
  value !== null &&
  'THREADS' in value &&
  'RATE_LIMITS' in value &&
  'TELEMETRY' in value &&
  'APP_TOKEN' in value;

const testEnv = (value: typeof env): PhotoHttpEnv => {
  if (!hasPhotoHttpBindings(value)) throw new Error('M15_PHOTO_HTTP_BINDING_MISSING');
  return value;
};

const OWNER_CREDENTIAL = 'A'.repeat(42) + 'E';
const DEVICE_ID = 'photo-device';
const PHOTO_SECRET = 'photo-http-rpc-secret';
describe('removed production photo provider', () => {
  it('does not call an external provider for a stored legacy photo token', async () => {
    const bindings = testEnv(env);
    const threadId = `photo-disabled-${crypto.randomUUID()}`;
    const ownerScopeRef = await deriveOwnerScopeRef(OWNER_CREDENTIAL);
    if (ownerScopeRef === null) throw new Error('Invalid fixture owner');
    await bindings.THREADS.getByName(threadId).initialize(ownerScopeRef, threadId);
    const codec = createPhotoTokenCodec({
      secret: PHOTO_SECRET,
      referenceResolver: createPhotoReferenceStoreResolver((id) => bindings.THREADS.getByName(id)),
    });
    const token = await codec.issue(
      {
        ownerScopeRef,
        threadId,
        turnId: 'legacy-turn',
        revision: 1,
        deviceId: DEVICE_ID,
        photoRef: 'places/ChIJfixture/photos/A1B2C3',
      },
      new Date().toISOString(),
    );
    const config = createHttpRouterConfig(bindings, {
      ownership: createThreadScopeAuthorizer(bindings.THREADS),
    });
    const response = await routeRequest(
      new Request(`https://ima.test/v1/photos/${token}`, {
        headers: {
          'x-app-token': bindings.APP_TOKEN,
          'x-device-id': DEVICE_ID,
          'x-ima-owner-credential': OWNER_CREDENTIAL,
          'x-ima-request-id': crypto.randomUUID(),
          'x-app-version': 'photo-disabled-test',
        },
      }),
      config,
    );
    expect(response.status).toBe(404);
  });
});
