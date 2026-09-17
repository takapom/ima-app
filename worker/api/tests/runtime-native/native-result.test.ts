import { describe, expect, it } from 'vitest';
import type { RuntimeThinkTurnResult } from '@api/runtime/turn-execution/runtime-think-connection';
import { threadRuntimeResultFromNative } from '@api/thread-runtime/native-result';

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
      code: 'RUNTIME_FAILED',
      response: null,
    });
  });
});
