import { env } from 'cloudflare:test';
import type { RetentionMetadata } from '@ima/contracts';
import type { SavedPlaceReference } from '@ima/core';
import type { BootstrapEnv } from '../src/bootstrap';
import type { HandlerContext } from '../src/http/handler';
import { deriveOwnerScopeRef } from '../src/http/auth';
import { HttpBoundaryError } from '../src/http/errors';
import type {
  GooglePlaceDetailsResponse,
  GooglePlaceDetailsTransport,
} from '../src/providers/places-details/types';
import {
  createOwnerSavedReferenceRpc,
  savedReferenceOwnerName,
  type SavedReferenceDOStub,
  type SavedReferenceNamespace,
} from '../src/saved-references/saved-reference-rpc';
import {
  createSavedReferenceRefreshHandler,
  type SavedReferenceRefreshRetentionPolicy,
} from '../src/saved-references/saved-reference-refresh';

export const START_NOW = '2026-09-09T19:59:59.000Z';
export const EXPIRES_AT = '2026-09-09T20:00:00.000Z';
export const APP_TOKEN = 'test-app-token';

type RefreshEnv = BootstrapEnv & {
  readonly SAVED_REFERENCES: SavedReferenceNamespace;
};

export const testEnv = (value: typeof env): RefreshEnv => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('SAVED_REFERENCES' in value) ||
    !('THREADS' in value) ||
    !('RATE_LIMITS' in value)
  ) {
    throw new Error('M16_REFRESH_BINDING_MISSING');
  }
  return value as RefreshEnv;
};

const credentialFor = (): string => `${crypto.randomUUID().replaceAll('-', '')}${'A'.repeat(10)}A`;

export const ownerFor = async (): Promise<{
  readonly credential: string;
  readonly owner: string;
}> => {
  const credential = credentialFor();
  const owner = await deriveOwnerScopeRef(credential);
  if (owner === null) throw new Error('M16_REFRESH_OWNER_DERIVATION_FAILED');
  return { credential, owner };
};

export const bodyFor = (
  recordRef: string,
  address = '東京都渋谷区恵比寿1-1-1',
): Record<string, unknown> => ({
  id: recordRef,
  displayName: { text: 'Refresh Cafe', languageCode: 'ja' },
  formattedAddress: address,
  primaryType: 'cafe',
  businessStatus: 'OPERATIONAL',
  googleMapsUri: 'https://maps.google.com/?cid=refresh-fixture',
});

export const responseFor = (recordRef: string, address?: string): GooglePlaceDetailsResponse => ({
  placeId: recordRef,
  fields: ['identity'],
  body: bodyFor(recordRef, address),
});

