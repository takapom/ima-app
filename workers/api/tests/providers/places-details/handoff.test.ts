import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { CandidateRegistrationSchema, type SavedPlaceReference } from '@ima/core';
import {
  createPlacesDetailsAdapter,
  type PlacesDetailsAdapterOptions,
} from '../../../src/providers/places-details/adapter';
import {
  createSavedReferenceDetailsHandoff,
  createSavedReferenceGoogleProvider,
  createHandoffCandidateRegistry,
} from '../../../src/runtime/saved-references/runtime-saved-reference-handoff';
import type { SavedReferenceProviderRefreshRequest } from '../../../src/runtime/saved-references/runtime-saved-reference-resolver';
import {
  context,
  execution,
  makeFixture,
  place,
  policy,
  readInput,
  SCOPE,
} from './adapter-fixtures';
import type {
  GooglePlaceDetailsField,
  GooglePlaceDetailsRequest,
  GooglePlaceDetailsResponse,
  GooglePlaceDetailsTransport,
} from '../../../src/providers/places-details/types';
import { createGooglePlaceDetailsTransport } from '../../../src/providers/places-details/transport';

const EXPIRES_AT = '2026-09-10T04:00:00.000Z';
const SAVED_PLACE_REF = 'saved-place';

const binding = {
  savedPlaceRef: SAVED_PLACE_REF,
  scope: SCOPE,
  turnId: context.turnId,
  revision: context.revision,
} as const;

const responseFor = (
  fields: readonly GooglePlaceDetailsField[] = ['identity'],
): GooglePlaceDetailsResponse => ({
  placeId: 'place-a',
  fields,
  body: place('place-a'),
});

const stageAndBind = (
  handoff: ReturnType<typeof createSavedReferenceDetailsHandoff>,
  fixture: ReturnType<typeof makeFixture>,
  fields: readonly GooglePlaceDetailsField[] = ['identity'],
): void => {
  handoff.stage({
    ...binding,
    provider: 'google_places',
    fields,
    response: responseFor(fields),
    observedAt: fixture.clock.now(),
    expiresAt: EXPIRES_AT,
  });
  const candidate = fixture.registry.readCandidate(SCOPE, fixture.candidateIds[0] ?? '');
  expect(candidate).toBeDefined();
  if (candidate === undefined) return;
  expect(handoff.canBindCandidate({ binding, candidate })).toBe(true);
  expect(handoff.bindCandidate({ binding, candidate })).toBe(true);
};

const adapterFor = (
  fixture: ReturnType<typeof makeFixture>,
  handoff: ReturnType<typeof createSavedReferenceDetailsHandoff>,
  transport: GooglePlaceDetailsTransport,
): ReturnType<typeof createPlacesDetailsAdapter> => {
  const options: PlacesDetailsAdapterOptions = {
    transport,
    registry: fixture.registry,
    clock: fixture.clock,
    observationPolicy: policy,
    areaLabelFor: () => '渋谷',
    savedReferenceHandoff: handoff,
  };
  return createPlacesDetailsAdapter(options);
};

