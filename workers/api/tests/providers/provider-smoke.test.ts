import type { JourneyRecord, JourneyServiceDateContext } from '@ima/core';
import { describe, expect, it, vi } from 'vitest';
import { createJourneyReader } from '../../src/providers/last-train/reader';
import {
  GOOGLE_PHOTO_MEDIA_ORIGIN,
  GOOGLE_PHOTO_REDIRECT_HOSTS,
} from '../../src/providers/photo/media';
import { GOOGLE_PLACE_DETAILS_ENDPOINT } from '../../src/providers/places-details/types';
import { GOOGLE_TEXT_SEARCH_ENDPOINT } from '../../src/providers/places-search/types';
import { GOOGLE_ROUTE_MATRIX_ENDPOINT } from '../../src/providers/routes/types';
import { runProviderSmoke, runProviderSmokeCli } from '../../tooling/provider-smoke/runner';
import {
  SMOKE_CONFIRMATION_ENV,
  SMOKE_INPUT_ENV,
  SMOKE_KEY_ENV,
  type SmokeEnvironment,
} from '../../tooling/provider-smoke/contracts';

const liveEnvironment: SmokeEnvironment = {
  [SMOKE_CONFIRMATION_ENV.live]: 'YES',
  [SMOKE_CONFIRMATION_ENV.billing]: 'YES',
  [SMOKE_CONFIRMATION_ENV.permission]: 'YES',
  [SMOKE_KEY_ENV.places]: 'fixture-key-never-logged',
  [SMOKE_KEY_ENV.routes]: 'fixture-routes-key-never-logged',
  [SMOKE_INPUT_ENV.searchQuery]: 'fixture cafe',
  [SMOKE_INPUT_ENV.placeId]: 'ChIJfixturePlace',
  [SMOKE_INPUT_ENV.photoRef]: 'places/ChIJfixturePlace/photos/photo-1',
  [SMOKE_INPUT_ENV.routeOriginPlaceId]: 'ChIJfixtureOrigin',
  [SMOKE_INPUT_ENV.routeDestinationPlaceId]: 'ChIJfixtureDestination',
  JOURNEY_DATASET_LIVE_REF: 'test-live-dataset-binding',
};

const jsonResponse = (value: unknown, status = 200, headers?: HeadersInit): Response => {
  const init: ResponseInit = { status };
  if (headers !== undefined) init.headers = headers;
  return new Response(JSON.stringify(value), init);
};

const liveFetcher = (
  detailsBody: unknown = {
    id: 'ChIJfixturePlace',
    displayName: { text: 'Fixture Cafe' },
  },
  routeCondition: 'ROUTE_EXISTS' | 'ROUTE_NOT_FOUND' = 'ROUTE_EXISTS',
) => {
  const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url === GOOGLE_TEXT_SEARCH_ENDPOINT) {
      return Promise.resolve(
        jsonResponse({
          places: [{ id: 'ChIJfixturePlace', displayName: { text: 'Fixture Cafe' } }],
        }),
      );
    }
    if (url === `${GOOGLE_PLACE_DETAILS_ENDPOINT}/ChIJfixturePlace`) {
      return Promise.resolve(jsonResponse(detailsBody));
    }
    if (url === GOOGLE_ROUTE_MATRIX_ENDPOINT) {
      return Promise.resolve(
        jsonResponse([
          {
            originIndex: 0,
            destinationIndex: 0,
            status: {},
            condition: routeCondition,
            ...(routeCondition === 'ROUTE_EXISTS' ? { distanceMeters: 120, duration: '90s' } : {}),
          },
        ]),
      );
    }
    if (url.startsWith(`${GOOGLE_PHOTO_MEDIA_ORIGIN}/v1/`) && url.includes('/media?')) {
      return Promise.resolve(
        jsonResponse({ photoUri: `https://${GOOGLE_PHOTO_REDIRECT_HOSTS[0]}/fixture-photo` }),
      );
    }
    if (url === `https://${GOOGLE_PHOTO_REDIRECT_HOSTS[0]}/fixture-photo`) {
      return Promise.resolve(
        new Response('fixture-image-bytes', {
          headers: { 'content-type': 'image/jpeg' },
        }),
      );
    }
    return Promise.reject(new Error('unexpected fixture URL'));
  });
  return { calls, fetcher };
};

const journeyProbe = () => Promise.resolve({ source: 'live' as const, ok: true as const });

