import { describe, expect, it } from 'vitest';
import type { SavedReferenceCreateRequest, SavedReferenceDeleteRequest } from '@ima/contracts';
import { REQUEST_ID_HEADER } from '@ima/contracts';
import { createJourneyApiClient } from '@mobile/platform/http/client';
import type { ApiClientOptions, ApiFetch } from '@mobile/platform/http/api';

const ownerCredential = `${'A'.repeat(42)}A`;
const createInput: SavedReferenceCreateRequest = {
  schemaVersion: 'v1',
  requestId: 'request-save',
  candidateId: 'candidate-1',
  revision: 7,
  idempotencyKey: 'save-operation-1',
};
const deleteInput: SavedReferenceDeleteRequest = {
  schemaVersion: 'v1',
  requestId: 'request-delete',
  idempotencyKey: 'delete-operation-1',
};

const optionsFor = (fetchImpl: ApiFetch): ApiClientOptions => ({
  baseUrl: 'http://localhost:8787',
  mode: 'fixture',
  appVersion: 'test',
  credentials: { appToken: 'app-token', deviceId: 'device-1', ownerCredential },
  requestIdFactory: () => 'generated-request',
  fetchImpl,
});

const responseFor = (requestId: string) =>
  Response.json(
    {
      schemaVersion: 'v1',
      requestId,
      candidateId: 'candidate-1',
      savedPlaceRef: 'saved-ref-1',
    },
    { status: 201 },
  );

const bodyFor = (init: RequestInit): Record<string, unknown> =>
  typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};

describe('saved reference API client', () => {
  it('connects create and idempotent delete to their public routes', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: ApiFetch = (input, init) => {
      const requestInit = init ?? {};
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: requestInit });
      return Promise.resolve(
        requestInit.method === 'POST'
          ? responseFor(createInput.requestId)
          : new Response(null, { status: 204 }),
      );
    };
    const client = createJourneyApiClient(optionsFor(fetchImpl));

    await expect(client.createSavedReference('thread-1', createInput)).resolves.toEqual({
      ok: true,
      data: {
        schemaVersion: 'v1',
        requestId: 'request-save',
        candidateId: 'candidate-1',
        savedPlaceRef: 'saved-ref-1',
      },
      requestId: 'request-save',
    });
    await expect(client.deleteSavedReference('saved-ref-1', deleteInput)).resolves.toEqual({
      ok: true,
      data: null,
      requestId: 'request-delete',
    });

    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/v1/threads/thread-1/saved');
    expect(calls[0]?.init.method).toBe('POST');
    expect(bodyFor(calls[0]?.init ?? {})).toEqual(createInput);
    expect(new URL(calls[1]?.url ?? '').pathname).toBe('/v1/saved/saved-ref-1');
    expect(calls[1]?.init.method).toBe('DELETE');
    expect(bodyFor(calls[1]?.init ?? {})).toEqual(deleteInput);
    expect(new Headers(calls[0]?.init.headers).get(REQUEST_ID_HEADER)).toBe('request-save');
  });

  it('retries with the same idempotency key and preserves a typed stale response', async () => {
    const bodies: Record<string, unknown>[] = [];
    let attempt = 0;
    const fetchImpl: ApiFetch = (_input, init) => {
      bodies.push(bodyFor(init ?? {}));
      attempt += 1;
      return Promise.resolve(
        attempt < 3
          ? responseFor(createInput.requestId)
          : Response.json(
              {
                schemaVersion: 'v1',
                requestId: createInput.requestId,
                status: 409,
                code: 'STALE_TURN',
                message: 'The turn is stale.',
              },
              { status: 409 },
            ),
      );
    };
    const client = createJourneyApiClient(optionsFor(fetchImpl));

    await expect(client.createSavedReference('thread-1', createInput)).resolves.toMatchObject({
      ok: true,
      data: { savedPlaceRef: 'saved-ref-1' },
    });
    await expect(client.createSavedReference('thread-1', createInput)).resolves.toMatchObject({
      ok: true,
      data: { savedPlaceRef: 'saved-ref-1' },
    });
    const stale = await client.createSavedReference('thread-1', createInput);
    expect(stale).toMatchObject({ ok: false, error: { kind: 'http', status: 409 } });
    expect(bodies.slice(0, 2)).toEqual([createInput, createInput]);
  });

  it('rejects provider payloads and invalid paths before making a request', async () => {
    let calls = 0;
    const client = createJourneyApiClient(
      optionsFor(() => {
        calls += 1;
        return Promise.resolve(responseFor(createInput.requestId));
      }),
    );
    const providerPayload = {
      ...createInput,
      provider: 'google',
      providerPlaceId: 'raw-provider-id',
    } as unknown as SavedReferenceCreateRequest;

    await expect(client.createSavedReference('thread-1', providerPayload)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract', route: 'savedReferenceCreate', status: null },
    });
    await expect(client.deleteSavedReference('saved/ref', deleteInput)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract', route: 'savedReferenceDelete', status: null },
    });
    expect(calls).toBe(0);
  });

  it('rejects a successful response for a different candidate', async () => {
    const client = createJourneyApiClient(
      optionsFor(() =>
        Promise.resolve(
          Response.json(
            {
              schemaVersion: 'v1',
              requestId: createInput.requestId,
              candidateId: 'candidate-2',
              savedPlaceRef: 'saved-ref-2',
            },
            { status: 201 },
          ),
        ),
      ),
    );

    await expect(client.createSavedReference('thread-1', createInput)).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'contract',
        route: 'savedReferenceCreate',
        status: 201,
      },
    });
  });

  it('does not accept a response that arrives after cancellation', async () => {
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
    const client = createJourneyApiClient(optionsFor(fetchImpl));
    const controller = new AbortController();
    const pending = client.createSavedReference('thread-1', createInput, {
      signal: controller.signal,
    });
    const fetchSignal = await started;
    controller.abort();
    expect(fetchSignal.aborted).toBe(true);
    resolveFetch?.(responseFor(createInput.requestId));
    await expect(pending).resolves.toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });
});
