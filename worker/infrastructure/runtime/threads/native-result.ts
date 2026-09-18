import * as v from 'valibot';
import { AssistantResponseSchema } from '@ima/contracts';
import type { RuntimeModelGuardErrorCode } from '@worker/infrastructure/runtime/turn-execution/runtime-model-guard';
import type { RuntimeThinkTurnResult as NativeRuntimeTurnResult } from '@worker/infrastructure/runtime/turn-execution/runtime-think-connection';
import {
  runtimeFailure,
  type ThreadRuntimeFailureCode,
  type ThreadRuntimeTurnResult,
} from '@worker/infrastructure/runtime/threads/admission';

/**
 * Classifies a denied model step into the fixed boundary vocabulary. The guard code itself stays
 * internal; only this mapping crosses. A `Record` keeps the mapping exhaustive, so a new guard
 * code cannot reach the boundary as an unclassified failure.
 */
const GUARD_FAILURE_CODES: Record<RuntimeModelGuardErrorCode, ThreadRuntimeFailureCode> = {
  CANCELLED: 'CANCELLED',
  MODEL_STREAM_ABORTED: 'CANCELLED',
  STALE_TURN: 'STALE_TURN',
  DEADLINE: 'MODEL_TIMEOUT',
  MODEL_STREAM_TIMEOUT: 'MODEL_TIMEOUT',
  FINAL_RESERVE: 'BUDGET_EXCEEDED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  PARALLEL_LIMIT: 'BUDGET_EXCEEDED',
  RETRY_NOT_ALLOWED: 'BUDGET_EXCEEDED',
  MODEL_STREAM_LIMIT: 'BUDGET_EXCEEDED',
  FINAL_WITH_TOOL: 'MIXED_TERMINAL_ACTION',
  MIXED_TERMINAL_ACTION: 'MIXED_TERMINAL_ACTION',
  MULTIPLE_SUBMIT: 'MIXED_TERMINAL_ACTION',
  TOOL_FINISH_WITHOUT_TOOL: 'NO_TERMINAL_ACTION',
  COMMITTED: 'RUNTIME_FAILED',
  UNKNOWN_TOOL: 'RUNTIME_FAILED',
  UNSUPPORTED_PART: 'RUNTIME_FAILED',
  FINISH_COUNT: 'RUNTIME_FAILED',
};

const failureForGuardCode = (
  code: RuntimeModelGuardErrorCode | undefined,
): ThreadRuntimeFailureCode => (code === undefined ? 'RUNTIME_FAILED' : GUARD_FAILURE_CODES[code]);

/** Converts the private Think result into the public DO result at one boundary. */
export const threadRuntimeResultFromNative = (
  nativeResult: NativeRuntimeTurnResult<unknown>,
  isStale: () => boolean,
): ThreadRuntimeTurnResult => {
  if (nativeResult.status === 'completed') {
    // The turn ran to completion but committed neither cards nor a final message. That is a
    // distinct situation from an upstream failure, so it keeps its own code.
    if (nativeResult.response === null || nativeResult.response === undefined) {
      return runtimeFailure(
        isStale() ? 'STALE_TURN' : 'NO_TERMINAL_ACTION',
        nativeResult.requestId,
      );
    }
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
    /* SaveMessagesResult.error is provider-controlled text; never rethrow it. The typed guard
       code is the only classification that crosses this boundary. */
    return runtimeFailure(
      failureForGuardCode(nativeResult.runtimeGuardFailureCode),
      nativeResult.requestId,
    );
  }
  throw new Error('runtime Think turn returned an unknown status');
};