describe('M24 provider smoke boundary', () => {
  it('requires an explicit live flag and reports no-key execution as nonzero skip', async () => {
    const output: string[] = [];
    await expect(runProviderSmokeCli([], {}, (line) => output.push(line))).resolves.toBe(2);
    expect(output).toEqual([
      JSON.stringify({ mode: 'live', status: 'skipped', code: 'LIVE_FLAG_REQUIRED' }),
    ]);

    const liveOutput: string[] = [];
    await expect(
      runProviderSmokeCli(['--live'], {}, (line) => liveOutput.push(line)),
    ).resolves.toBe(2);
    const parsed: unknown = JSON.parse(liveOutput[0] ?? '{}');
    expect(parsed).toMatchObject({ mode: 'live', exitCode: 2 });
  });

  it('classifies missing keys and confirmations as skipped without calling fetch', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const report = await runProviderSmoke({ env: {}, fetcher });

    expect(report.exitCode).toBe(2);
    expect(report.preflight.status).toBe('blocked');
    expect(report.results).toHaveLength(5);
    expect(report.results.every((result) => result.status === 'skipped')).toBe(true);
    expect(report.results.every((result) => result.code === 'PREFLIGHT_BLOCKED')).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('fixture-key-never-logged');
  });

  it('requires billing and permission confirmation instead of treating keys as live approval', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const report = await runProviderSmoke({
      env: { ...liveEnvironment, [SMOKE_CONFIRMATION_ENV.billing]: 'NO' },
      fetcher,
    });

    expect(report.exitCode).toBe(2);
    expect(report.preflight.checks).toContainEqual({
      name: SMOKE_CONFIRMATION_ENV.billing,
      status: 'missing',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('runs the five basic live boundaries through one injected fetcher without exposing keys', async () => {
    const { calls, fetcher } = liveFetcher();
    const report = await runProviderSmoke({
      env: liveEnvironment,
      fetcher,
      journeyProbe,
    });

    expect(report.exitCode).toBe(0);
    expect(report.results.map((result) => [result.provider, result.status])).toEqual([
      ['places', 'passed'],
      ['details', 'passed'],
      ['routes', 'passed'],
      ['photo', 'passed'],
      ['journey', 'passed'],
    ]);
    expect(calls).toHaveLength(5);
    expect(calls.every(({ url }) => !url.includes('fixture-key-never-logged'))).toBe(true);
    expect(calls.every(({ url }) => !url.includes('fixture-routes-key-never-logged'))).toBe(true);
    expect(calls.filter(({ init }) => init?.redirect === 'manual')).toHaveLength(5);
    const imageCall = calls.find(
      ({ url }) => url === `https://${GOOGLE_PHOTO_REDIRECT_HOSTS[0]}/fixture-photo`,
    );
    expect(imageCall?.init?.headers).toEqual({ accept: 'image/*' });
    expect(JSON.stringify(report)).not.toContain('fixture-image-bytes');
  });

  it('does not treat a provider id echo without a display name as complete identity', async () => {
    const { fetcher } = liveFetcher({ id: 'ChIJfixturePlace' });
    const report = await runProviderSmoke({
      env: liveEnvironment,
      fetcher,
      journeyProbe,
    });

    expect(report.results.find((result) => result.provider === 'details')).toMatchObject({
      status: 'failed',
      code: 'IDENTITY_INCOMPLETE',
      calls: 1,
    });
    expect(report.exitCode).toBe(1);
  });

  it('reports a valid route-matrix no-route element separately from a usable route', async () => {
    const { fetcher } = liveFetcher(undefined, 'ROUTE_NOT_FOUND');
    const report = await runProviderSmoke({
      env: liveEnvironment,
      fetcher,
      journeyProbe,
    });

    expect(report.results.find((result) => result.provider === 'routes')).toMatchObject({
      status: 'passed',
      outcome: 'no_data',
      code: 'NO_ROUTE',
      calls: 1,
    });
    expect(report.exitCode).toBe(0);
  });

  it('does not turn a fixture journey probe into a live pass', async () => {
    const { fetcher } = liveFetcher();
    const fixtureJourney = () => Promise.resolve({ source: 'fixture' as const, ok: true as const });
    const report = await runProviderSmoke({
      env: liveEnvironment,
      fetcher,
      journeyProbe: fixtureJourney,
    });

    expect(report.exitCode).toBe(1);
    expect(report.results.find((result) => result.provider === 'journey')).toMatchObject({
      status: 'failed',
      source: 'none',
      code: 'FIXTURE_NOT_LIVE',
    });
  });

  it('keeps the live API checks usable while an unconfigured journey dataset is explicit skip', async () => {
    const { fetcher } = liveFetcher();
    const withoutJourneyDataset = {
      ...liveEnvironment,
      JOURNEY_DATASET_LIVE_REF: undefined,
    };
    const report = await runProviderSmoke({ env: withoutJourneyDataset, fetcher });

    expect(report.exitCode).toBe(2);
    expect(report.results.slice(0, 4).every((result) => result.status === 'passed')).toBe(true);
    expect(report.results[4]).toMatchObject({
      provider: 'journey',
      status: 'skipped',
      code: 'DATASET_NOT_CONFIGURED',
    });
  });

  it('bounds a never-ending photo body and cancels the reader instead of retaining the body', async () => {
    vi.useFakeTimers();
    try {
      const env: SmokeEnvironment = {
        [SMOKE_CONFIRMATION_ENV.live]: 'YES',
        [SMOKE_CONFIRMATION_ENV.billing]: 'YES',
        [SMOKE_CONFIRMATION_ENV.permission]: 'YES',
        [SMOKE_KEY_ENV.places]: 'photo-key-never-logged',
        [SMOKE_INPUT_ENV.photoRef]: 'places/ChIJfixturePlace/photos/photo-1',
      };
      let cancelCalls = 0;
      const neverEnding = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel: () => {
          cancelCalls += 1;
          return new Promise<void>(() => undefined);
        },
      });
      const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return url.includes('/media?')
          ? Promise.resolve(
              jsonResponse({ photoUri: `https://${GOOGLE_PHOTO_REDIRECT_HOSTS[0]}/slow-photo` }),
            )
          : Promise.resolve(
              new Response(neverEnding, {
                headers: { 'content-type': 'image/jpeg' },
              }),
            );
      });
      const pending = runProviderSmoke({ env, fetcher });
      await vi.advanceTimersByTimeAsync(10_000);
      const report = await pending;
      expect(report.results.find((result) => result.provider === 'photo')).toMatchObject({
        status: 'failed',
        code: 'TIMEOUT',
        calls: 2,
      });
      expect(cancelCalls).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps an external abort to CANCELLED while the photo body is being consumed', async () => {
    const env: SmokeEnvironment = {
      [SMOKE_CONFIRMATION_ENV.live]: 'YES',
      [SMOKE_CONFIRMATION_ENV.billing]: 'YES',
      [SMOKE_CONFIRMATION_ENV.permission]: 'YES',
      [SMOKE_KEY_ENV.places]: 'photo-key-never-logged',
      [SMOKE_INPUT_ENV.photoRef]: 'places/ChIJfixturePlace/photos/photo-1',
    };
    let resolveReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    const neverEnding = new ReadableStream<Uint8Array>({
      pull: () => {
        resolveReadStarted();
        return new Promise<void>(() => undefined);
      },
      cancel: () => new Promise<void>(() => undefined),
    });
    const fetcher = (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/media?')) {
        return Promise.resolve(
          jsonResponse({ photoUri: `https://${GOOGLE_PHOTO_REDIRECT_HOSTS[0]}/abort-photo` }),
        );
      }
      return Promise.resolve(
        new Response(neverEnding, { headers: { 'content-type': 'image/jpeg' } }),
      );
    };
    const controller = new AbortController();
    const pending = runProviderSmoke({ env, fetcher, signal: controller.signal });
    await readStarted;
    controller.abort();
    const report = await pending;
    expect(report.results.find((result) => result.provider === 'photo')).toMatchObject({
      status: 'failed',
      code: 'CANCELLED',
    });
    const photoResult = report.results.find((result) => result.provider === 'photo');
    expect(photoResult?.calls).toBeGreaterThanOrEqual(1);
  });
});

