import * as v from 'valibot';
import { env } from 'cloudflare:test';
import { SavedReferenceResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import type { GooglePlaceDetailsTransport } from '../src/providers/places-details/types';
import {
  createApplicationScopeAuthorizer,
  createHttpRouterConfig,
  createThreadScopeAuthorizer,
} from '../src/bootstrap';
import { routeRequest } from '../src/http/router';
import {
  createConfiguredSavedReferenceRefresh,
  type SavedReferenceRefreshRetentionPolicy,
} from '../src/saved-references/saved-reference-refresh';
import {
  EXPIRES_AT,
  START_NOW,
  bodyFor,
  configuredEnvironment,
  contextFor,
  handlerFor,
  httpRequest,
  operationFor,
  ownerFor,
  readError,
  registerReference,
  responseFor,
  retentionAfterAdmission,
  retentionFor,
  testEnv,
} from './runtime-production-saved-reference-refresh-fixtures';

describe('threadless saved-reference refresh production composition', () => {
  it('routes owner-scoped refresh through the real SavedReferenceDO and publishes a request-scoped identity', async () => {
    const { credential, owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-http-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    let now = START_NOW;
    let providerCalls = 0;
    const transport: GooglePlaceDetailsTransport = {
      read: (request, signal) => {
        providerCalls += 1;
        expect(signal?.aborted).toBe(false);
        return Promise.resolve({
          ...responseFor(recordRef),
          placeId: request.placeId,
          fields: request.fields,
        });
      },
    };
    const config = createHttpRouterConfig(configuredEnvironment(testEnv(env).SAVED_REFERENCES), {
      ownership: createApplicationScopeAuthorizer(
        createThreadScopeAuthorizer(testEnv(env).THREADS),
        testEnv(env).SAVED_REFERENCES,
      ),
      clock: () => now,
      savedReferenceRefreshTransport: transport,
      savedReferenceRefreshPolicy: retentionFor,
      requestIdFactory: () => 'refresh-generated-request',
    });
    const requestId = `refresh-http-${crypto.randomUUID()}`;
    const response = await routeRequest(
      httpRequest(`/v1/saved/${reference.savedPlaceRef}/refresh`, credential, requestId),
      config,
    );
    expect(response.status).toBe(200);
    const parsed = v.safeParse(SavedReferenceResponseSchema, await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('M16_REFRESH_RESPONSE_INVALID');
    expect(parsed.output.requestId).toBe(requestId);
    expect(parsed.output.savedPlaceRef).toBe(reference.savedPlaceRef);
    expect(parsed.output.candidate.candidateId).not.toBe(reference.recordRef);
    const item = parsed.output.data.items[0];
    expect(item).toBeDefined();
    const identity = item?.fields.identity;
    expect(identity).toBeDefined();
    if (identity === undefined || identity.status !== 'known') {
      throw new Error('M16_REFRESH_IDENTITY_NOT_KNOWN');
    }
    expect(identity.value.area).toBe('東京都渋谷区恵比寿1-1-1');
    expect(identity.evidence[0]?.attribution?.label).toBe('Google Maps');
    expect(providerCalls).toBe(1);
    now = START_NOW;
  });

  it('keeps provider and public identity issuance at zero for foreign, disabled, or missing-policy admission', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-gates-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    let calls = 0;
    const transport: GooglePlaceDetailsTransport = {
      read: () => {
        calls += 1;
        return Promise.resolve(responseFor(recordRef));
      },
    };
    const base = configuredEnvironment(testEnv(env).SAVED_REFERENCES);
    expect(
      createConfiguredSavedReferenceRefresh(
        { ...base, IMA_RUNTIME_MODE: 'disabled' },
        { transport, retentionFor },
      ),
    ).toBeUndefined();
    expect(
      createConfiguredSavedReferenceRefresh(
        { ...base, IMA_KILL_SWITCH: 'maybe' },
        { transport, retentionFor },
      ),
    ).toBeUndefined();
    expect(
      createConfiguredSavedReferenceRefresh(
        { ...base, GOOGLE_PLACES_API_KEY: '   ' },
        { transport, retentionFor },
      ),
    ).toBeUndefined();
    expect(createConfiguredSavedReferenceRefresh(base, { transport })).toBeUndefined();
    expect(createConfiguredSavedReferenceRefresh(base, { retentionFor })).toBeUndefined();
    const handler = handlerFor(transport, {
      candidateIdFactory: () => {
        throw new Error('M16_REFRESH_ID_MUST_NOT_BE_ISSUED');
      },
    });
    const foreignContext = contextFor(`owner-foreign-${crypto.randomUUID()}`);
    const foreignError = await readError(
      handler.handle(operationFor(reference.savedPlaceRef), foreignContext),
    );
    expect(foreignError.failure).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(calls).toBe(0);
  });

  it('uses request admission time for the fixed 05:00 session cap and refuses expiry after provider wait', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-expiry-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    let now = START_NOW;
    let candidateCalls = 0;
    const handler = handlerFor(
      {
        read: () => {
          now = EXPIRES_AT;
          return Promise.resolve(responseFor(recordRef));
        },
      },
      {
        clock: () => now,
        retentionFor: retentionAfterAdmission,
        candidateIdFactory: () => {
          candidateCalls += 1;
          return `refresh-candidate-${crypto.randomUUID()}`;
        },
      },
    );
    const error = await readError(
      handler.handle(operationFor(reference.savedPlaceRef), contextFor(owner)),
    );
    expect(error.failure).toEqual({ status: 410, code: 'EXPIRED' });
    expect(candidateCalls).toBe(0);
  });

  it('re-checks the response after ID allocation when the clock crosses expiry', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-id-expiry-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    let now = START_NOW;
    let candidateCalls = 0;
    const handler = handlerFor(
      { read: () => Promise.resolve(responseFor(recordRef)) },
      {
        clock: () => now,
        candidateIdFactory: () => {
          candidateCalls += 1;
          now = EXPIRES_AT;
          return `refresh-candidate-${crypto.randomUUID()}`;
        },
      },
    );
    const error = await readError(
      handler.handle(operationFor(reference.savedPlaceRef), contextFor(owner)),
    );
    expect(error.failure).toEqual({ status: 410, code: 'EXPIRED' });
    expect(candidateCalls).toBe(1);
  });

  it('fails closed when the Worker clock moves before request admission', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-clock-rollback-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    let candidateCalls = 0;
    const error = await readError(
      handlerFor(
        { read: () => Promise.resolve(responseFor(recordRef)) },
        {
          clock: () => '2026-09-09T19:59:58.000Z',
          candidateIdFactory: () => {
            candidateCalls += 1;
            return `refresh-candidate-${crypto.randomUUID()}`;
          },
        },
      ).handle(operationFor(reference.savedPlaceRef), contextFor(owner)),
    );
    expect(error.failure).toEqual({ status: 500, code: 'INTERNAL' });
    expect(candidateCalls).toBe(0);
  });

  it('maps an expired display policy to the public expiry failure', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-display-expired-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    let candidateCalls = 0;
    const displayExpired: SavedReferenceRefreshRetentionPolicy = (input) => {
      const retention = retentionFor(input);
      if (retention === undefined) throw new Error('M16_REFRESH_RETENTION_SETUP_FAILED');
      return { ...retention, displayPolicyStatus: 'expired' };
    };
    const error = await readError(
      handlerFor(
        { read: () => Promise.resolve(responseFor(recordRef)) },
        {
          retentionFor: displayExpired,
          candidateIdFactory: () => {
            candidateCalls += 1;
            return `refresh-candidate-${crypto.randomUUID()}`;
          },
        },
      ).handle(operationFor(reference.savedPlaceRef), contextFor(owner)),
    );
    expect(error.failure).toEqual({ status: 410, code: 'EXPIRED' });
    expect(candidateCalls).toBe(0);
  });

  it('rejects malformed address projection without trimming or truncating provider text', async () => {
    const { owner } = await ownerFor();
    const addresses = ['   ', 'a'.repeat(161), undefined];
    for (const address of addresses) {
      const recordRef = `ChIJ-refresh-address-${crypto.randomUUID()}`;
      const { reference } = await registerReference(owner, recordRef);
      const handler = handlerFor({
        read: () =>
          Promise.resolve(
            address === undefined
              ? {
                  ...responseFor(recordRef),
                  body: { ...bodyFor(recordRef), formattedAddress: undefined },
                }
              : responseFor(recordRef, address),
          ),
      });
      const error = await readError(
        handler.handle(operationFor(reference.savedPlaceRef), contextFor(owner)),
      );
      expect(error.failure).toEqual({ status: 409, code: 'SCHEMA_MISMATCH' });
    }
  });
});
