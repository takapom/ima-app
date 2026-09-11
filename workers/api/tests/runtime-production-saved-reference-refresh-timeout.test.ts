import { describe, expect, it, vi } from 'vitest';
import type { SavedPlaceReference } from '@ima/core';
import type { GooglePlaceDetailsResponse } from '../src/providers/places-details/types';
import {
  createSavedReferenceRefreshHandler,
  createSavedReferenceScopeAuthorizer,
} from '../src/saved-references/saved-reference-refresh';
import {
  contextFor,
  createReadDelayedNamespace,
  handlerFor,
  operationFor,
  ownerFor,
  readError,
  registerReference,
  responseFor,
  retentionFor,
} from './runtime-production-saved-reference-refresh-fixtures';

describe('threadless saved-reference refresh request lifetime', () => {
  it('does not issue a provider call when the owner read resolves after the whole request deadline', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-owner-timeout-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    let release: (result: {
      readonly ok: true;
      readonly reference: SavedPlaceReference | null;
    }) => void = () => undefined;
    const namespace = createReadDelayedNamespace(reference, (nextRelease) => {
      release = nextRelease;
    });
    let providerCalls = 0;
    let candidateCalls = 0;
    const handler = createSavedReferenceRefreshHandler({
      namespace,
      transport: {
        read: () => {
          providerCalls += 1;
          return Promise.resolve(responseFor(recordRef));
        },
      },
      retentionFor,
      timeoutMs: 5,
      candidateIdFactory: () => {
        candidateCalls += 1;
        return `refresh-candidate-${crypto.randomUUID()}`;
      },
    });
    const pending = readError(
      handler.handle(operationFor(reference.savedPlaceRef), contextFor(owner)),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    const error = await pending;
    expect(error.failure).toEqual({ status: 504, code: 'TIMEOUT' });
    release({ ok: true, reference });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(providerCalls).toBe(0);
    expect(candidateCalls).toBe(0);
  });

  it('does not publish a late provider response after the request deadline', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-provider-timeout-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let release: ((response: GooglePlaceDetailsResponse) => void) | undefined;
    let candidateCalls = 0;
    const handler = handlerFor(
      {
        read: () => {
          startedResolve?.();
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
      {
        timeoutMs: 20,
        candidateIdFactory: () => {
          candidateCalls += 1;
          return `refresh-candidate-${crypto.randomUUID()}`;
        },
      },
    );
    const pending = readError(
      handler.handle(operationFor(reference.savedPlaceRef), contextFor(owner)),
    );
    await started;
    const error = await pending;
    expect(error.failure).toEqual({ status: 504, code: 'TIMEOUT' });
    release?.(responseFor(recordRef));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(candidateCalls).toBe(0);
  });

  it('drops a provider body when the second owner read remains pending past the deadline', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-reread-timeout-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    let release: (result: {
      readonly ok: true;
      readonly reference: SavedPlaceReference | null;
    }) => void = () => undefined;
    const namespace = createReadDelayedNamespace(
      reference,
      (nextRelease) => {
        release = nextRelease;
      },
      2,
    );
    let providerCalls = 0;
    let candidateCalls = 0;
    let providerStartedResolve: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      providerStartedResolve = resolve;
    });
    const handler = createSavedReferenceRefreshHandler({
      namespace,
      transport: {
        read: () => {
          providerCalls += 1;
          providerStartedResolve?.();
          return Promise.resolve(responseFor(recordRef));
        },
      },
      retentionFor,
      timeoutMs: 20,
      candidateIdFactory: () => {
        candidateCalls += 1;
        return `refresh-candidate-${crypto.randomUUID()}`;
      },
    });
    const pending = readError(
      handler.handle(operationFor(reference.savedPlaceRef), contextFor(owner)),
    );
    await providerStarted;
    const error = await pending;
    expect(error.failure).toEqual({ status: 504, code: 'TIMEOUT' });
    release({ ok: true, reference });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(providerCalls).toBe(1);
    expect(candidateCalls).toBe(0);
  });

  it('rejects a reference deleted during provider refresh without publishing its body', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-reread-delete-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    let release: (result: {
      readonly ok: true;
      readonly reference: SavedPlaceReference | null;
    }) => void = () => undefined;
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    const namespace = createReadDelayedNamespace(
      reference,
      (nextRelease) => {
        release = nextRelease;
        readyResolve?.();
      },
      2,
    );
    let providerCalls = 0;
    let candidateCalls = 0;
    const handler = createSavedReferenceRefreshHandler({
      namespace,
      transport: {
        read: () => {
          providerCalls += 1;
          return Promise.resolve(responseFor(recordRef));
        },
      },
      retentionFor,
      candidateIdFactory: () => {
        candidateCalls += 1;
        return `refresh-candidate-${crypto.randomUUID()}`;
      },
    });
    const pending = readError(
      handler.handle(operationFor(reference.savedPlaceRef), contextFor(owner)),
    );
    await ready;
    release({ ok: true, reference: null });
    const error = await pending;
    expect(error.failure).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(providerCalls).toBe(1);
    expect(candidateCalls).toBe(0);
  });

  it('returns a timeout failure when the owner authorization read does not resolve', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-authorizer-timeout-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    const namespace = createReadDelayedNamespace(reference, () => undefined);
    vi.useFakeTimers();
    try {
      const pending = createSavedReferenceScopeAuthorizer(namespace).authorize({
        ownerScopeRef: owner,
        resource: { kind: 'saved_reference', id: reference.savedPlaceRef },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toEqual({
        allowed: false,
        failure: { status: 504, code: 'TIMEOUT' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a non-timeout owner authorization error to internal', async () => {
    const { owner } = await ownerFor();
    const recordRef = `ChIJ-refresh-authorizer-error-${crypto.randomUUID()}`;
    const { reference } = await registerReference(owner, recordRef);
    const namespace = createReadDelayedNamespace(reference, () => {
      throw new Error('M16_REFRESH_AUTHORIZATION_FAILURE');
    });
    await expect(
      createSavedReferenceScopeAuthorizer(namespace).authorize({
        ownerScopeRef: owner,
        resource: { kind: 'saved_reference', id: reference.savedPlaceRef },
      }),
    ).resolves.toEqual({
      allowed: false,
      failure: { status: 500, code: 'INTERNAL' },
    });
  });
});
