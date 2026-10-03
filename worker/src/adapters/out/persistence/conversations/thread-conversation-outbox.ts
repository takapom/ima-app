import { messageDeadline } from '@worker/adapters/out/persistence/conversations/sql-conversation-records';
import type { ConversationPhotoSource } from '@worker/domain/conversations/conversation-cards';
import * as v from 'valibot';
import type { AssistantResponse } from '@ima/contracts';
import type { CommitRequest } from '@worker/application/ports/commit';
import { conversationResponseDeadline } from '@worker/runtime/conversations/conversation-response-deadline';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnResult,
} from '@worker/runtime/threads/admission';
import {
  ConversationDeliveryScopeSchema,
  messageFromConversationResponse,
  type BoundConversationTurn,
  type ConversationDelivery,
  type ConversationDeliveryScope,
} from '@worker/runtime/conversations/conversation-delivery';
import {
  ConversationMessageInputSchema,
  retainConversationPart,
} from '@worker/domain/conversations/conversation-message';

/** Written inside the reference commit transaction; only retention-approved message parts persist. */
export class ThreadConversationOutbox {
  private readonly live = new Map<string, { response: AssistantResponse; expiresAt: number }>();
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS conversation_delivery (run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, revision INTEGER NOT NULL, message TEXT, fingerprint TEXT)',
    );
  }
  bind(input: BoundConversationTurn): void {
    v.parse(ConversationDeliveryScopeSchema, {
      ownerScopeRef: input.ownerScopeRef,
      conversationId: input.conversationId,
      runId: input.runId,
    });
    const prior = this.storage.sql
      .exec<{
        owner: string;
        conversation_id: string;
        thread_id: string;
        turn_id: string;
        revision: number;
      }>('SELECT * FROM conversation_delivery WHERE run_id = ?', input.runId)
      .toArray()[0];
    if (prior !== undefined) {
      if (
        prior.owner !== input.ownerScopeRef ||
        prior.conversation_id !== input.conversationId ||
        prior.thread_id !== input.target.threadId ||
        prior.turn_id !== input.target.turnId ||
        prior.revision !== input.target.revision
      )
        throw new Error('CONVERSATION_DELIVERY_CONFLICT');
      return;
    }
    this.storage.sql.exec(
      'INSERT INTO conversation_delivery VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
      input.runId,
      input.ownerScopeRef,
      input.conversationId,
      input.target.threadId,
      input.target.turnId,
      input.target.revision,
    );
  }
  commit(
    request: CommitRequest,
    response: AssistantResponse | undefined,
    now: string,
    sources?: readonly ConversationPhotoSource[],
  ): void {
    const { record } = request;
    const row = this.storage.sql
      .exec<{ run_id: string }>(
        'SELECT run_id FROM conversation_delivery WHERE owner = ? AND thread_id = ? AND turn_id = ? AND revision = ?',
        record.scope.ownerScopeRef,
        record.scope.threadId,
        record.turnId,
        request.expectedRevision,
      )
      .toArray()[0];
    if (row === undefined) return;
    if (
      response === undefined ||
      response.threadId !== record.scope.threadId ||
      response.turnId !== record.turnId ||
      response.responseId !== record.responseId ||
      response.revision !== record.revision ||
      response.presentation !== record.presentation
    )
      throw new Error('CONVERSATION_COMMIT_RESPONSE_MISSING');
    const message = messageFromConversationResponse(response, `answer-${row.run_id}`, now, sources);
    this.storage.sql.exec(
      'UPDATE conversation_delivery SET message = ? WHERE run_id = ? AND message IS NULL',
      JSON.stringify(message),
      row.run_id,
    );
  }
  completed(target: ThreadRuntimeTarget, result: ThreadRuntimeTurnResult, now: string): void {
    const row = this.storage.sql
      .exec<{ run_id: string }>(
        'SELECT run_id FROM conversation_delivery WHERE owner = ? AND thread_id = ? AND turn_id = ? AND revision = ? AND message IS NOT NULL',
        target.ownerScopeRef,
        target.threadId,
        target.turnId,
        target.revision,
      )
      .toArray()[0];
    if (row === undefined || result.response === null || 'restoreMode' in result.response) return;
    this.live.set(row.run_id, {
      response: result.response,
      expiresAt: conversationResponseDeadline(result.response, Date.parse(now)),
    });
  }
  async read(scope: ConversationDeliveryScope, now: string): Promise<ConversationDelivery | null> {
    const row = this.storage.sql
      .exec<{ message: string | null; fingerprint: string | null }>(
        'SELECT message, fingerprint FROM conversation_delivery WHERE owner = ? AND conversation_id = ? AND run_id = ?',
        scope.ownerScopeRef,
        scope.conversationId,
        scope.runId,
      )
      .toArray()[0];
    if (row?.message === undefined || row.message === null) return null;
    const message = v.parse(ConversationMessageInputSchema, JSON.parse(row.message));
    const digest =
      row.fingerprint === null
        ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.message))
        : null;
    const fingerprint =
      row.fingerprint ??
      [...new Uint8Array(digest ?? new ArrayBuffer(0))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    if (
      this.storage.sql
        .exec('SELECT run_id FROM conversation_delivery WHERE run_id = ?', scope.runId)
        .toArray().length === 0
    )
      return null;
    const retained = {
      ...message,
      parts: message.parts.map((part) => retainConversationPart(part, now)),
    };
    this.storage.sql.exec(
      'UPDATE conversation_delivery SET message = ?, fingerprint = ? WHERE run_id = ?',
      JSON.stringify(retained),
      fingerprint,
      scope.runId,
    );
    const live = this.live.get(scope.runId);
    if (live !== undefined && live.expiresAt <= Date.parse(now)) this.live.delete(scope.runId);
    return {
      ...scope,
      message: retained,
      inputFingerprint: fingerprint,
      ...(live !== undefined && live.expiresAt > Date.parse(now)
        ? { response: live.response }
        : {}),
    };
  }
  acknowledge(scope: ConversationDeliveryScope): void {
    this.live.delete(scope.runId);
    this.storage.sql.exec(
      'DELETE FROM conversation_delivery WHERE owner = ? AND conversation_id = ? AND run_id = ?',
      scope.ownerScopeRef,
      scope.conversationId,
      scope.runId,
    );
  }
  nextAlarm(): number | null {
    const deadlines = this.storage.sql
      .exec<{ message: string }>(
        'SELECT message FROM conversation_delivery WHERE message IS NOT NULL',
      )
      .toArray()
      .map((row) =>
        messageDeadline({
          message: v.parse(ConversationMessageInputSchema, JSON.parse(row.message)),
        }),
      )
      .filter((deadline): deadline is number => deadline !== null);
    deadlines.push(...[...this.live.values()].map((item) => item.expiresAt));
    return deadlines.length === 0 ? null : Math.max(Date.now() + 1, Math.min(...deadlines));
  }
  async purge(now: string, sessionExpired = false): Promise<void> {
    this.storage.sql.exec(
      `DELETE FROM conversation_delivery WHERE message IS NULL AND (? = 1 OR EXISTS (
        SELECT 1 FROM runtime_turn WHERE owner_scope_ref = conversation_delivery.owner
        AND thread_id = conversation_delivery.thread_id AND turn_id = conversation_delivery.turn_id
        AND revision = conversation_delivery.revision AND status IN ('failed', 'cancelled', 'stale')
      ))`,
      sessionExpired ? 1 : 0,
    );
    for (const [id, item] of this.live) if (item.expiresAt <= Date.parse(now)) this.live.delete(id);
    for (const row of this.storage.sql
      .exec<{ owner: string; conversation_id: string; run_id: string }>(
        'SELECT owner, conversation_id, run_id FROM conversation_delivery WHERE message IS NOT NULL',
      )
      .toArray())
      await this.read(
        { ownerScopeRef: row.owner, conversationId: row.conversation_id, runId: row.run_id },
        now,
      );
  }
  clear(): void {
    this.live.clear();
    this.storage.sql.exec('DELETE FROM conversation_delivery');
  }
}
