import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema } from '@worker/domain/primitives';
import {
  ConversationRunSchema,
  runIsPending,
  type ConversationRun,
} from '@worker/domain/conversations/conversation-run';
import { ConversationMessageInputSchema } from '@worker/domain/conversations/conversation-message';
import type {
  ConversationRuns,
  ConversationRunResult,
  ConversationRunScope,
} from '@worker/application/ports/conversation-runs';
import type { ConversationScope } from '@worker/application/ports/conversation-store';
import type { SqlConversationRecords } from '@worker/adapters/out/persistence/conversations/sql-conversation-records';
import {
  storeFailure,
  type JsonRow,
} from '@worker/adapters/out/persistence/conversations/conversation-sql-schema';

type Input<K extends keyof ConversationRuns> = Parameters<ConversationRuns[K]>[0];
export class SqlConversationRuns {
  constructor(readonly records: SqlConversationRecords) {}
  private get sql() {
    return this.records.storage.sql;
  }
  readRun(scope: ConversationRunScope): ConversationRunResult {
    const current = this.records.read(scope);
    if (!current.ok) return current;
    const row = this.sql
      .exec<JsonRow>(
        'SELECT body FROM conversation_runs WHERE owner = ? AND conversation_id = ? AND id = ?',
        scope.ownerScopeRef,
        scope.conversationId,
        scope.runId,
      )
      .toArray()[0];
    return row === undefined
      ? storeFailure('NOT_FOUND')
      : { ...current, run: v.parse(ConversationRunSchema, JSON.parse(row.body)), replayed: true };
  }
  activeRun(scope: ConversationScope): ConversationRun | null {
    const row = this.sql
      .exec<JsonRow>(
        'SELECT body FROM conversation_runs WHERE owner = ? AND conversation_id = ? AND pending = 1',
        scope.ownerScopeRef,
        scope.conversationId,
      )
      .toArray()[0];
    return row === undefined ? null : v.parse(ConversationRunSchema, JSON.parse(row.body));
  }
  accept(input: Input<'accept'>): ConversationRunResult {
    if (!v.safeParse(OpaqueIdSchema, input.runId).success) return storeFailure('INVALID_INPUT');
    return this.records.storage.transactionSync(() => {
      const current = this.records.read(input);
      if (!current.ok) return current;
      const prior = this.sql
        .exec<{ id: string; fingerprint: string }>(
          'SELECT id, fingerprint FROM conversation_runs WHERE owner = ? AND conversation_id = ? AND key = ?',
          input.ownerScopeRef,
          input.conversationId,
          input.idempotencyKey,
        )
        .toArray()[0];
      if (prior !== undefined)
        return prior.fingerprint !== input.inputFingerprint || prior.id !== input.runId
          ? storeFailure('IDEMPOTENCY_CONFLICT')
          : this.readRun({ ...input, runId: prior.id });
      if (this.activeRun(input) !== null) return storeFailure('REVISION_CONFLICT');
      if (
        this.sql
          .exec(
            'SELECT id FROM conversation_runs WHERE owner = ? AND conversation_id = ? AND id = ?',
            input.ownerScopeRef,
            input.conversationId,
            input.runId,
          )
          .toArray().length > 0
      )
        return storeFailure('IDEMPOTENCY_CONFLICT');
      const result = this.records.append({
        ownerScopeRef: input.ownerScopeRef,
        conversationId: input.conversationId,
        now: input.now,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        inputFingerprint: input.inputFingerprint,
        message: {
          messageId: input.messageId,
          role: 'user',
          source: null,
          parts: [{ kind: 'user_text', text: input.text }],
        },
      });
      if (!result.ok) return result;
      const run: ConversationRun = {
        runId: input.runId,
        conversationId: input.conversationId,
        userMessageId: input.messageId,
        inputSequence: result.message.sequence,
        status: 'accepted',
        createdAt: result.message.createdAt,
        updatedAt: result.message.createdAt,
        threadId: null,
        turnId: null,
        assistantMessageId: null,
        failure: null,
      };
      this.sql.exec(
        'INSERT INTO conversation_runs VALUES (?, ?, ?, ?, ?, ?, 1)',
        input.ownerScopeRef,
        input.conversationId,
        input.runId,
        input.idempotencyKey,
        input.inputFingerprint,
        JSON.stringify(run),
      );
      return { ok: true, conversation: result.conversation, run, replayed: false };
    });
  }
  private save(scope: ConversationScope, run: ConversationRun): void {
    this.sql.exec(
      'UPDATE conversation_runs SET body = ?, pending = ? WHERE owner = ? AND conversation_id = ? AND id = ?',
      JSON.stringify(v.parse(ConversationRunSchema, run)),
      runIsPending(run) ? 1 : 0,
      scope.ownerScopeRef,
      scope.conversationId,
      run.runId,
    );
  }
  start(input: Input<'start'>): ConversationRunResult {
    if (
      ![input.threadId, input.turnId].every((id) => v.safeParse(OpaqueIdSchema, id).success) ||
      !v.safeParse(IsoTimestampSchema, input.now).success
    )
      return storeFailure('INVALID_INPUT');
    return this.records.storage.transactionSync(() => {
      const result = this.readRun(input);
      if (!result.ok) return result;
      if (Date.parse(input.now) < Date.parse(result.run.updatedAt))
        return storeFailure('INVALID_INPUT');
      if (result.run.status !== 'accepted')
        return result.run.threadId === input.threadId && result.run.turnId === input.turnId
          ? result
          : storeFailure('REVISION_CONFLICT');
      const run: ConversationRun = {
        ...result.run,
        status: 'running',
        threadId: input.threadId,
        turnId: input.turnId,
        updatedAt: input.now,
      };
      this.save(input, run);
      return { ...result, run, replayed: false };
    });
  }
  complete(input: Input<'complete'>): ConversationRunResult {
    const parsed = v.safeParse(ConversationMessageInputSchema, input.message);
    if (
      !parsed.success ||
      parsed.output.role !== 'assistant' ||
      !/^[a-f0-9]{64}$/.test(input.inputFingerprint) ||
      !v.safeParse(IsoTimestampSchema, input.now).success
    )
      return storeFailure('INVALID_INPUT');
    return this.records.storage.transactionSync(() => {
      const result = this.readRun(input);
      if (!result.ok) return result;
      if (
        result.run.threadId !== parsed.output.source?.threadId ||
        result.run.turnId !== parsed.output.source?.turnId
      )
        return storeFailure('INVALID_INPUT');
      if (result.run.status === 'completed') {
        const prior = this.sql
          .exec<{ fingerprint: string }>(
            'SELECT fingerprint FROM conversation_operations WHERE owner = ? AND conversation_id = ? AND key = ?',
            input.ownerScopeRef,
            input.conversationId,
            `answer-${input.runId}`,
          )
          .toArray()[0];
        return result.run.assistantMessageId === parsed.output.messageId &&
          prior?.fingerprint === input.inputFingerprint
          ? result
          : storeFailure('IDEMPOTENCY_CONFLICT');
      }
      if (result.run.status !== 'running') return storeFailure('REVISION_CONFLICT');
      if (Date.parse(input.now) < Date.parse(result.run.updatedAt))
        return storeFailure('INVALID_INPUT');
      const appended = this.records.append({
        ownerScopeRef: input.ownerScopeRef,
        conversationId: input.conversationId,
        now: input.now,
        expectedRevision: result.conversation.revision,
        idempotencyKey: `answer-${input.runId}`,
        inputFingerprint: input.inputFingerprint,
        message: parsed.output,
      });
      if (!appended.ok) return appended;
      const run: ConversationRun = {
        ...result.run,
        status: 'completed',
        assistantMessageId: parsed.output.messageId,
        updatedAt: input.now,
      };
      this.save(input, run);
      return { ok: true, run, conversation: appended.conversation, replayed: false };
    });
  }
  fail(input: Input<'fail'>): ConversationRunResult {
    if (!v.safeParse(IsoTimestampSchema, input.now).success) return storeFailure('INVALID_INPUT');
    return this.records.storage.transactionSync(() => {
      const result = this.readRun(input);
      if (!result.ok || !runIsPending(result.run)) return result;
      if (Date.parse(input.now) < Date.parse(result.run.updatedAt))
        return storeFailure('INVALID_INPUT');
      const run: ConversationRun = {
        ...result.run,
        status: input.interrupted ? 'interrupted' : 'failed',
        failure: input.interrupted ? 'INTERRUPTED' : 'GENERATION_FAILED',
        updatedAt: input.now,
      };
      this.save(input, run);
      return { ...result, run, replayed: false };
    });
  }
  pending(): Array<{ ownerScopeRef: string; run: ConversationRun }> {
    return this.sql
      .exec<{ owner: string; body: string }>(
        'SELECT owner, body FROM conversation_runs WHERE pending = 1',
      )
      .toArray()
      .map((row) => ({
        ownerScopeRef: row.owner,
        run: v.parse(ConversationRunSchema, JSON.parse(row.body)),
      }));
  }
}
