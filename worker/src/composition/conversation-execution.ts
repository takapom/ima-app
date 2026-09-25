import type { ConversationRuns } from '@worker/application/ports/conversation-runs';
import type { ConversationMemoryStore } from '@worker/application/ports/conversation-memory-store';
import { ConversationExecutionApplication } from '@worker/application/use-cases/conversations/conversation-execution';
import {
  createConversationThreadPort,
  prepareConversationExecution,
  type ConversationExecutionObserver,
} from '@worker/adapters/out/persistence/conversations/durable-conversation-execution';
import { ConversationExecution } from '@worker/runtime/conversations/conversation-execution';
import type { ConversationThreadNamespace } from '@worker/runtime/ports/conversation-thread';
export const createConversationExecution = (
  options: ConversationExecutionObserver & {
    readonly store: ConversationRuns & ConversationMemoryStore;
    readonly threads: ConversationThreadNamespace;
    readonly now: () => string;
  },
): ConversationExecution =>
  new ConversationExecution({
    application: new ConversationExecutionApplication({
      store: options.store,
      now: options.now,
      threads: createConversationThreadPort(options.threads, options),
    }),
    prepare: (scope, request, deviceId) =>
      prepareConversationExecution(options.threads, options, scope, request, deviceId),
  });
