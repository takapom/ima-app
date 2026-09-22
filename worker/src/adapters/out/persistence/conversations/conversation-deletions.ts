import type { ConversationScope } from '@worker/application/ports/conversation-store';
import type { ConversationThreadNamespace } from '@worker/runtime/conversations/conversation-execution';
import { ConversationScopeSchema } from '@worker/adapters/out/persistence/conversations/conversation-store-input';
import * as v from 'valibot';
import type { SqlConversationRecords } from '@worker/adapters/out/persistence/conversations/sql-conversation-records';
import { storeFailure } from '@worker/adapters/out/persistence/conversations/conversation-sql-schema';

/** A content-free deletion queue survives transport failure after the conversation is tombstoned. */
export class ConversationDeletions {
  constructor(
    private readonly records: SqlConversationRecords,
    private readonly threads: ConversationThreadNamespace,
  ) {
    records.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS conversation_deletions (owner TEXT NOT NULL, conversation_id TEXT NOT NULL, thread_id TEXT NOT NULL, retry_at REAL NOT NULL, PRIMARY KEY(owner, conversation_id, thread_id))',
    );
  }
  mark(scope: ConversationScope) {
    if (!v.safeParse(ConversationScopeSchema, scope).success) return storeFailure('INVALID_INPUT');
    return this.records.storage.transactionSync(() => {
      const rows = this.records.storage.sql
        .exec<{ thread_id: string }>(
          "SELECT DISTINCT json_extract(body, '$.threadId') AS thread_id FROM conversation_runs WHERE owner = ? AND conversation_id = ? AND json_extract(body, '$.threadId') IS NOT NULL",
          scope.ownerScopeRef,
          scope.conversationId,
        )
        .toArray();
      for (const row of rows)
        this.records.storage.sql.exec(
          'INSERT OR IGNORE INTO conversation_deletions VALUES (?, ?, ?, ?)',
          scope.ownerScopeRef,
          scope.conversationId,
          row.thread_id,
          Date.now(),
        );
      return this.records.remove(scope);
    });
  }
  nextAlarm(): number | null {
    return this.records.storage.sql
      .exec<{ deadline: number | null }>(
        'SELECT MIN(retry_at) AS deadline FROM conversation_deletions',
      )
      .one().deadline;
  }
  async flush(): Promise<void> {
    const sql = this.records.storage.sql;
    const rows = sql
      .exec<{ owner: string; conversation_id: string; thread_id: string }>(
        'SELECT owner, conversation_id, thread_id FROM conversation_deletions WHERE retry_at <= ? LIMIT 20',
        Date.now(),
      )
      .toArray();
    for (const row of rows) {
      let deleted = false;
      try {
        const thread = this.threads.getByName(row.thread_id);
        // A read returning NOT_FOUND can mean cleanup failed after the deletion mark.
        // Retry the idempotent delete itself; only its success confirms cleanup.
        deleted = (
          await thread.deleteThread(
            row.owner,
            null,
            null,
            `conversation-delete-${row.conversation_id}`,
          )
        ).ok;
      } catch {
        /* Keep the queue row and retry time; metadata never makes this a successful purge. */
      }
      if (deleted)
        sql.exec(
          'DELETE FROM conversation_deletions WHERE owner = ? AND conversation_id = ? AND thread_id = ?',
          row.owner,
          row.conversation_id,
          row.thread_id,
        );
      else
        sql.exec(
          'UPDATE conversation_deletions SET retry_at = ? WHERE owner = ? AND conversation_id = ? AND thread_id = ?',
          Date.now() + 15_000,
          row.owner,
          row.conversation_id,
          row.thread_id,
        );
    }
  }
}
