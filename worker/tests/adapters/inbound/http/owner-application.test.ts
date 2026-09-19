import { describe, expect, it } from 'vitest';
import type { Preferences, PrefsWriteRequest } from '@ima/contracts';
import { HttpBoundaryError } from '@worker/adapters/in/http/errors';
import type { HandlerContext } from '@worker/adapters/in/http/handler';
import {
  handleOwnerApplication,
  type OwnerSavedCandidateResolver,
} from '@worker/adapters/in/http/owner-application';
import { createMemoryOwnerStore } from '@worker/adapters/out/persistence/saved-references/memory-owner-store';
import type { OwnerStore } from '@worker/application/ports/owner-store';

const OWNER = 'owner-a';
const REQUEST_ID = 'request-1';

const PREFS: Preferences = {
  homeStationRef: 'station-home',
  maxWalkMinutes: 12,
  minimumStayMinutes: 45,
  areaText: 'Shibuya',
  budget: 'normal',
};

const OTHER_PREFS: Preferences = {
  ...PREFS,
  budget: 'cheap',
};

const unusedCandidate: OwnerSavedCandidateResolver = () =>
  Promise.reject(new Error('candidate resolution should not run'));

const contextFor = (ownerScopeRef = OWNER): HandlerContext => ({
  requestId: REQUEST_ID,
  ownerScopeRef,
  deviceId: 'device-1',
  appVersion: '1.0.0',
  serverNow: '2026-09-12T12:00:00Z',
  cancellation: { isCancelled: () => false },
  signal: new AbortController().signal,
});

const deps = (
  ownerStore: OwnerStore | undefined,
  resolveSavedCandidate: OwnerSavedCandidateResolver = unusedCandidate,
) => ({ ownerStore, resolveSavedCandidate });

const writeInput = (expectedRevision: number, prefs: Preferences): PrefsWriteRequest => ({
  schemaVersion: 'v1',
  requestId: REQUEST_ID,
  expectedRevision,
  prefs,
});

const expectBoundary = async (
  operation: () => Promise<unknown>,
  failure: { readonly status: number; readonly code: string },
): Promise<void> => {
  try {
    await operation();
    throw new Error('expected HttpBoundaryError');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HttpBoundaryError);
    if (!(error instanceof HttpBoundaryError)) throw error;
    expect(error.failure).toEqual(failure);
  }
};

describe('owner application', () => {
  it('writes prefs at revision 0 to 1 and reads them back', async () => {
    const store = createMemoryOwnerStore();
    const unread = await handleOwnerApplication({ kind: 'prefs_read' }, contextFor(), deps(store));
    const written = await handleOwnerApplication(
      { kind: 'prefs_write', input: writeInput(0, PREFS) },
      contextFor(),
      deps(store),
    );
    const read = await handleOwnerApplication({ kind: 'prefs_read' }, contextFor(), deps(store));

    expect(unread).toEqual({
      kind: 'prefs_read',
      response: { schemaVersion: 'v1', requestId: REQUEST_ID, revision: 0, prefs: null },
    });
    expect(written).toEqual({
      kind: 'prefs_write',
      response: { schemaVersion: 'v1', requestId: REQUEST_ID, revision: 1 },
    });
    expect(read).toEqual({
      kind: 'prefs_read',
      response: { schemaVersion: 'v1', requestId: REQUEST_ID, revision: 1, prefs: PREFS },
    });
  });

  it('rejects a stale expectedRevision as conflict', async () => {
    const store = createMemoryOwnerStore();
    await handleOwnerApplication(
      { kind: 'prefs_write', input: writeInput(0, PREFS) },
      contextFor(),
      deps(store),
    );
    await expectBoundary(
      () =>
        handleOwnerApplication(
          { kind: 'prefs_write', input: writeInput(0, OTHER_PREFS) },
          contextFor(),
          deps(store),
        ),
      { status: 409, code: 'CONFLICT' },
    );
    const read = await handleOwnerApplication({ kind: 'prefs_read' }, contextFor(), deps(store));
    expect(read).toMatchObject({ response: { revision: 1, prefs: PREFS } });
  });

  it('lists opaque saved refs only after register', async () => {
    const store = createMemoryOwnerStore({ nextSavedPlaceRef: () => 'saved-1' });
    const empty = await handleOwnerApplication(
      { kind: 'saved_reference_list' },
      contextFor(),
      deps(store),
    );
    const registered = await store.register(OWNER, {
      provider: 'google_places',
      recordRef: 'ChIJ-owner-app',
    });
    const listed = await handleOwnerApplication(
      { kind: 'saved_reference_list' },
      contextFor(),
      deps(store),
    );

    expect(empty).toEqual({
      kind: 'saved_reference_list',
      response: { schemaVersion: 'v1', requestId: REQUEST_ID, savedPlaceRefs: [], decided: [] },
    });
    expect(registered).toMatchObject({ ok: true, created: true });
    expect(listed).toEqual({
      kind: 'saved_reference_list',
      response: {
        schemaVersion: 'v1',
        requestId: REQUEST_ID,
        savedPlaceRefs: ['saved-1'],
        decided: [],
      },
    });
    expect(JSON.stringify(listed)).not.toContain('google_places');
    expect(JSON.stringify(listed)).not.toContain('ChIJ-owner-app');
  });

  it('decides a candidate through OwnerStore using serverNow', async () => {
    const store = createMemoryOwnerStore({
      nextSavedPlaceRef: () => 'saved-decided',
    });
    const result = await handleOwnerApplication(
      {
        kind: 'place_decide',
        path: { threadId: 'thread-1' },
        input: {
          schemaVersion: 'v1',
          requestId: REQUEST_ID,
          candidateId: 'candidate-1',
          revision: 1,
          idempotencyKey: 'decide-1',
        },
      },
      contextFor(),
      deps(store, () =>
        Promise.resolve({
          ok: true,
          candidateId: 'candidate-1',
          provider: 'google_places',
          recordRef: 'ChIJ-decide',
        }),
      ),
    );
    const listed = await handleOwnerApplication(
      { kind: 'saved_reference_list' },
      contextFor(),
      deps(store),
    );

    expect(result).toEqual({
      kind: 'place_decide',
      response: {
        schemaVersion: 'v1',
        requestId: REQUEST_ID,
        candidateId: 'candidate-1',
        savedPlaceRef: 'saved-decided',
        decidedAt: '2026-09-12T12:00:00Z',
      },
    });
    expect(listed).toEqual({
      kind: 'saved_reference_list',
      response: {
        schemaVersion: 'v1',
        requestId: REQUEST_ID,
        savedPlaceRefs: ['saved-decided'],
        decided: [{ savedPlaceRef: 'saved-decided', decidedAt: '2026-09-12T12:00:00Z' }],
      },
    });
  });

  it('returns provider unavailable when OwnerStore is missing', async () => {
    await expectBoundary(
      () => handleOwnerApplication({ kind: 'prefs_read' }, contextFor(), deps(undefined)),
      { status: 502, code: 'PROVIDER_UNAVAILABLE' },
    );
  });
});
