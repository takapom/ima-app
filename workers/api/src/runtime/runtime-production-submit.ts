import type {
  CancellationToken,
  SubmitCardsPort,
  SubmitCardsPortResult,
  ToolExecutionContext,
} from '@ima/core';

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
