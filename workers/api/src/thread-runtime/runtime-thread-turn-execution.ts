import type { ThreadTurnRequest } from '@ima/contracts';
import type {
  ThreadRuntimeTurnInput,
  ThreadRuntimeTarget,
  ThreadRuntimeTurnResult,
} from './admission';
import { threadRuntimeResultFromNative } from './native-result';
import type {
  RuntimeThinkTurnRequest,
  RuntimeThinkTurnResult,
} from '../runtime/runtime-think-connection';

type RuntimeTurnExecutionInput = {
  readonly input: ThreadRuntimeTurnInput;
  readonly target: ThreadRuntimeTarget;
  readonly isStale: () => boolean;
  readonly run: (request: RuntimeThinkTurnRequest) => Promise<RuntimeThinkTurnResult<unknown>>;
};

/** Builds the SDK request at the ThreadDO boundary and converts its result once. */
export const executeRuntimeThreadTurn = async (
  input: RuntimeTurnExecutionInput,
): Promise<ThreadRuntimeTurnResult> => {
  const request: RuntimeThinkTurnRequest & { readonly runtimeInput: ThreadTurnRequest } = {
    ownerScopeRef: input.target.ownerScopeRef,
    threadId: input.target.threadId,
    turnId: input.target.turnId,
    revision: input.target.revision,
    ...(input.input.deviceId === undefined ? {} : { deviceId: input.input.deviceId }),
    messages: [
      {
        id: input.input.input.requestId,
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: input.input.input.text }],
      },
    ],
    runtimeInput: input.input.input,
    isStale: input.isStale,
  };
  const nativeResult = await input.run(request);
  return threadRuntimeResultFromNative(nativeResult, input.isStale);
};
