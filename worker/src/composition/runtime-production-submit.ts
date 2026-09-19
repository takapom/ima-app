import type { CancellationToken, ToolExecutionContext } from '@worker/application/ports/context';
import type { SubmitCardsPort, SubmitCardsPortResult } from '@worker/application/ports/submission';

/** Submit is replaced by the Core application port once a composition is assembled. */
export const unavailableSubmit = (): SubmitCardsPort => ({
  submit: (
    _input: Parameters<SubmitCardsPort['submit']>[0],
    _execution: ToolExecutionContext,
    _cancellation: CancellationToken,
  ): Promise<SubmitCardsPortResult> =>
    Promise.resolve({
      status: 'invalid',
      issues: [
        {
          code: 'MISSING_EVIDENCE',
          path: 'submit',
          message: 'submit adapter is not available before composition wiring',
          missingFields: [],
        },
      ],
      repairable: false,
      remainingRepairs: 0,
    }),
});
