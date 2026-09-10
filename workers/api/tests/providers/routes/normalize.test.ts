import { describe, expect, it } from 'vitest';
import {
  normalizeGoogleRouteMatrix,
  normalizeRawGoogleRouteMatrix,
} from '../../../src/providers/routes/normalize';
import { createGoogleRouteMatrixTransport } from '../../../src/providers/routes/transport';
import {
  GoogleRouteMatrixError,
  type GoogleRouteMatrixRequest,
} from '../../../src/providers/routes/types';

const request: GoogleRouteMatrixRequest = {
  origins: [
    { ref: 'current', coordinates: { lat: 35.6595, lng: 139.7005 } },
    { ref: 'shop-1', coordinates: { lat: 35.658, lng: 139.7016 } },
  ],
  destinations: [
    { ref: 'shop-1', coordinates: { lat: 35.658, lng: 139.7016 } },
    { ref: 'station-1', coordinates: { lat: 35.6467, lng: 139.71 } },
  ],
};

const route = (originIndex: number, destinationIndex: number, duration = '120s') => ({
  originIndex,
  destinationIndex,
  status: {},
  condition: 'ROUTE_EXISTS',
  distanceMeters: 400,
  duration,
});

const evaluatedAt = '2026-09-10T09:00:00Z';

describe('Google Route Matrix normalization', () => {
  it('rebuilds directed pairs by indexes and keeps whole seconds for Core', () => {
    const results = normalizeRawGoogleRouteMatrix(
      request,
      [route(1, 0, '61.1s'), route(0, 1, '62s'), route(1, 1, '63.9s'), route(0, 0, '64s')],
      evaluatedAt,
    );

    expect(results.map((result) => [result.originRef, result.destinationRef, result.kind])).toEqual(
      [
        ['current', 'shop-1', 'route'],
        ['current', 'station-1', 'route'],
        ['shop-1', 'shop-1', 'route'],
        ['shop-1', 'station-1', 'route'],
      ],
    );
    expect(results[0]).toMatchObject({
      kind: 'route',
      originIndex: 0,
      destinationIndex: 0,
      durationSeconds: 64,
      distanceMeters: 400,
      evaluatedAt,
    });
    expect(results[2]).toMatchObject({ durationSeconds: 62 });
  });

  it('distinguishes unreachable, provider element errors, and omitted pairs', () => {
    const results = normalizeRawGoogleRouteMatrix(
      request,
      [
        {
          ...route(0, 0),
          condition: 'ROUTE_NOT_FOUND',
          distanceMeters: undefined,
          duration: undefined,
        },
        {
          originIndex: 1,
          destinationIndex: 0,
          status: { code: 14 },
          condition: 'ROUTE_MATRIX_ELEMENT_CONDITION_UNSPECIFIED',
        },
      ],
      evaluatedAt,
    );

    expect(results[0]).toMatchObject({
      kind: 'unreachable',
      reason: 'ROUTE_NOT_FOUND',
      originRef: 'current',
      destinationRef: 'shop-1',
    });
    expect(results[1]).toMatchObject({ kind: 'missing', reason: 'MISSING_ELEMENT' });
    expect(results[2]).toMatchObject({
      kind: 'element_error',
      reason: 'PROVIDER_ERROR',
      providerStatusCode: 14,
      originRef: 'shop-1',
      destinationRef: 'shop-1',
    });
    expect(results[3]).toMatchObject({ kind: 'missing', reason: 'MISSING_ELEMENT' });
  });

  it('treats an omitted scalar distance as zero while requiring duration', () => {
    const results = normalizeRawGoogleRouteMatrix(
      request,
      [
        {
          originIndex: 0,
          destinationIndex: 0,
          status: {},
          condition: 'ROUTE_EXISTS',
          distanceMeters: undefined,
          duration: '0s',
        },
      ],
      evaluatedAt,
    );
    expect(results[0]).toMatchObject({ kind: 'route', durationSeconds: 0, distanceMeters: 0 });
  });

  it('rejects a ROUTE_EXISTS element when its protobuf duration is absent', () => {
    const results = normalizeRawGoogleRouteMatrix(
      request,
      [
        {
          originIndex: 0,
          destinationIndex: 0,
          status: {},
          condition: 'ROUTE_EXISTS',
        },
      ],
      evaluatedAt,
    );
    expect(results[0]).toMatchObject({ kind: 'element_error', reason: 'INVALID_ELEMENT' });
  });

  it('keeps a valid pair when another indexed element has malformed duration', () => {
    const results = normalizeRawGoogleRouteMatrix(
      request,
      [
        {
          originIndex: 0,
          destinationIndex: 0,
          status: {},
          condition: 'ROUTE_EXISTS',
          duration: 'bad',
        },
        route(0, 1, '90s'),
      ],
      evaluatedAt,
    );
    expect(results[0]).toMatchObject({ kind: 'element_error', reason: 'INVALID_ELEMENT' });
    expect(results[1]).toMatchObject({
      kind: 'route',
      originRef: 'current',
      destinationRef: 'station-1',
      durationSeconds: 90,
    });
  });

  it('fails closed on duplicate or out-of-range provider indexes', () => {
    expect(() =>
      normalizeRawGoogleRouteMatrix(request, [route(0, 0), route(0, 0)], evaluatedAt),
    ).toThrowError(GoogleRouteMatrixError);
    expect(() => normalizeRawGoogleRouteMatrix(request, [route(2, 0)], evaluatedAt)).toThrowError(
      GoogleRouteMatrixError,
    );
  });

  it('returns missing for an empty response and rejects invalid request context', () => {
    expect(
      normalizeRawGoogleRouteMatrix(request, [], evaluatedAt).every(
        (result) => result.kind === 'missing',
      ),
    ).toBe(true);
    expect(() => normalizeRawGoogleRouteMatrix(request, [], 'invalid-time')).toThrowError(
      GoogleRouteMatrixError,
    );
    expect(() =>
      normalizeRawGoogleRouteMatrix(
        { ...request, origins: request.origins.slice(0, 1).concat(request.origins.slice(0, 1)) },
        [],
        evaluatedAt,
      ),
    ).toThrowError(GoogleRouteMatrixError);
  });

  it('keeps transport parse errors attached through compute and normalization', async () => {
    const transport = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              {
                originIndex: 0,
                destinationIndex: 0,
                status: { code: 'bad' },
                condition: 'ROUTE_EXISTS',
                duration: '10s',
              },
              {
                originIndex: 0,
                destinationIndex: 1,
                status: {},
                condition: 'ROUTE_EXISTS',
                distanceMeters: 'bad',
                duration: '10s',
              },
              {
                originIndex: 1,
                destinationIndex: 0,
                status: {},
                condition: 'ROUTE_EXISTS',
                duration: 'bad',
              },
              route(1, 1, '90s'),
            ]),
            { status: 200 },
          ),
        ),
    });
    const parsed = await transport.compute(request);
    const results = normalizeGoogleRouteMatrix(request, parsed, evaluatedAt);
    expect(results[0]).toMatchObject({ kind: 'element_error', reason: 'INVALID_ELEMENT' });
    expect(results[1]).toMatchObject({ kind: 'element_error', reason: 'INVALID_ELEMENT' });
    expect(results[2]).toMatchObject({ kind: 'element_error', reason: 'INVALID_ELEMENT' });
    expect(results[3]).toMatchObject({ kind: 'route', durationSeconds: 90 });
  });
});