describe('saved-reference details handoff', () => {
  it('consumes a provider response once and avoids a second Details request', async () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    stageAndBind(handoff, fixture);
    const readMock = vi.fn(() => Promise.reject(new Error('handoff should cover the first read')));
    const transport: GooglePlaceDetailsTransport = { read: readMock };
    const adapter = adapterFor(fixture, handoff, transport);

    const first = await adapter.read(
      readInput(fixture.candidateIds[0] ?? '', ['identity']),
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(first.status).toBe('ok');
    expect(readMock).not.toHaveBeenCalled();
    expect(fixture.registry.listObservations(SCOPE)).toHaveLength(1);

    const second = await adapter.read(
      readInput(fixture.candidateIds[0] ?? '', ['identity']),
      context,
      execution,
      { isCancelled: () => false },
    );
    expect(second.status).toBe('partial');
    expect(readMock).toHaveBeenCalledOnce();
  });

  it('requires the complete saved-reference and turn binding before candidate registration', () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    handoff.stage({
      ...binding,
      provider: 'google_places',
      fields: ['identity'],
      response: responseFor(),
      observedAt: fixture.clock.now(),
      expiresAt: EXPIRES_AT,
    });
    const candidate = fixture.registry.readCandidate(SCOPE, fixture.candidateIds[0] ?? '');
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;

    expect(
      handoff.canBindCandidate({
        binding: { ...binding, turnId: 'another-turn' },
        candidate,
      }),
    ).toBe(false);
    expect(
      handoff.canBindCandidate({
        binding,
        candidate: { ...candidate, ownerScopeRef: 'another-owner' },
      }),
    ).toBe(false);
    expect(
      handoff.bindCandidate({
        binding: { ...binding, savedPlaceRef: 'another-saved-place' },
        candidate,
      }),
    ).toBe(false);
    expect(
      handoff.coverageForCandidate({
        candidateId: candidate.candidateId,
        scope: SCOPE,
        turnId: context.turnId,
        revision: context.revision,
        fields: ['identity'],
      }),
    ).toBeUndefined();
  });

  it('returns a typed stale result at the deadline without provider I/O', async () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    stageAndBind(handoff, fixture);
    fixture.clock.set(EXPIRES_AT);
    const readMock = vi.fn(() => Promise.resolve(responseFor()));
    const transport: GooglePlaceDetailsTransport = { read: readMock };
    const adapter = adapterFor(fixture, handoff, transport);

    const result = await adapter.read(
      readInput(fixture.candidateIds[0] ?? '', ['identity']),
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(result.status).toBe('partial');
    expect(readMock).not.toHaveBeenCalled();
    if (result.status !== 'partial') return;
    expect(result.data.items[0]?.fields.identity).toMatchObject({
      status: 'error',
      error: { code: 'STALE_TURN' },
    });
    const candidate = fixture.registry.readCandidate(SCOPE, fixture.candidateIds[0] ?? '');
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(
      handoff.coverageForCandidate({
        candidateId: candidate.candidateId,
        scope: SCOPE,
        turnId: context.turnId,
        revision: context.revision,
        fields: ['identity'],
      }),
    ).toBeUndefined();
  });

  it('clears staged data when the Details operation is cancelled before it starts', async () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    stageAndBind(handoff, fixture);
    const readMock = vi.fn(() => Promise.resolve(responseFor()));
    const transport: GooglePlaceDetailsTransport = { read: readMock };
    const adapter = adapterFor(fixture, handoff, transport);

    const result = await adapter.read(
      readInput(fixture.candidateIds[0] ?? '', ['identity']),
      context,
      execution,
      { isCancelled: () => true },
    );

    expect(result).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(readMock).not.toHaveBeenCalled();
    const candidate = fixture.registry.readCandidate(SCOPE, fixture.candidateIds[0] ?? '');
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(
      handoff.coverageForCandidate({
        candidateId: candidate.candidateId,
        scope: SCOPE,
        turnId: context.turnId,
        revision: context.revision,
        fields: ['identity'],
      }),
    ).toBeUndefined();
  });

  it('clears staged data when reuse invalidation fails before provider I/O', async () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    stageAndBind(handoff, fixture);
    fixture.registry.invalidateObservationReuse = () => {
      throw new Error('registry unavailable');
    };
    const readMock = vi.fn(() => Promise.resolve(responseFor()));
    const transport: GooglePlaceDetailsTransport = { read: readMock };
    const adapter = adapterFor(fixture, handoff, transport);

    const result = await adapter.read(
      readInput(fixture.candidateIds[0] ?? '', ['identity']),
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(result).toMatchObject({ status: 'error', error: { code: 'MISSING_CONTEXT' } });
    expect(readMock).not.toHaveBeenCalled();
    const candidate = fixture.registry.readCandidate(SCOPE, fixture.candidateIds[0] ?? '');
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(
      handoff.coverageForCandidate({
        candidateId: candidate.candidateId,
        scope: SCOPE,
        turnId: context.turnId,
        revision: context.revision,
        fields: ['identity'],
      }),
    ).toBeUndefined();
  });

  it('clears staged data when the server clock is invalid before provider I/O', async () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    stageAndBind(handoff, fixture);
    fixture.clock.set('invalid-clock');
    const readMock = vi.fn(() => Promise.resolve(responseFor()));
    const transport: GooglePlaceDetailsTransport = { read: readMock };
    const adapter = adapterFor(fixture, handoff, transport);

    const result = await adapter.read(
      readInput(fixture.candidateIds[0] ?? '', ['identity']),
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(result).toMatchObject({ status: 'error', error: { code: 'MISSING_CONTEXT' } });
    expect(readMock).not.toHaveBeenCalled();
    const candidate = fixture.registry.readCandidate(SCOPE, fixture.candidateIds[0] ?? '');
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(
      handoff.coverageForCandidate({
        candidateId: candidate.candidateId,
        scope: SCOPE,
        turnId: context.turnId,
        revision: context.revision,
        fields: ['identity'],
      }),
    ).toBeUndefined();
  });
});

