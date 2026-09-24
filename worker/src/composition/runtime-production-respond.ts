import type { CancellationToken, ToolExecutionContext } from '@worker/application/ports/context';
import type { RespondPort, RespondPortResult } from '@worker/application/ports/submission';

/** Respond is replaced by the Core application port once a composition is assembled. */
export const unavailableRespond = (): RespondPort => ({
  respond: (
    _input: Parameters<RespondPort['respond']>[0],
    _execution: ToolExecutionContext,
    _cancellation: CancellationToken,
  ): Promise<RespondPortResult> =>
    Promise.resolve({
      status: 'invalid',
      issues: [
        {
          code: 'MISSING_EVIDENCE',
          path: 'respond',
          message: 'respond adapter is not available before composition wiring',
          missingFields: [],
        },
      ],
      repairable: false,
      remainingRepairs: 0,
    }),
});
