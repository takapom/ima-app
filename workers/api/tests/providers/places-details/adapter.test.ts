import { describe, expect, it } from 'vitest';
import {
  context,
  execution,
  makeFixture,
  place,
  policy,
  read,
  readInput,
  SCOPE,
} from './adapter-fixtures';
import {
  createPlacesDetailsAdapter,
  type PlacesDetailsAdapterOptions,
} from '../../../src/providers/places-details/adapter';
import { observationContextFor } from '../../../src/providers/places-details/adapter-support';
import {
  GooglePlaceDetailsError,
  googlePlaceDetailsFieldMask,
  type GooglePlaceDetailsTransport,
} from '../../../src/providers/places-details/types';
import { createGooglePlaceDetailsTransport } from '../../../src/providers/places-details/transport';
describe('Google Place Details Core adapter', () => {
  it('uses the real transport and Core registry for exact requested fields', async () => {
    const fixture = makeFixture();
    const result = await read(
      fixture,
      readInput(fixture.candidateIds[0] ?? '', [
        'identity',
        'opening_hours',
        'price',
        'photos',
        'contact',
      ]),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const item = result.data.items[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(Object.keys(item.fields)).toEqual([
      'identity',
      'opening_hours',
      'price',
      'photos',
      'contact',
    ]);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.mask).toBe(
      googlePlaceDetailsFieldMask(['identity', 'opening_hours', 'price', 'photos', 'contact']),
    );
    expect(fixture.registry.listObservations(SCOPE, fixture.candidateIds[0])).toHaveLength(5);
    expect(item.fields.identity).toMatchObject({ status: 'known' });
    const observation = fixture.registry.listObservations(SCOPE)[0];
    expect(observation?.sources[0]).toMatchObject({
      provider: 'google_places',
      recordRef: 'place-a',
      attribution: 'Google Maps',
    });
  });

  it('keeps a valid identity when other fields in the same response are malformed', async () => {
    const fixture = makeFixture();
    const candidateId = fixture.candidateIds[0] ?? '';
    fixture.setBody((id) => ({
      ...place(id),
      priceLevel: 123,
      currentOpeningHours: { periods: 'malformed' },
    }));
    const result = await read(
      fixture,
      readInput(candidateId, ['identity', 'price', 'opening_hours']),
    );
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    const item = result.data.items[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.fields.identity).toMatchObject({ status: 'known' });
    expect(item.fields.price).toMatchObject({
      status: 'error',
      error: { code: 'SCHEMA_MISMATCH' },
    });
    expect(item.fields.opening_hours).toMatchObject({
      status: 'error',
      error: { code: 'SCHEMA_MISMATCH' },
    });
    expect(fixture.registry.listObservations(SCOPE, candidateId)).toHaveLength(1);
  });

  it('reuses valid observations without another provider request', async () => {
    const fixture = makeFixture();
    const candidateId = fixture.candidateIds[0] ?? '';
    await read(fixture, readInput(candidateId, ['identity']));
    const firstObservation = fixture.registry.listObservations(SCOPE, candidateId)[0];
    expect(firstObservation).toBeDefined();
    fixture.setBody(() => {
      throw new Error('reuse must not fetch');
    });
    const second = await read(fixture, readInput(candidateId, ['identity'], 'reuse_valid'));
    expect(second.status).toBe('ok');
    expect(fixture.calls).toHaveLength(1);
    if (second.status !== 'ok' || firstObservation === undefined) return;
    expect(second.data.items[0]?.fields.identity).toMatchObject({
      status: 'known',
      observations: [{ observationId: firstObservation.observationId }],
    });
  });

  it('refreshes one field and makes the new observation reusable', async () => {
    const fixture = makeFixture();
    const candidateId = fixture.candidateIds[0] ?? '';
    await read(fixture, readInput(candidateId, ['identity']));
    fixture.clock.set('2026-09-10T03:00:00.000Z');
    fixture.setBody((id) => place(id, '新しい店名'));
    const result = await read(fixture, readInput(candidateId, ['identity']));
    expect(result.status).toBe('ok');
    expect(fixture.registry.listObservations(SCOPE, candidateId)).toHaveLength(2);
    const reusable = fixture.registry.findReusableObservation({
      scope: SCOPE,
      candidateId,
      field: 'identity',
      context: observationContextFor(context),
    });
    expect(reusable?.value).toMatchObject({ name: '新しい店名' });
  });

  it('blocks the old observation when a refresh provider call fails', async () => {
    const fixture = makeFixture();
    const candidateId = fixture.candidateIds[0] ?? '';
    await read(fixture, readInput(candidateId, ['identity']));
    fixture.setBody(() => {
      throw new Error('provider unavailable');
    });

    const failedRefresh = await read(fixture, readInput(candidateId, ['identity']));
    expect(failedRefresh.status).toBe('partial');
    if (failedRefresh.status !== 'partial') return;
    expect(failedRefresh.data.items[0]?.fields.identity).toMatchObject({
      status: 'error',
      error: { code: 'UPSTREAM_UNAVAILABLE' },
    });

    const retry = await read(fixture, readInput(candidateId, ['identity'], 'reuse_valid'));
    expect(retry.status).toBe('partial');
    expect(fixture.calls).toHaveLength(3);
    if (retry.status !== 'partial') return;
    expect(retry.data.items[0]?.fields.identity).toMatchObject({
      status: 'error',
      error: { code: 'UPSTREAM_UNAVAILABLE' },
    });
  });

  it('blocks old reuse when the response field set does not match', async () => {
    const fixture = makeFixture();
    const candidateId = fixture.candidateIds[0] ?? '';
    await read(fixture, readInput(candidateId, ['identity']));
    const mismatchedTransport: GooglePlaceDetailsTransport = {
      read: () =>
        Promise.resolve({
          placeId: 'different-place',
          fields: ['identity'],
          body: place('place-a'),
        }),
    };
    const mismatchedAdapter = createPlacesDetailsAdapter({
      transport: mismatchedTransport,
      registry: fixture.registry,
      clock: fixture.clock,
      observationPolicy: policy,
      areaLabelFor: () => '渋谷',
    });
    const failedRefresh = await mismatchedAdapter.read(
      readInput(candidateId, ['identity']),
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(failedRefresh.status).toBe('partial');
    if (failedRefresh.status !== 'partial') return;
    expect(failedRefresh.data.items[0]?.fields.identity).toMatchObject({
      status: 'error',
      error: { code: 'SCHEMA_MISMATCH' },
    });

    const recovered = await read(fixture, readInput(candidateId, ['identity'], 'reuse_valid'));
    expect(recovered.status).toBe('ok');
    expect(fixture.calls).toHaveLength(2);
  });

  it('keeps a successful candidate when another candidate provider read fails', async () => {
    const fixture = makeFixture(['place-a', 'place-b']);
    fixture.setBody((id) => {
      if (id === 'place-b') throw new GooglePlaceDetailsError('UPSTREAM_UNAVAILABLE');
      return place(id);
    });
    const result = await read(fixture, {
      requests: [
        { candidateId: fixture.candidateIds[0] ?? '', fields: ['identity'] },
        { candidateId: fixture.candidateIds[1] ?? '', fields: ['identity'] },
      ],
      freshness: 'refresh',
    });
    expect(result.status).toBe('partial');
    if (result.status !== 'partial') return;
    expect(result.data.items[0]?.fields.identity).toMatchObject({ status: 'known' });
    expect(result.data.items[1]?.fields.identity).toMatchObject({
      status: 'error',
      error: { code: 'UPSTREAM_UNAVAILABLE' },
    });
  });

  it('returns unsupported fields without calling Google', async () => {
    const fixture = makeFixture();
    const result = await read(
      fixture,
      readInput(fixture.candidateIds[0] ?? '', ['facilities', 'walking_route', 'last_train']),
    );
    expect(result.status).toBe('partial');
    expect(fixture.calls).toHaveLength(0);
    if (result.status !== 'partial') return;
    expect(result.data.items[0]?.fields.facilities).toMatchObject({ status: 'unsupported' });
  });

  it('reports a known non-Google candidate as unsupported', async () => {
    const fixture = makeFixture();
    const candidate = fixture.registry.registerCandidate({
      ...SCOPE,
      provider: 'other_provider',
      recordRef: 'other-place',
      displayName: '別プロバイダ候補',
      status: 'operational',
    });
    const result = await read(fixture, readInput(candidate.candidateId, ['identity']));
    expect(result.status).toBe('partial');
    expect(fixture.calls).toHaveLength(0);
    if (result.status !== 'partial') return;
    expect(result.data.items[0]?.fields.identity).toMatchObject({ status: 'unsupported' });
  });

  it('rejects a provider response whose id does not match the candidate', async () => {
    const fixture = makeFixture();
    fixture.setBody(() => place('different-place'));
    const result = await read(fixture, readInput(fixture.candidateIds[0] ?? '', ['identity']));
    expect(result.status).toBe('partial');
    expect(fixture.registry.listObservations(SCOPE)).toHaveLength(0);
    if (result.status !== 'partial') return;
    expect(result.data.items[0]?.fields.identity).toMatchObject({
      status: 'error',
      error: { code: 'SOURCE_CONFLICT' },
    });
  });

  it('withholds known values when the observation policy is unavailable', async () => {
    const fixture = makeFixture();
    const options: PlacesDetailsAdapterOptions = {
      transport: createGooglePlaceDetailsTransport({
        apiKey: 'fixture-key',
        fetcher: () => Promise.resolve(new Response(JSON.stringify(place('place-a')))),
      }),
      registry: fixture.registry,
      clock: fixture.clock,
      areaLabelFor: () => '渋谷',
    };
    const adapter = createPlacesDetailsAdapter(options);
    const result = await adapter.read(
      readInput(fixture.candidateIds[0] ?? '', ['identity']),
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(result.status).toBe('partial');
    expect(fixture.registry.listObservations(SCOPE)).toHaveLength(0);
    if (result.status !== 'partial') return;
    expect(result.data.items[0]?.fields.identity).toMatchObject({
      status: 'error',
      error: { code: 'MISSING_CONTEXT' },
    });
  });

  it('checks cancellation before returning a reuse-only result', async () => {
    const fixture = makeFixture();
    const candidateId = fixture.candidateIds[0] ?? '';
    await read(fixture, readInput(candidateId, ['identity']));
    let checks = 0;
    const result = await read(fixture, readInput(candidateId, ['identity'], 'reuse_valid'), {
      isCancelled: () => {
        checks += 1;
        return checks > 1;
      },
    });
    expect(result).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(checks).toBe(2);
  });

  it('does not register a response when cancellation is observed after fetch', async () => {
    const fixture = makeFixture();
    const token = { isCancelled: () => fixture.cancel.value };
    fixture.setBody(() => {
      fixture.cancel.value = true;
      return place('place-a');
    });
    const result = await read(
      fixture,
      readInput(fixture.candidateIds[0] ?? '', ['identity']),
      token,
    );
    expect(result).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(fixture.registry.listObservations(SCOPE)).toHaveLength(0);
  });
});
