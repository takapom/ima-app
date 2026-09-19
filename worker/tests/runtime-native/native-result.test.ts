import { describe, expect, it } from 'vitest';
import type { RuntimeThinkTurnResult } from '@worker/runtime/turn-execution/runtime-think-connection';
import { threadRuntimeResultFromNative } from '@worker/runtime/threads/native-result';

const nativeError = (
  error: string,
  extra: Partial<RuntimeThinkTurnResult<unknown>> = {},
): RuntimeThinkTurnResult<unknown> => ({
  requestId: 'native-result-request',
  status: 'error',
  error,
  response: null,
  ...extra,
});

const nativeCompleted = (response: unknown): RuntimeThinkTurnResult<unknown> => ({
  requestId: 'native-result-request',
  status: 'completed',
  response,
});

const guardCode = (
  guard: NonNullable<RuntimeThinkTurnResult<unknown>['runtimeGuardFailureCode']>,
): string | undefined =>
  threadRuntimeResultFromNative(nativeError('', { runtimeGuardFailureCode: guard }), () => false)
    .code;

describe('threadRuntimeResultFromNative', () => {
  it('converts the known upstream provider code into a typed runtime failure', () => {
    expect(threadRuntimeResultFromNative(nativeError('UPSTREAM_UNAVAILABLE'), () => false)).toEqual(
      {
        status: 'failed',
        requestId: 'native-result-request',
        response: null,
        code: 'RUNTIME_FAILED',
      },
    );
  });

  it('classifies arbitrary SDK error text without returning it', () => {
    const result = threadRuntimeResultFromNative(
      nativeError('provider-secret-canary: runtime provider exploded'),
      () => false,
    );
    expect(result).toEqual({
      status: 'failed',
      requestId: 'native-result-request',
      response: null,
      code: 'RUNTIME_FAILED',
    });
    expect(JSON.stringify(result)).not.toContain('provider-secret-canary');
  });

  it('keeps guard failures typed even when the SDK error text is absent', () => {
    expect(
      threadRuntimeResultFromNative(
        nativeError('', { runtimeGuardFailureCode: 'MIXED_TERMINAL_ACTION' }),
        () => false,
      ),
    ).toMatchObject({
      status: 'failed',
      code: 'MIXED_TERMINAL_ACTION',
      response: null,
    });
  });

  it('separates a spent budget, a model timeout, and a protocol violation', () => {
    expect(guardCode('BUDGET_EXCEEDED')).toBe('BUDGET_EXCEEDED');
    expect(guardCode('FINAL_RESERVE')).toBe('BUDGET_EXCEEDED');
    expect(guardCode('MODEL_STREAM_LIMIT')).toBe('BUDGET_EXCEEDED');
    expect(guardCode('DEADLINE')).toBe('MODEL_TIMEOUT');
    expect(guardCode('MODEL_STREAM_TIMEOUT')).toBe('MODEL_TIMEOUT');
    expect(guardCode('FINAL_WITH_TOOL')).toBe('MIXED_TERMINAL_ACTION');
    expect(guardCode('MULTIPLE_SUBMIT')).toBe('MIXED_TERMINAL_ACTION');
    expect(guardCode('TOOL_FINISH_WITHOUT_TOOL')).toBe('NO_TERMINAL_ACTION');
    expect(guardCode('UNSUPPORTED_PART')).toBe('RUNTIME_FAILED');
    expect(guardCode('FINISH_COUNT')).toBe('RUNTIME_FAILED');
  });

  it('keeps a guard cancellation and a stale guard denial on their own statuses', () => {
    expect(
      threadRuntimeResultFromNative(
        nativeError('', { runtimeGuardFailureCode: 'MODEL_STREAM_ABORTED' }),
        () => false,
      ),
    ).toMatchObject({ status: 'cancelled', code: 'CANCELLED' });
    expect(
      threadRuntimeResultFromNative(
        nativeError('', { runtimeGuardFailureCode: 'STALE_TURN' }),
        () => false,
      ),
    ).toMatchObject({ status: 'stale', code: 'STALE_TURN' });
  });

  it('reports a completed turn without cards or a message as a terminal action gap', () => {
    expect(threadRuntimeResultFromNative(nativeCompleted(null), () => false)).toEqual({
      status: 'failed',
      requestId: 'native-result-request',
      response: null,
      code: 'NO_TERMINAL_ACTION',
    });
  });

  it('prefers the stale code when the turn lost its revision before committing', () => {
    expect(threadRuntimeResultFromNative(nativeCompleted(null), () => true)).toMatchObject({
      status: 'stale',
      code: 'STALE_TURN',
    });
  });

  it('keeps an unusable response body separate from a missing terminal action', () => {
    expect(
      threadRuntimeResultFromNative(nativeCompleted({ kind: 'not-a-response' }), () => false),
    ).toMatchObject({
      status: 'failed',
      code: 'RUNTIME_FAILED',
      response: null,
    });
  });
});
