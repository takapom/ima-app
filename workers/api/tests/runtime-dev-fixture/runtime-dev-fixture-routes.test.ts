import { SELF } from 'cloudflare:test';
import {
  CreateThreadResponseSchema,
  ErrorResponseSchema,
  SearchResponseSchema,
  type ThreadTurnRequest,
} from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { createRuntimeProductionConnectionOptions } from '../../src/runtime/composition/runtime-production-factory';
import {
  createDevFixtureFetcher,
  DEV_FIXTURE_ORIGIN_REF,
  DEV_FIXTURE_ROUTE_DISTANCE_METERS,
  DEV_FIXTURE_ROUTE_DURATION_SECONDS,
} from '../../src/runtime/composition/runtime-dev-fixture';
import { readOnlyCommit, buildRequest } from '../runtime/runtime-production-factory-fixtures';

const OWNER_CREDENTIAL = `${'A'.repeat(42)}E`;
const DEVICE_ID = 'dev-fixture-device';

const headers = (requestId: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-app-token': 'dev-fixture-app-token',
  'x-device-id': DEVICE_ID,
  'x-ima-owner-credential': OWNER_CREDENTIAL,
  'x-ima-request-id': requestId,
  'x-app-version': 'm29-dev-fixture-routes-test',
});

const call = (path: string, requestId: string, init: RequestInit = {}): Promise<Response> => {
  const requestHeaders = new Headers(headers(requestId));
  new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
  return SELF.fetch(`https://ima.dev${path}`, { ...init, headers: requestHeaders });
};

const createThread = async (): Promise<string> => {
  const requestId = `dev-fixture-route-create-${crypto.randomUUID()}`;
  const response = await call('/v1/threads', requestId, {
    method: 'POST',
    body: JSON.stringify({
      schemaVersion: 'v1',
      requestId,
      idempotencyKey: `dev-fixture-route-create-key-${crypto.randomUUID()}`,
    }),
  });
  expect(response.status).toBe(201);
  const parsed = v.safeParse(CreateThreadResponseSchema, await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('dev fixture route thread response was invalid');
  return parsed.output.threadId;
};

const availableTurn = (requestId: string, maxWalkMinutes = 15): ThreadTurnRequest => {
  const capturedAt = new Date().toISOString();
  return {
    schemaVersion: 'v1',
    requestId,
    turnId: null,
    revision: 1,
    text: '恵比寿で徒歩15分以内の候補を探して',
    clientNow: capturedAt,
    location: {
      status: 'available',
      lat: 35.6812,
      lng: 139.7671,
      accuracyMeters: 10,
      precise: true,
      capturedAt,
    },
    prefs: {
      homeStationRef: null,
      maxWalkMinutes,
      minimumStayMinutes: null,
      areaText: '恵比寿',
      budget: 'normal',
    },
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search',
    idempotencyKey: `dev-fixture-route-turn-${requestId}`,
  };
};

describe('keyless dev fixture Routes', () => {
  it('returns a fixed fixture matrix and never falls back to another host', async () => {
    const fetcher = createDevFixtureFetcher(() => '2026-09-11T03:00:00.000Z');
    const response = await fetcher(
      'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
      {
        method: 'POST',
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        originIndex: 0,
        destinationIndex: 0,
        status: {},
        condition: 'ROUTE_EXISTS',
        distanceMeters: DEV_FIXTURE_ROUTE_DISTANCE_METERS,
        duration: `${DEV_FIXTURE_ROUTE_DURATION_SECONDS}s`,
      },
    ]);
    await expect(
      fetcher('https://routes.googleapis.com/other', { method: 'POST' }),
    ).resolves.toHaveProperty('status', 404);
    await expect(
      fetcher('https://evil.example/distanceMatrix/v2:computeRouteMatrix', { method: 'POST' }),
    ).resolves.toHaveProperty('status', 404);
  });

  it('honors Routes and kill-switch gates before building the production graph', async () => {
    const fixtureEnv = { IMA_ENV: 'dev', IMA_RUNTIME_MODE: 'fixture' };
    const disabled = createRuntimeProductionConnectionOptions({
      env: { ...fixtureEnv, IMA_PROVIDER_ROUTES: 'false' },
      commit: readOnlyCommit,
    });
    expect(disabled).toBeDefined();
    if (disabled === undefined) throw new Error('Routes-disabled fixture graph was not built');
    const disabledComposition = await disabled.buildTurn(buildRequest);
    expect(disabledComposition.turn.context.capabilities.walkingRoute).toBe(false);
    disabledComposition.dispose();

    expect(
      createRuntimeProductionConnectionOptions({
        env: { ...fixtureEnv, IMA_KILL_SWITCH: 'true' },
        commit: readOnlyCommit,
      }),
    ).toBeUndefined();
  });

  it('runs the default HTTP to DO to fixed Routes matrix to cards path with available GPS', async () => {
    const threadId = await createThread();
    const requestId = `dev-fixture-route-turn-${crypto.randomUUID()}`;
    const response = await call(`/v1/threads/${threadId}/turns`, requestId, {
      method: 'POST',
      body: JSON.stringify(availableTurn(requestId)),
    });
    expect(response.status).toBe(200);
    const parsed = v.safeParse(SearchResponseSchema, await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('dev fixture route response was invalid');
    expect(parsed.output.response.kind).toBe('cards');
    if (parsed.output.response.kind !== 'cards') throw new Error('fixture cards were not returned');
    const walking = parsed.output.response.cards.hero.facts.walking_route;
    expect(walking).toMatchObject({
      status: 'known',
      value: {
        originRef: DEV_FIXTURE_ORIGIN_REF,
        durationSeconds: DEV_FIXTURE_ROUTE_DURATION_SECONDS,
        distanceMeters: DEV_FIXTURE_ROUTE_DISTANCE_METERS,
      },
    });
    if (walking?.status === 'known') {
      expect(walking.value.destinationCandidateId).toBe(
        parsed.output.response.cards.hero.candidateId,
      );
      expect(walking.evidence.length).toBeGreaterThan(0);
    }
  });

  it('keeps the hard walking constraint rejected when GPS is unavailable', async () => {
    const threadId = await createThread();
    const requestId = `dev-fixture-route-unavailable-${crypto.randomUUID()}`;
    const input = availableTurn(requestId);
    const unavailable: ThreadTurnRequest = {
      ...input,
      text: '徒歩15分以内で探して',
      location: {
        status: 'unavailable',
        lat: null,
        lng: null,
        accuracyMeters: null,
        precise: false,
        capturedAt: null,
      },
    };
    const response = await call(`/v1/threads/${threadId}/turns`, requestId, {
      method: 'POST',
      body: JSON.stringify(unavailable),
    });
    expect(response.status).toBe(502);
    const parsed = v.safeParse(ErrorResponseSchema, await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('location rejection response was invalid');
    expect(parsed.output).toMatchObject({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
  });

  it('applies the fixed route duration to the walking limit', async () => {
    const threadId = await createThread();
    const requestId = `dev-fixture-route-limit-${crypto.randomUUID()}`;
    const response = await call(`/v1/threads/${threadId}/turns`, requestId, {
      method: 'POST',
      body: JSON.stringify(availableTurn(requestId, 5)),
    });
    expect(response.status).toBe(502);
    const parsed = v.safeParse(ErrorResponseSchema, await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('walking limit response was invalid');
    expect(parsed.output).toMatchObject({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
  });
});
