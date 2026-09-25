import type { ConversationTurnRequest } from '@ima/contracts';
import type { ConversationRunScope } from '@worker/application/ports/conversation-runs';
import type { ConversationTurnExecutor } from '@worker/application/ports/conversation-execution';
import type { ConversationExecutionApplication } from '@worker/application/use-cases/conversations/conversation-execution';
export type PreparedConversationExecution = {
  readonly run: ConversationTurnExecutor;
  /** Validates and publishes the ephemeral DTO only after the application confirms completion. */
  readonly publish: () => void;
};
export class ConversationExecution {
  constructor(
    private readonly options: {
      readonly application: ConversationExecutionApplication;
      readonly prepare: (
        scope: ConversationRunScope,
        request: ConversationTurnRequest,
        deviceId: string,
      ) => PreparedConversationExecution;
    },
  ) {}
  reconcile(scope: ConversationRunScope) {
    return this.options.application.reconcile(scope);
  }
  cancel(scope: ConversationRunScope) {
    return this.options.application.cancel(scope);
  }
  async execute(input: {
    readonly scope: ConversationRunScope;
    readonly request: ConversationTurnRequest;
    readonly deviceId: string;
    readonly previousThreadId: string | null;
  }): Promise<void> {
    const prepared = this.options.prepare(input.scope, input.request, input.deviceId);
    const completed = await this.options.application.execute(
      {
        scope: input.scope,
        previousThreadId: input.previousThreadId,
        expectedRevision: input.request.expectedRevision,
        clientMessageId: input.request.clientMessageId,
      },
      prepared.run,
    );
    if (completed?.ok && completed.run.status === 'completed') prepared.publish();
  }
}