const defaultRetention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: EXPIRES_AT,
  freshUntil: '2026-09-09T19:59:59.500Z',
  displayUntil: '2026-09-09T19:59:59.750Z',
  retentionUntil: EXPIRES_AT,
  deletionScheduledAt: EXPIRES_AT,
  attribution: { label: 'Google Maps', sourceLink: 'https://maps.google.com/' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

export const retentionFor: SavedReferenceRefreshRetentionPolicy = (_input) => defaultRetention;

export const retentionAfterAdmission: SavedReferenceRefreshRetentionPolicy = (_input) => ({
  ...defaultRetention,
  sessionExpiresAt: '2026-09-10T20:00:00.000Z',
  freshUntil: '2026-09-10T19:59:59.500Z',
  displayUntil: '2026-09-10T19:59:59.750Z',
  retentionUntil: '2026-09-10T20:00:00.000Z',
  deletionScheduledAt: '2026-09-10T20:00:00.000Z',
});

export const contextFor = (
  ownerScopeRef: string,
  signal = new AbortController().signal,
  serverNow = START_NOW,
): HandlerContext => ({
  requestId: `refresh-request-${crypto.randomUUID()}`,
  ownerScopeRef,
  deviceId: 'refresh-device',
  appVersion: 'm16-refresh-test',
  serverNow,
  cancellation: { isCancelled: () => signal.aborted },
  signal,
});

export const operationFor = (savedPlaceRef: string) => ({
  kind: 'saved_reference_refresh' as const,
  path: { savedPlaceRef },
});

export const registerReference = async (
  owner: string,
  recordRef: string,
): Promise<{
  readonly rpc: ReturnType<typeof createOwnerSavedReferenceRpc>;
  readonly reference: SavedPlaceReference;
}> => {
  const rpc = createOwnerSavedReferenceRpc(testEnv(env).SAVED_REFERENCES, owner);
  const initialized = await rpc.initialize();
  if (!initialized.ok) throw new Error('M16_REFRESH_OWNER_SETUP_FAILED');
  const created = await rpc.register({ provider: 'google_places', recordRef });
  if (!created.ok) throw new Error('M16_REFRESH_REFERENCE_SETUP_FAILED');
  return { rpc, reference: created.reference };
};

export const handlerFor = (
  transport: GooglePlaceDetailsTransport,
  options: {
    readonly clock?: () => string;
    readonly timeoutMs?: number;
    readonly retentionFor?: SavedReferenceRefreshRetentionPolicy;
    readonly candidateIdFactory?: (input: {
      readonly requestId: string;
      readonly savedPlaceRef: string;
      readonly recordRef: string;
    }) => string;
    readonly evidenceIdFactory?: (input: {
      readonly requestId: string;
      readonly savedPlaceRef: string;
      readonly recordRef: string;
      readonly index: number;
    }) => string;
  } = {},
) =>
  createSavedReferenceRefreshHandler({
    namespace: testEnv(env).SAVED_REFERENCES,
    transport,
    retentionFor: options.retentionFor ?? retentionFor,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.candidateIdFactory === undefined
      ? {}
      : { candidateIdFactory: options.candidateIdFactory }),
    ...(options.evidenceIdFactory === undefined
      ? {}
      : { evidenceIdFactory: options.evidenceIdFactory }),
  });

export const readError = async (promise: Promise<unknown>): Promise<HttpBoundaryError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HttpBoundaryError) return error;
    throw error;
  }
  throw new Error('M16_REFRESH_EXPECTED_FAILURE');
};

export const httpRequest = (path: string, credential: string, requestId: string): Request =>
  new Request(`https://ima.test${path}`, {
    method: 'GET',
    headers: {
      'x-app-token': APP_TOKEN,
      'x-device-id': 'refresh-http-device',
      'x-ima-owner-credential': credential,
      'x-ima-request-id': requestId,
      'x-app-version': 'm16-refresh-http-test',
    },
  });

export const configuredEnvironment = (namespace: SavedReferenceNamespace): RefreshEnv => ({
  ...testEnv(env),
  IMA_RUNTIME_MODE: 'fixture',
  IMA_PROVIDER_PLACES: 'true',
  IMA_KILL_SWITCH: 'false',
  GOOGLE_PLACES_API_KEY: 'fixture-key',
  SAVED_REFERENCES: namespace,
});

export const createReadDelayedNamespace = (
  reference: SavedPlaceReference,
  onPending: (
    release: (result: {
      readonly ok: true;
      readonly reference: SavedPlaceReference | null;
    }) => void,
  ) => void,
  delayReadNumber = 1,
): SavedReferenceNamespace => {
  const actual = testEnv(env).SAVED_REFERENCES.getByName(
    savedReferenceOwnerName(reference.ownerScopeRef),
  );
  let readCount = 0;
  const stub = new Proxy(actual, {
    get(target, property, _receiver) {
      if (property === 'read') {
        return (owner: unknown, savedPlaceRef: unknown) => {
          readCount += 1;
          if (readCount !== delayReadNumber) {
            return target.read(owner, savedPlaceRef);
          }
          return new Promise((resolve) => {
            onPending((result) => resolve(result));
          });
        };
      }
      return undefined;
    },
  });
  return { getByName: (_name: string): SavedReferenceDOStub => stub };
};
