import type { Session } from '@cloudflare/think';
import { sanitizeRuntimeCompactionSummary } from '@worker/infrastructure/runtime/retention/runtime-retention';

/** Compaction never receives a provider summary as a model or persistence grant. */
export const configureRuntimeCompaction = (session: Session): Session =>
  session.onCompaction((messages) => {
    const first = messages[0];
    const last = messages[messages.length - 1];
    if (first === undefined || last === undefined) return Promise.resolve(null);
    return Promise.resolve({
      fromMessageId: first.id,
      toMessageId: last.id,
      summary: sanitizeRuntimeCompactionSummary(undefined),
    });
  });
