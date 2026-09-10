import * as v from 'valibot';
import { env, SELF } from 'cloudflare:test';
import { CreateThreadResponseSchema } from '@ima/contracts';
import { expect } from 'vitest';
import type { ProductionThreadDO } from './runtime-native/runtime-production-worker';

export const APP_TOKEN = 'test-app-token';
export const OWNER_CREDENTIAL = 'A'.repeat(42) + 'E';

type ProductionHttpTestEnv = Cloudflare.Env & {
  readonly THREADS: DurableObjectNamespace<ProductionThreadDO>;
};

export const productionEnv = (): ProductionHttpTestEnv => env as ProductionHttpTestEnv;

const requestHeaders = (
  requestId: string,
  ownerCredential = OWNER_CREDENTIAL,
): Record<string, string> => ({
  'content-type': 'application/json',
  'x-app-token': APP_TOKEN,
  'x-device-id': 'runtime-production-http-device',
  'x-ima-owner-credential': ownerCredential,
  'x-ima-request-id': requestId,
  'x-app-version': 'm22-runtime-production-http-test',
});

export const call = async (
  path: string,
  requestId: string,
  init: RequestInit = {},
  ownerCredential = OWNER_CREDENTIAL,
): Promise<Response> => {
  const headers = new Headers(requestHeaders(requestId, ownerCredential));
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return SELF.fetch(`https://ima.test${path}`, { ...init, headers });
};

export type DisplayContext = {
  readonly cardSetId: string;
  readonly promotedCandidateId: string;
  readonly selectedCandidateId: string;
  readonly candidateOrder: readonly string[];
  readonly excludeCandidateIds: readonly string[];
};

export const turnBody = (
  requestId: string,
  revision: number,
  text: string,
  context?: DisplayContext,
  savedPlaceRefs: readonly string[] = [],
): Record<string, unknown> => ({
  schemaVersion: 'v1',
  requestId,
  turnId: `turn-${requestId}`,
  revision,
  text,
  clientNow: '2026-09-10T12:00:00Z',
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: '渋谷',
    budget: 'normal',
  },
  savedPlaceRefs: [...savedPlaceRefs],
  excludeCandidateIds: context?.excludeCandidateIds ?? [],
  mode: 'search',
  idempotencyKey: `runtime-production-http-${requestId}`,
  ...(context === undefined
    ? {}
    : {
        cardSetId: context.cardSetId,
        promotedCandidateId: context.promotedCandidateId,
        selectedCandidateId: context.selectedCandidateId,
        candidateOrder: [...context.candidateOrder],
      }),
});

export const createThread = async (): Promise<string> => {
  const requestId = `runtime-production-http-create-${crypto.randomUUID()}`;
  const response = await call('/v1/threads', requestId, {
    method: 'POST',
    body: JSON.stringify({
      schemaVersion: 'v1',
      requestId,
      idempotencyKey: `runtime-production-http-create-key-${crypto.randomUUID()}`,
    }),
  });
  expect(response.status).toBe(201);
  const parsed = v.safeParse(CreateThreadResponseSchema, await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('production HTTP thread response was invalid');
  return parsed.output.threadId;
};