describe('saved-reference Google provider handoff', () => {
  const reference: SavedPlaceReference = {
    savedPlaceRef: SAVED_PLACE_REF,
    ownerScopeRef: SCOPE.ownerScopeRef,
    provider: 'google_places',
    recordRef: 'place-a',
  };

  const providerRequest = (
    cancellation: { readonly isCancelled: () => boolean } = { isCancelled: () => false },
  ): SavedReferenceProviderRefreshRequest => ({
    savedPlaceRef: SAVED_PLACE_REF,
    reference,
    scope: SCOPE,
    fields: ['identity', 'price'],
    context,
    execution,
    cancellation,
  });

  it('hands one normalized provider response to the existing adapter without a second fetch', async () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    const fetchMock: typeof fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(place('place-a')), { status: 200 })),
    );
    const transport = createGooglePlaceDetailsTransport({
      apiKey: 'fixture-key',
      fetcher: fetchMock,
    });
    const provider = createSavedReferenceGoogleProvider({
      transport,
      handoff,
      areaLabelFor: () => '渋谷',
      now: () => fixture.clock.now(),
      sessionExpiresAt: () => '2026-09-11T00:00:00.000Z',
    });
    const refreshed = await provider.refresh(providerRequest());
    expect(refreshed).toMatchObject({
      status: 'ok',
      candidate: { provider: 'google_places', recordRef: 'place-a' },
    });
    if (typeof refreshed !== 'object' || refreshed === null || !('candidate' in refreshed)) return;
    const parsedCandidate = v.safeParse(CandidateRegistrationSchema, refreshed.candidate);
    expect(parsedCandidate.success).toBe(true);
    if (!parsedCandidate.success) return;
    const registered = createHandoffCandidateRegistry(fixture.registry, handoff).registerCandidate(
      parsedCandidate.output,
      binding,
    );
    const adapter = adapterFor(fixture, handoff, transport);
    const result = await adapter.read(
      readInput(registered.candidateId, ['identity', 'price']),
      context,
      execution,
      { isCancelled: () => false },
    );

    expect(result.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledOnce();
    if (result.status !== 'ok') return;
    expect(result.data.items[0]?.fields.identity).toMatchObject({ status: 'known' });
    expect(result.data.items[0]?.fields.price).toMatchObject({ status: 'known' });
  });

  it('does not stage a response when the provider operation is cancelled after fetch', async () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    let cancelled = false;
    const readMock = vi.fn(() => {
      cancelled = true;
      return Promise.resolve(responseFor(['identity', 'price']));
    });
    const provider = createSavedReferenceGoogleProvider({
      transport: { read: readMock },
      handoff,
      areaLabelFor: () => '渋谷',
      now: () => fixture.clock.now(),
      sessionExpiresAt: () => '2026-09-11T00:00:00.000Z',
    });

    const result = await provider.refresh(providerRequest({ isCancelled: () => cancelled }));
    expect(result).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
    expect(
      handoff.coverageForCandidate({
        candidateId: 'not-registered',
        scope: SCOPE,
        turnId: context.turnId,
        revision: context.revision,
        fields: ['identity'],
      }),
    ).toBeUndefined();
  });

  it('rejects a response whose body identifies another provider place', async () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    const readMock = vi.fn((request: GooglePlaceDetailsRequest) =>
      Promise.resolve({
        placeId: request.placeId,
        fields: request.fields,
        body: place('different-place'),
      } satisfies GooglePlaceDetailsResponse),
    );
    const provider = createSavedReferenceGoogleProvider({
      transport: { read: readMock },
      handoff,
      areaLabelFor: () => '渋谷',
      now: () => fixture.clock.now(),
      sessionExpiresAt: () => '2026-09-11T00:00:00.000Z',
    });

    const result = await provider.refresh(providerRequest());
    expect(result).toMatchObject({ status: 'error', error: { code: 'SCHEMA_MISMATCH' } });
  });

  it('requires an explicit host area label instead of inventing one', async () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    const readMock = vi.fn((request: GooglePlaceDetailsRequest) =>
      Promise.resolve({
        placeId: request.placeId,
        fields: request.fields,
        body: place(request.placeId),
      } satisfies GooglePlaceDetailsResponse),
    );
    const provider = createSavedReferenceGoogleProvider({
      transport: { read: readMock },
      handoff,
      areaLabelFor: () => undefined,
      now: () => fixture.clock.now(),
      sessionExpiresAt: () => '2026-09-11T00:00:00.000Z',
    });

    const result = await provider.refresh(providerRequest());
    expect(result).toMatchObject({ status: 'error', error: { code: 'MISSING_CONTEXT' } });
    expect(readMock).not.toHaveBeenCalled();
  });

  it('rejects a scope or execution mismatch before provider I/O', async () => {
    const fixture = makeFixture();
    const handoff = createSavedReferenceDetailsHandoff(() => fixture.clock.now());
    const readMock = vi.fn((request: GooglePlaceDetailsRequest) =>
      Promise.resolve({
        placeId: request.placeId,
        fields: request.fields,
        body: place(request.placeId),
      } satisfies GooglePlaceDetailsResponse),
    );
    const transport: GooglePlaceDetailsTransport = { read: readMock };
    const provider = createSavedReferenceGoogleProvider({
      transport,
      handoff,
      areaLabelFor: () => '渋谷',
      now: () => fixture.clock.now(),
      sessionExpiresAt: () => '2026-09-11T00:00:00.000Z',
    });

    const result = await provider.refresh({
      ...providerRequest(),
      scope: { ...SCOPE, threadId: 'another-thread' },
    });
    expect(result).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT' } });
    expect(readMock).not.toHaveBeenCalled();
  });
});
