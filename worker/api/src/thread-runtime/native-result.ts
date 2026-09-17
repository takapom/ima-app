import * as v from 'valibot';
import { AssistantResponseSchema } from '@ima/contracts';
import type { RuntimeThinkTurnResult as NativeRuntimeTurnResult } from '../runtime/turn-execution/runtime-think-connection';
import { runtimeFailure, type ThreadRuntimeTurnResult } from './admission';

/** Converts the private Think result into the public DO result at one boundary. */
export const threadRuntimeResultFromNative = (
  nativeResult: NativeRuntimeTurnResult<unknown>,
  isStale: () => boolean,
): ThreadRuntimeTurnResult => {
  if (nativeResult.status === 'completed') {
    const parsed = v.safeParse(AssistantResponseSchema, nativeResult.response);
    if (!parsed.success) return runtimeFailure('RUNTIME_FAILED', nativeResult.requestId);
    return {
      status: 'completed',
      requestId: nativeResult.requestId,
      response: parsed.output,
    };
  }
  if (nativeResult.status === 'aborted') {
    const stale = isStale();
    return {
      status: stale ? 'stale' : 'cancelled',
      requestId: nativeResult.requestId,
      response: null,
      code: stale ? 'STALE_TURN' : 'CANCELLED',
    };
  }
  if (nativeResult.status === 'skipped') {
    return {
      status: 'stale',
      requestId: nativeResult.requestId,
      response: null,
      code: 'STALE_TURN',
    };
  }
  if (nativeResult.status === 'error') {
    /* SaveMessagesResult.error is provider-controlled text; never rethrow it. */
    return runtimeFailure('RUNTIME_FAILED', nativeResult.requestId);
  }
  throw new Error('runtime Think turn returned an unknown status');
};
