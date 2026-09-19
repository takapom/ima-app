import { describe, expect, it } from 'vitest';
import type { RetentionMetadata } from '@ima/contracts';
import { REQUEST_ID_HEADER } from '@ima/contracts';
import { createJourneyApiClient } from '@mobile/platform/http/client';
import {
  parseSavedReferenceRefreshResponse,
  type SavedReferenceRefreshResponse,
} from '@mobile/platform/http/saved-reference-refresh';
import type { ApiClientOptions, ApiFetch } from '@mobile/platform/http/api';

const ownerCredential = `${'A'.repeat(42)}A`;
const savedPlaceRef = 'saved-ref-1';
const candidateId = 'candidate-1';
const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-11T05:00:00+09:00',
  freshUntil: '2026-09-11T04:00:00+09:00',
  displayUntil: '2026-09-11T04:30:00+09:00',
  retentionUntil: '2026-09-11T05:00:00+09:00',
  deletionScheduledAt: '2026-09-11T05:00:00+09:00',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const responseFor = (
  requestId = 'generated-request',
  ref = savedPlaceRef,
): SavedReferenceRefreshResponse => ({
  schemaVersion: 'v1',
  requestId,
  savedPlaceRef: ref,
  candidate: { candidateId, evidenceIds: ['evidence-1'] },
  data: {
    items: [
      {
        candidateId,
        fields: {
          identity: {
            status: 'known',
            value: {
              name: '夜カフェ',
              area: '恵比寿',
              address: null,
              category: 'cafe',
              stationName: null,
              accessText: null,
              businessStatus: 'operational',
              sourceUrl: null,
            },
            evidence: [{ evidenceId: 'evidence-1', attribution: null, retention }],
          },
        },
      },
    ],
  },
});

const optionsFor = (fetchImpl: ApiFetch): ApiClientOptions => ({
  baseUrl: 'http://localhost:8787',
  mode: 'fixture',
  appVersion: 'test',
  credentials: { appToken: 'app-token', deviceId: 'device-1', ownerCredential },
  requestIdFactory: () => 'generated-request',
  fetchImpl,
});

describe('saved reference refresh response', () => {
  it('validates one candidate and its evidence references', () => {
    expect(parseSavedReferenceRefreshResponse(responseFor())).toEqual({
      success: true,
      data: responseFor(),
    });

    const danglingEvidence = {
      ...responseFor(),
      candidate: { candidateId, evidenceIds: ['evidence-missing'] },
    };
    expect(parseSavedReferenceRefreshResponse(danglingEvidence)).toMatchObject({
      success: false,
      issues: ['response candidate evidenceIds do not reference data.items evidence'],
    });

    const missingCandidate = {
      ...responseFor(),
      candidate: { candidateId: 'candidate-2', evidenceIds: [] },
    };
    expect(parseSavedReferenceRefreshResponse(missingCandidate)).toMatchObject({
      success: false,
      issues: ['response candidateId is absent from data.items'],
    });

    const extraCandidate = {
      ...responseFor(),
      data: {
        items: [
          ...responseFor().data.items,
          { ...responseFor().data.items[0], candidateId: 'candidate-2' },
        ],
      },
    };
    expect(parseSavedReferenceRefreshResponse(extraCandidate)).toMatchObject({
      success: false,
      issues: ['saved reference refresh must contain exactly one candidate'],
    });

    const malformed = { ...responseFor(), data: { items: [] } };
    expect(parseSavedReferenceRefreshResponse(malformed)).toMatchObject({
      success: false,
    });
  });

  it('uses the threadless GET route and correlates request and saved-reference IDs', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchImpl: ApiFetch = (input, init) => {
      const requestInit = init ?? {};
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: requestInit });
      return Promise.resolve(Response.json(responseFor(), { status: 200 }));
    };
    const client = createJourneyApiClient(optionsFor(fetchImpl));

    await expect(client.refreshSavedReference(savedPlaceRef)).resolves.toEqual({
      ok: true,
      data: responseFor(),
      requestId: 'generated-request',
    });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/v1/saved/saved-ref-1/refresh');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(new Headers(calls[0]?.init.headers).get(REQUEST_ID_HEADER)).toBe('generated-request');

    await expect(client.refreshSavedReference('saved/ref')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract', route: 'savedReferenceRefresh', status: null },
    });
    expect(calls).toHaveLength(1);

    const mismatchedRef = createJourneyApiClient(
      optionsFor(() =>
        Promise.resolve(Response.json(responseFor('generated-request', 'saved-ref-2'))),
      ),
    );
    await expect(mismatchedRef.refreshSavedReference(savedPlaceRef)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract', route: 'savedReferenceRefresh', status: 200 },
    });

    const mismatchedRequest = createJourneyApiClient(
      optionsFor(() => Promise.resolve(Response.json(responseFor('other-request')))),
    );
    await expect(mismatchedRequest.refreshSavedReference(savedPlaceRef)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract', route: 'savedReferenceRefresh', status: 200 },
    });
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
  ] as const)(
    'keeps %s auth/foreign failures typed without exposing refresh data',
    async (status, code) => {
      const client = createJourneyApiClient(
        optionsFor(() =>
          Promise.resolve(
            Response.json(
              {
                schemaVersion: 'v1',
                requestId: 'generated-request',
                status,
                code,
                message: 'The saved reference is unavailable.',
              },
              { status },
            ),
          ),
        ),
      );

      await expect(client.refreshSavedReference(savedPlaceRef)).resolves.toMatchObject({
        ok: false,
        error: { kind: 'http', status },
      });
    },
  );

  it('keeps timeout and cancellation behavior of the existing client boundary', async () => {
    const timeoutClient = createJourneyApiClient({
      ...optionsFor(() => new Promise<Response>(() => undefined)),
      timeoutMs: 5,
    });
    await expect(timeoutClient.refreshSavedReference(savedPlaceRef)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    });

    let resolveFetch: ((response: Response) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const client = createJourneyApiClient(
      optionsFor((_input, init) => {
        if (init?.signal !== undefined && init.signal !== null) markStarted?.();
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      }),
    );
    const controller = new AbortController();
    const pending = client.refreshSavedReference(savedPlaceRef, { signal: controller.signal });
    await started;
    controller.abort();
    resolveFetch?.(Response.json(responseFor(), { status: 200 }));
    await expect(pending).resolves.toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });
});