const journey: JourneyRecord = {
  journeyRef: 'fixture-journey',
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
  serviceDate: '2026-09-10',
  servicePattern: { weekdays: ['thursday'], holidayPolicy: 'allowed' },
  lastDepartureAt: '2026-09-10T23:50:00+09:00',
  arrivesHomeAt: '2026-09-11T00:30:00+09:00',
  transfers: [],
  validFrom: '2026-09-01',
  validThrough: '2026-09-30',
  verifiedAt: '2026-09-10T00:00:00Z',
  source: {
    provider: 'fixture',
    recordRef: 'fixture-timetable',
    attribution: 'fixture only',
    publicUrl: null,
  },
};

const journeyContext: JourneyServiceDateContext = {
  serviceDate: '2026-09-10',
  weekday: 'thursday',
  isHoliday: false,
  now: '2026-09-10T12:00:00Z',
  fromStationRef: 'station-a',
  homeStationRef: 'station-b',
};

describe('M24 journey contract fixture', () => {
  it('reads a synthetic timetable and returns disabled when no dataset is active', async () => {
    const reader = createJourneyReader({
      readCurrent: () =>
        Promise.resolve({
          schemaVersion: 'v1',
          revision: 1,
          importedAt: '2026-09-10T00:00:00Z',
          sourceRevision: null,
          records: [journey],
        }),
      readRevision: () => Promise.resolve(null),
    });
    await expect(reader.read(journeyContext)).resolves.toMatchObject({ status: 'known' });

    const disabled = createJourneyReader({
      readCurrent: () => Promise.resolve(null),
      readRevision: () => Promise.resolve(null),
    });
    await expect(disabled.read(journeyContext)).resolves.toMatchObject({
      status: 'disabled',
      availability: { reason: 'missing' },
    });
  });
});
