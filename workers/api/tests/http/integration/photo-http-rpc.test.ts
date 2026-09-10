import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveOwnerScopeRef } from '../../../src/http/auth';
import { createHttpRouterConfig, createThreadScopeAuthorizer } from '../../../src/bootstrap';
import { routeRequest } from '../../../src/http/router';
import { createPhotoReferenceStoreResolver } from '../../../src/providers/photo/rpc';
import { createPhotoTokenCodec } from '../../../src/providers/photo/token';
import type { TelemetryDO } from '../../../src/telemetry/telemetry-do';
import type { RateLimitDO, ThreadDO } from '../../../src/thread-do';

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
const PHOTO_URI = 'https://lh3.googleusercontent.com/p/fixture=w800-h600';

describe('M15 production router with ThreadDO photo references', () => {
  it('issues through the per-thread DO and serves the token-bound binary response', async () => {
    const bindings = testEnv(env);
    const threadId = `m15-photo-http-${crypto.randomUUID()}`;
    const requestId = `photo-http-${crypto.randomUUID()}`;
    const serverNow = new Date().toISOString();
    const ownerScopeRef = await deriveOwnerScopeRef(OWNER_CREDENTIAL);
    if (ownerScopeRef === null) throw new Error('owner scope fixture invalid');
    const stub = bindings.THREADS.getByName(threadId);
    await expect(stub.initialize(ownerScopeRef, threadId)).resolves.toMatchObject({ ok: true });

    const codec = createPhotoTokenCodec({
      secret: PHOTO_SECRET,
      referenceResolver: createPhotoReferenceStoreResolver((id) => bindings.THREADS.getByName(id)),
    });
    const token = await codec.issue(
      {
        ownerScopeRef,
        threadId,
        turnId: 'photo-http-turn',
        revision: 1,
        deviceId: DEVICE_ID,
        photoRef: 'places/ChIJfixture/photos/A1B2C3',
      },
      serverNow,
    );
    const transportCalls: Array<{ readonly url: string; readonly headers: Headers }> = [];
    const scheduled: Promise<void>[] = [];
    const photoFetcher: typeof fetch = (url, init) => {
      const parsed = new URL(
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      );
      transportCalls.push({ url: parsed.toString(), headers: new Headers(init?.headers) });
      if (parsed.origin === 'https://places.googleapis.com') {
        return Promise.resolve(
          new Response(JSON.stringify({ photoUri: PHOTO_URI }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(new Uint8Array([3, 4, 5]), {
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      );
    };
    const config = createHttpRouterConfig(
      {
        ...bindings,
        GOOGLE_PLACES_API_KEY: 'photo-api-key-fixture',
        PHOTO_TOKEN_SECRET: PHOTO_SECRET,
        IMA_RUNTIME_MODE: 'fixture',
        IMA_PROVIDER_PLACES: 'true',
        IMA_PROVIDER_OPENAI: 'false',
        IMA_PROVIDER_ROUTES: 'false',
        IMA_PROVIDER_LAST_TRAIN: 'false',
        IMA_PROVIDER_HOTPEPPER: 'false',
        IMA_KILL_SWITCH: 'false',
      },
      {
        ownership: createThreadScopeAuthorizer(bindings.THREADS),
        photoFetcher,
        clock: () => serverNow,
        requestIdFactory: () => requestId,
        waitUntil: (promise) => scheduled.push(promise),
      },
    );
    const requestFor = (deviceId: string, id: string): Request =>
      new Request(`https://ima.test/v1/photos/${encodeURIComponent(token)}`, {
        headers: {
          'x-app-token': bindings.APP_TOKEN,
          'x-device-id': deviceId,
          'x-ima-owner-credential': OWNER_CREDENTIAL,
          'x-ima-request-id': id,
          'x-app-version': 'm15-photo-test',
        },
      });
    const response = await routeRequest(requestFor(DEVICE_ID, requestId), config);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([3, 4, 5]);
    expect(transportCalls).toHaveLength(2);
    const metadataCall = transportCalls[0];
    const imageCall = transportCalls[1];
    if (metadataCall === undefined || imageCall === undefined) {
      throw new Error('photo transport calls missing');
    }
    expect(metadataCall.headers.get('x-goog-api-key')).toBe('photo-api-key-fixture');
    expect(imageCall.headers.has('x-goog-api-key')).toBe(false);
    await Promise.all(scheduled);
    const traceRead = await bindings.TELEMETRY.getByName('telemetry-fixture').readTraceSince(
      new Date(0).toISOString(),
    );
    expect(traceRead.ok).toBe(true);
    if (!traceRead.ok) throw new Error(`photo telemetry read failed: ${traceRead.code}`);
    const photoTraces = traceRead.records.filter(
      (record) =>
        record.operation === 'provider' &&
        record.threadId === threadId &&
        record.turnId === 'photo-http-turn',
    );
    expect(photoTraces).toHaveLength(2);
    expect(photoTraces.every((record) => record.provider === 'photo')).toBe(true);
    expect(photoTraces.every((record) => record.revision === 1)).toBe(true);
    expect(
      photoTraces.every((record) => record.status === 'ok' && record.resultCode === 'OK'),
    ).toBe(true);

    const beforeDisabled = transportCalls.length;
    const disabledConfig = createHttpRouterConfig(
      {
        ...bindings,
        GOOGLE_PLACES_API_KEY: 'photo-api-key-fixture',
        PHOTO_TOKEN_SECRET: PHOTO_SECRET,
        IMA_RUNTIME_MODE: 'live',
        IMA_PROVIDER_PLACES: 'true',
        IMA_PROVIDER_OPENAI: 'false',
        IMA_PROVIDER_ROUTES: 'false',
        IMA_PROVIDER_LAST_TRAIN: 'false',
        IMA_PROVIDER_HOTPEPPER: 'false',
        IMA_KILL_SWITCH: 'true',
      },
      {
        ownership: createThreadScopeAuthorizer(bindings.THREADS),
        photoFetcher,
        clock: () => serverNow,
        requestIdFactory: () => `${requestId}-disabled`,
      },
    );
    const disabledResponse = await routeRequest(
      requestFor(DEVICE_ID, `${requestId}-disabled`),
      disabledConfig,
    );
    expect(disabledResponse.status).toBe(502);
    expect(transportCalls).toHaveLength(beforeDisabled);

    const wrongDevice = await routeRequest(
      requestFor('other-photo-device', `${requestId}-other`),
      config,
    );
    expect(wrongDevice.status).toBe(403);

    await expect(stub.deleteThread(ownerScopeRef, null, 1, `${requestId}-delete`)).resolves.toEqual(
      {
        ok: true,
      },
    );
    const deleted = await routeRequest(requestFor(DEVICE_ID, `${requestId}-deleted`), config);
    expect(deleted.status).toBe(410);
  });
});
