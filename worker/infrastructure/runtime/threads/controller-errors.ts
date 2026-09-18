import {
  isRuntimeThinkConnectionError,
  type RuntimeThinkConnectionError,
} from '@worker/infrastructure/runtime/turn-execution/runtime-think-connection';
import {
  RuntimeProductionContextLimitError,
  RuntimeProductionDisplayContextError,
} from '@worker/infrastructure/runtime/context/runtime-production-display-context';
import {
  runtimeFailure,
  type ThreadRuntimeFailureCode,
  type ThreadRuntimeTurnResult,
} from '@worker/infrastructure/runtime/threads/admission';

const runtimeErrorCode = (error: RuntimeThinkConnectionError): ThreadRuntimeFailureCode => {
  switch (error.code) {
    case 'CANCELLED':
      return 'CANCELLED';
    case 'STALE_TURN':
      return 'STALE_TURN';
    case 'TURN_ALREADY_ACTIVE':
      return 'TURN_ALREADY_ACTIVE';
    case 'RUNTIME_UNCONFIGURED':
      return 'RUNTIME_UNCONFIGURED';
    case 'TURN_NOT_ACTIVE':
    case 'COMPOSITION_INVALID':
      return 'RUNTIME_FAILED';
    default:
      return 'RUNTIME_FAILED';
  }
};

/** Maps only known runtime boundary errors; unexpected errors remain observable to the caller. */
export const runtimeResultForError = (error: unknown): ThreadRuntimeTurnResult | undefined => {
  if (error instanceof RuntimeProductionContextLimitError) {
    return runtimeFailure(error.code);
  }
  if (error instanceof RuntimeProductionDisplayContextError) {
    return runtimeFailure(error.code);
  }
  if (!isRuntimeThinkConnectionError(error)) return undefined;
  return runtimeFailure(runtimeErrorCode(error));
};
