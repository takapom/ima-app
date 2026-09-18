import { describe, expect, it } from 'vitest';
import { journeyApiErrorMessage } from '@mobile/hooks/useJourneyApiController';
import {
  awaitRetryIfCurrent,
  operationStillCurrent,
  retryCreatedThreadThenSearchIfCurrent,
  releaseJourneyApiController,
  restoreThenReadIfCurrent,
  submissionScopeMatches,
} from '@mobile/hooks/journey-api-operation-flow';

describe('Journey API hook boundary', () => {
  it('keeps public error messages safe and actionable without exposing response details', () => {
    expect(journeyApiErrorMessage({ kind: 'offline' })).toContain('接続');
    expect(journeyApiErrorMessage({ kind: 'timeout' })).toContain('時間');
    expect(
      journeyApiErrorMessage({
        kind: 'http',
        status: 429,
        publicError: {
          schemaVersion: 'v1',
          requestId: 'error-request',
          status: 429,
          code: 'RATE_LIMITED',
          message: 'retry later',
        },
        retryAfterSeconds: 3,
      }),
    ).toContain('混み合');
    expect(
      journeyApiErrorMessage({
        kind: 'contract',
        route: 'search',
        issues: ['secret provider response'],
        status: 500,
      }),
    ).not.toContain('secret');
    expect(journeyApiErrorMessage(null)).toBeNull();
  });

  it('explains a turn that ended without cards instead of blaming the connection', () => {
    const httpError = (status: 422 | 504, code: 'BUDGET_EXCEEDED' | 'TIMEOUT') => ({
      kind: 'http' as const,
      status,
      publicError: {
        schemaVersion: 'v1' as const,
        requestId: 'error-request',
        status,
        code,
        message: 'unused',
      },
      retryAfterSeconds: null,
    });

    const budget = journeyApiErrorMessage(httpError(422, 'BUDGET_EXCEEDED'));
    expect(budget).toContain('候補');
    expect(budget).not.toContain('サービスに接続できませんでした');
    expect(journeyApiErrorMessage(httpError(504, 'TIMEOUT'))).toContain('時間');
  });

  it('stops an older history continuation after a newer thread takes over', async () => {
    let releaseRestore: (() => void) | undefined;
    let generation = 1;
    let currentThread: string | null = 'thread-a';
    const restore = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const readThreads: string[] = [];
    const controller = {
      restoreLocal: () => restore,
      readThread: (threadId: string) => {
        readThreads.push(threadId);
        return Promise.resolve();
      },
      getState: () => ({ threadId: currentThread }),
    };
    const selection = restoreThenReadIfCurrent(controller, 'thread-a', () => generation === 1);
    generation = 2;
    currentThread = 'thread-b';
    releaseRestore?.();

    await expect(selection).resolves.toBe(false);
    expect(readThreads).toEqual([]);
    expect(submissionScopeMatches('thread-a', currentThread)).toBe(false);
    expect(submissionScopeMatches(null, null)).toBe(true);
  });

  it('does not resume a retry after the operation generation or thread changes', () => {
    expect(operationStillCurrent(1, 2, 'thread-a', 'thread-a')).toBe(false);
    expect(operationStillCurrent(1, 1, 'thread-a', 'thread-b')).toBe(false);
    expect(operationStillCurrent(1, 1, 'thread-a', 'thread-a')).toBe(true);
  });

  it('continues the original search only when a retried create stays current', async () => {
    const generation = 1;
    let threadId: string | null = null;
    let searches = 0;
    const retried = retryCreatedThreadThenSearchIfCurrent(
      generation,
      () => ({ generation, threadId }),
      () => {
        threadId = 'thread-created';
        return Promise.resolve({
          ok: true as const,
          requestId: 'create-request',
          data: {
            schemaVersion: 'v1' as const,
            requestId: 'create-request',
            threadId: 'thread-created',
            revision: 0,
            state: 'active' as const,
          },
        });
      },
      () => {
        searches += 1;
        return Promise.resolve({
          ok: true as const,
          requestId: 'search-request',
          data: {} as never,
        });
      },
    );

    await expect(retried).resolves.toMatchObject({ current: true, result: { ok: true } });
    expect(searches).toBe(1);
  });

  it('drops a retried create before search when generation changes', async () => {
    let generation = 1;
    let threadId: string | null = null;
    let searches = 0;
    const retried = retryCreatedThreadThenSearchIfCurrent(
      generation,
      () => ({ generation, threadId }),
      () => {
        generation = 2;
        threadId = 'thread-created';
        return Promise.resolve({
          ok: true as const,
          requestId: 'create-request',
          data: {
            schemaVersion: 'v1' as const,
            requestId: 'create-request',
            threadId: 'thread-created',
            revision: 0,
            state: 'active' as const,
          },
        });
      },
      () => {
        searches += 1;
        return Promise.resolve({
          ok: false as const,
          requestId: 'search-request',
          error: { kind: 'offline' as const },
        });
      },
    );

    await expect(retried).resolves.toEqual({ current: false });
    expect(searches).toBe(0);
  });

  it('drops a late search result after the retried create changes scope', async () => {
    let generation = 1;
    let threadId: string | null = null;
    const retried = retryCreatedThreadThenSearchIfCurrent(
      generation,
      () => ({ generation, threadId }),
      () => {
        threadId = 'thread-created';
        return Promise.resolve({
          ok: true as const,
          requestId: 'create-request',
          data: {
            schemaVersion: 'v1' as const,
            requestId: 'create-request',
            threadId: 'thread-created',
            revision: 0,
            state: 'active' as const,
          },
        });
      },
      () => {
        generation = 2;
        return Promise.resolve({
          ok: true as const,
          requestId: 'search-request',
          data: {} as never,
        });
      },
    );

    await expect(retried).resolves.toEqual({ current: false });
  });

  it('releases host-owned work without permanently disposing the controller', () => {
    const state = { status: 'idle' as const, threadId: 'thread-kept' };
    releaseJourneyApiController({
      cancelPending: () => {
        throw new Error('idle controller must not be cancelled');
      },
      getState: () => ({ ...state, mode: 'fixture' as const }),
    });
    expect(state).toEqual({ status: 'idle', threadId: 'thread-kept' });
  });

  it('cancels pending work while leaving the controller reset-free', () => {
    const calls: string[] = [];
    releaseJourneyApiController({
      cancelPending: () => calls.push('cancel'),
      getState: () => ({ status: 'pending', mode: 'fixture', threadId: 'thread-a' }),
    });
    expect(calls).toEqual(['cancel']);
  });

  it('drops a retry result when a newer thread takes over while it is pending', async () => {
    let release: (() => void) | undefined;
    let generation = 1;
    let threadId: string | null = 'thread-a';
    const pending = new Promise<string>((resolve) => {
      release = () => resolve('old-retry');
    });
    const retry = awaitRetryIfCurrent(
      generation,
      threadId,
      () => ({ generation, threadId }),
      () => pending,
    );
    generation = 2;
    threadId = 'thread-b';
    release?.();

    await expect(retry).resolves.toEqual({ current: false });
  });

  it('does not publish an old history selection after its read settles', async () => {
    let releaseRead: (() => void) | undefined;
    let generation = 1;
    let currentThread: string | null = 'thread-a';
    const read = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const controller = {
      restoreLocal: () => Promise.resolve(),
      readThread: () => read,
      getState: () => ({ threadId: currentThread }),
    };
    const selection = restoreThenReadIfCurrent(controller, 'thread-a', () => generation === 1);
    await Promise.resolve();
    generation = 2;
    currentThread = 'thread-b';
    releaseRead?.();

    await expect(selection).resolves.toBe(false);
  });
});
