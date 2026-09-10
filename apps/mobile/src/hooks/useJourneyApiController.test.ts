import { describe, expect, it } from 'vitest';
import { journeyApiErrorMessage, requestStatusFor } from './useJourneyApiController';
import {
  awaitRetryIfCurrent,
  operationStillCurrent,
  releaseJourneyApiController,
  restoreThenReadIfCurrent,
  submissionScopeMatches,
} from './journey-api-operation-flow';

describe('Journey API hook boundary', () => {
  it('maps every controller operation state to the screen request lifecycle', () => {
    expect(requestStatusFor('creating')).toBe('pending');
    expect(requestStatusFor('pending')).toBe('pending');
    expect(requestStatusFor('cancelling')).toBe('pending');
    expect(requestStatusFor('reading')).toBe('pending');
    expect(requestStatusFor('replaying')).toBe('pending');
    expect(requestStatusFor('error')).toBe('error');
    expect(requestStatusFor('cancelled')).toBe('cancelled');
    expect(requestStatusFor('idle')).toBe('idle');
  });

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
