import type { UIMessage } from 'ai';
import type { RetentionRuntimeContext } from './retention/retention-runtime-contract';
import type { RetentionExpiryClock } from './retention/retention-fixture';
import { parseRetentionMessage, sanitizeMessageForPersistence } from '../support/retention-policy';

/** Rebuild the server-owned envelope before applying the retention decision. */
export function sanitizeRuntimeGateMessage(
  message: UIMessage,
  context: RetentionRuntimeContext | undefined,
  clock: RetentionExpiryClock,
  activeInputIds: ReadonlySet<string>,
): UIMessage {
  if (context === undefined) return message;
  const parsed = parseRetentionMessage(message);
  const serverMessage: UIMessage =
    parsed === undefined
      ? {
          id: message.id,
          role: message.role,
          parts: message.parts,
          metadata: {
            retention: context.retention,
            ownerScopeRef: context.ownerScopeRef,
            threadId: context.threadId,
            turnId: context.turnId,
          },
        }
      : message;
  const serverContext =
    parsed === undefined || activeInputIds.has(message.id)
      ? context
      : {
          ...context,
          // Existing server history retains its own thread boundary; the current
          // context is used for all messages received in this save operation.
          ownerScopeRef: parsed.metadata.ownerScopeRef,
          threadId: parsed.metadata.threadId,
        };
  return sanitizeMessageForPersistence(serverMessage, {
    clock,
    ownerScopeRef: serverContext.ownerScopeRef,
    threadId: serverContext.threadId,
  });
}
