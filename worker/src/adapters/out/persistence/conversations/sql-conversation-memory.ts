import * as v from 'valibot';
import {
  ConversationMemorySchema,
  type ConversationMemory,
} from '@worker/application/model-context/conversation-memory';
import type { ConversationMemoryStore } from '@worker/application/ports/conversation-memory-store';
import { ConversationMessageSchema } from '@worker/domain/conversations/conversation-message';
import type { SqlConversationRecords } from '@worker/adapters/out/persistence/conversations/sql-conversation-records';
import { storeFailure } from '@worker/adapters/out/persistence/conversations/conversation-sql-schema';

const bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** Bounded extractive summary of user-authored text. No provider facts are promoted or retained. */
export class SqlConversationMemory {
  constructor(private readonly records: SqlConversationRecords) {}
  loadMemory(
    input: Parameters<ConversationMemoryStore['loadMemory']>[0],
  ): Awaited<ReturnType<ConversationMemoryStore['loadMemory']>> {
    return this.records.storage.transactionSync(() => {
      const page = this.records.messages({ ...input, limit: 32 });
      if (!page.ok) return page;
      const entries: ConversationMemory['entries'] = [];
      let recentBytes = 0;
      for (const record of [...page.messages].reverse()) {
        const textParts = record.message.parts.filter(
          (part) => part.kind === 'user_text' || part.kind === 'retained_text',
        );
        const text = textParts
          .map((part) => part.text)
          .join('\n')
          .slice(0, 500);
        const deadlines = textParts.flatMap((part) =>
          part.kind === 'retained_text'
            ? [
                part.retention.sessionExpiresAt,
                part.retention.displayUntil,
                part.retention.retentionUntil,
                part.retention.deletionScheduledAt,
              ]
                .filter((value) => value !== null)
                .map(Date.parse)
            : [],
        );
        if (text.length === 0) continue;
        const entry = {
          messageId: record.message.messageId,
          sequence: record.sequence,
          role: record.message.role,
          text,
          sourceThreadId: record.message.source?.threadId ?? null,
          expiresAt: deadlines.length === 0 ? null : new Date(Math.min(...deadlines)).toISOString(),
        };
        if (recentBytes + bytes(entry) > 8_000) break;
        recentBytes += bytes(entry);
        entries.unshift(entry);
      }
      const before = entries[0]?.sequence ?? input.beforeSequence;
      const sql = this.records.storage.sql;
      const columns =
        "SELECT body FROM conversation_messages WHERE owner = ? AND conversation_id = ? AND sequence < ? AND json_extract(body, '$.message.role') = 'user'";
      const first = sql
        .exec<{ body: string }>(
          `${columns} ORDER BY sequence ASC LIMIT 4`,
          input.ownerScopeRef,
          input.conversationId,
          before,
        )
        .toArray();
      const last = sql
        .exec<{ body: string }>(
          `${columns} ORDER BY sequence DESC LIMIT 4`,
          input.ownerScopeRef,
          input.conversationId,
          before,
        )
        .toArray();
      const sources = new Map(
        [...first, ...last].map((row) => {
          const source = v.parse(ConversationMessageSchema, JSON.parse(row.body));
          return [source.sequence, source] as const;
        }),
      );
      const excerpts: NonNullable<ConversationMemory['summary']>['excerpts'] = [];
      let summaryBytes = 0;
      for (const source of [...sources.values()].sort((a, b) => a.sequence - b.sequence)) {
        const part = source.message.parts[0];
        if (part?.kind !== 'user_text') continue;
        const excerpt = {
          messageId: source.message.messageId,
          sequence: source.sequence,
          text: Array.from(part.text).slice(0, 160).join(''),
        };
        if (summaryBytes + bytes(excerpt) > 4_000) break;
        summaryBytes += bytes(excerpt);
        excerpts.push(excerpt);
      }
      const summary: ConversationMemory['summary'] =
        excerpts.length === 0
          ? null
          : { version: 'extractive_v1', throughSequence: before - 1, excerpts };
      const parsed = v.safeParse(ConversationMemorySchema, {
        ownerScopeRef: input.ownerScopeRef,
        conversationId: input.conversationId,
        beforeSequence: input.beforeSequence,
        entries,
        summary,
      });
      if (!parsed.success) return storeFailure('INVALID_INPUT');
      sql.exec(
        'INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?)',
        input.ownerScopeRef,
        input.conversationId,
        before - 1,
        JSON.stringify(summary),
      );
      return { ok: true, memory: parsed.output };
    });
  }
}
