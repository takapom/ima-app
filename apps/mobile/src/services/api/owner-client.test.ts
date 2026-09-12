import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '@ima/contracts';
import { createOwnerPrefsClient } from './owner-client';
import type { ApiClientOptions, ApiFetch } from './types';

const ownerCredential = `${'A'.repeat(42)}A`;
const prefs = {
  homeStationRef: 'station-ebisu',
  maxWalkMinutes: 15,
  minimumStayMinutes: null,
  areaText: '恵比寿',
  budget: 'normal' as const,
};

const optionsFor = (fetchImpl: ApiFetch): ApiClientOptions => ({
  baseUrl: 'http://localhost:8787',
  mode: 'fixture',
  appVersion: 'test',
  credentials: { appToken: 'app-token', deviceId: 'device-1', ownerCredential },
  requestIdFactory: () => 'generated-request',
  fetchImpl,
});

const jsonBody = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

describe('owner prefs API client', () => {
  it('reads prefs and saved refs, then writes prefs with the request revision', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: ApiFetch = (input, init) => {
      const requestInit = init ?? {};
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: requestInit });
      const path = new URL(url).pathname;
      if (path === '/v1/prefs' && requestInit.method === 'GET') {
        return Promise.resolve(
          Response.json({
            schemaVersion: 'v1',
            requestId: 'generated-request',
            revision: 0,
            prefs: null,
          }),
        );
      }
      if (path === '/v1/prefs' && requestInit.method === 'PUT') {
        const body = jsonBody(requestInit);
        const requestId =
          typeof body === 'object' &&
          body !== null &&
          'requestId' in body &&
          typeof body.requestId === 'string'
            ? body.requestId
            : 'missing';
        return Promise.resolve(Response.json({ schemaVersion: 'v1', requestId, revision: 1 }));
      }
      return Promise.resolve(
        Response.json({
          schemaVersion: 'v1',
          requestId: 'generated-request',
          savedPlaceRefs: ['saved-1', 'saved-2'],
        }),
      );
    };
    const client = createOwnerPrefsClient(optionsFor(fetchImpl));

    await expect(client.getPrefs()).resolves.toEqual({
      ok: true,
      requestId: 'generated-request',
      data: {
        schemaVersion: 'v1',
        requestId: 'generated-request',
        revision: 0,
        prefs: null,
      },
    });
    await expect(client.listSaved()).resolves.toEqual({
      ok: true,
      requestId: 'generated-request',
      data: {
        schemaVersion: 'v1',
        requestId: 'generated-request',
        savedPlaceRefs: ['saved-1', 'saved-2'],
        decided: [],
      },
    });
    await expect(
      client.putPrefs({
        schemaVersion: 'v1',
        requestId: 'request-put',
        expectedRevision: 0,
        prefs,
      }),
    ).resolves.toEqual({
      ok: true,
      requestId: 'request-put',
      data: { schemaVersion: 'v1', requestId: 'request-put', revision: 1 },
    });

    expect(calls).toHaveLength(3);
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/v1/prefs');
    expect(calls[0]?.init.method).toBe('GET');
    expect(new Headers(calls[0]?.init.headers).get(REQUEST_ID_HEADER)).toBe('generated-request');
    expect(new URL(calls[1]?.url ?? '').pathname).toBe('/v1/saved');
    expect(calls[1]?.init.method).toBe('GET');
    expect(new URL(calls[2]?.url ?? '').pathname).toBe('/v1/prefs');
    expect(calls[2]?.init.method).toBe('PUT');
    expect(jsonBody(calls[2]?.init)).toEqual({
      schemaVersion: 'v1',
      requestId: 'request-put',
      expectedRevision: 0,
      prefs,
    });
    expect(new Headers(calls[2]?.init.headers).get(REQUEST_ID_HEADER)).toBe('request-put');
  });

  it('rejects station_label and extra keys before sending a prefs write', async () => {
    let calls = 0;
    const client = createOwnerPrefsClient(
      optionsFor(() => {
        calls += 1;
        return Promise.resolve(Response.json({ ok: true }));
      }),
    );

    await expect(
      client.putPrefs({
        schemaVersion: 'v1',
        requestId: 'request-put',
        expectedRevision: 0,
        prefs: { ...prefs, stationLabel: '恵比寿' },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract', route: 'prefsWrite', status: null },
    });
    await expect(
      client.putPrefs({
        schemaVersion: 'v1',
        requestId: 'request-put',
        expectedRevision: 0,
        prefs,
        extra: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract', route: 'prefsWrite', status: null },
    });
    expect(calls).toBe(0);
  });

  it('preserves a typed 409 without retrying at the HTTP client', async () => {
    let attempts = 0;
    const client = createOwnerPrefsClient(
      optionsFor(() => {
        attempts += 1;
        return Promise.resolve(
          Response.json(
            {
              schemaVersion: 'v1',
              requestId: 'request-put',
              status: 409,
              code: 'CONFLICT',
              message: 'The prefs revision is stale.',
            },
            { status: 409 },
          ),
        );
      }),
    );

    await expect(
      client.putPrefs({
        schemaVersion: 'v1',
        requestId: 'request-put',
        expectedRevision: 1,
        prefs,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'http', status: 409, publicError: { code: 'CONFLICT' } },
    });
    expect(attempts).toBe(1);
  });

  it('does not accept a prefs response that arrives after cancellation', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    let resolveStarted: ((signal: AbortSignal) => void) | undefined;
    const started = new Promise<AbortSignal>((resolve) => {
      resolveStarted = resolve;
    });
    const fetchImpl: ApiFetch = (_input, init) => {
      if (init?.signal !== undefined && init.signal !== null) resolveStarted?.(init.signal);
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    };
    const client = createOwnerPrefsClient(optionsFor(fetchImpl));
    const controller = new AbortController();
    const pending = client.getPrefs({ signal: controller.signal });
    const fetchSignal = await started;
    controller.abort();
    expect(fetchSignal.aborted).toBe(true);
    resolveFetch?.(
      Response.json({
        schemaVersion: 'v1',
        requestId: 'generated-request',
        revision: 0,
        prefs: null,
      }),
    );
    await expect(pending).resolves.toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });
});
