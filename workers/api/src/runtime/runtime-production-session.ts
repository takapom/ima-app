import type { Session } from '@cloudflare/think';
import { sanitizeRuntimeCompactionSummary } from './runtime-retention';

/** Keeps SDK compaction metadata reference-only at the production boundary. */
export const configureRuntimeProductionSession = (session: Session): Session =>
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
