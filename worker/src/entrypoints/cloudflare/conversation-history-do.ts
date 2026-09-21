import { ConversationDeletions } from '@worker/adapters/out/persistence/conversations/conversation-deletions';
import { conversationResponseDeadline } from '@worker/runtime/conversations/conversation-response-deadline';
import { SqlConversationMemory } from '@worker/adapters/out/persistence/conversations/sql-conversation-memory';
import type { ConversationMemoryStore } from '@worker/application/ports/conversation-memory-store';
import { ConversationRunSchema } from '@worker/domain/conversations/conversation-run';
import {
  ConversationTurnRequestSchema,
  type AssistantResponse,
  type ConversationTurnRequest,
} from '@ima/contracts';
import type { ConversationRunScope } from '@worker/application/ports/conversation-runs';
import {
  ConversationExecution,
  conversationFingerprint,
  type ConversationThreadNamespace,
} from '@worker/runtime/conversations/conversation-execution';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { OpaqueIdSchema } from '@worker/domain/primitives';
import type { ConversationStore } from '@worker/application/ports/conversation-store';
import type { ConversationRuns } from '@worker/application/ports/conversation-runs';
import { SqlConversationRecords } from '@worker/adapters/out/persistence/conversations/sql-conversation-records';
import { SqlConversationRuns } from '@worker/adapters/out/persistence/conversations/sql-conversation-runs';
import { storeFailure } from '@worker/adapters/out/persistence/conversations/conversation-sql-schema';

type StoreInput<K extends keyof ConversationStore> = Parameters<ConversationStore[K]>[0];
type RunInput<K extends keyof ConversationRuns> = Parameters<ConversationRuns[K]>[0];

/** Owner-scoped long-lived history. ThreadDO continues to own bounded model execution. */
export class ConversationHistoryDO extends DurableObject<
  Cloudflare.Env & { THREADS: ConversationThreadNamespace }
> {
  private readonly records: SqlConversationRecords;
  private readonly runs: SqlConversationRuns;
  private readonly execution: ConversationExecution;
  private readonly deletions: ConversationDeletions;
  private readonly responses = new Map<
    string,
    { response: AssistantResponse; expiresAt: number; conversationId: string }
  >();
  constructor(
    ctx: DurableObjectState,
    env: Cloudflare.Env & { THREADS: ConversationThreadNamespace },
  ) {
    super(ctx, env);
    this.records = new SqlConversationRecords(ctx.storage);
    this.runs = new SqlConversationRuns(this.records);
    this.deletions = new ConversationDeletions(this.records, env.THREADS);
    this.execution = new ConversationExecution({
      store: this,
      threads: env.THREADS,
      now: () => new Date().toISOString(),
      onFailure: (code) =>
        console.warn(JSON.stringify({ event: 'conversation_execution_failed', code })),
      onResponse: (scope, response) => {
        if (!this.records.read(scope).ok) return;
        this.responses.set(scope.runId, {
          response,
          conversationId: scope.conversationId,
          expiresAt: conversationResponseDeadline(response, Date.now()),
        });
        this.ctx.waitUntil(this.schedule());
      },
    });
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS conversation_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner TEXT NOT NULL)',
    );
  }
  private async access<T>(owner: string, work: () => T) {
    if (!v.safeParse(OpaqueIdSchema, owner).success) return storeFailure('INVALID_INPUT');
    const bound = this.ctx.storage.sql
      .exec<{ owner: string }>('SELECT owner FROM conversation_owner WHERE singleton = 1')
      .toArray()[0];
    if (bound !== undefined && bound.owner !== owner) return storeFailure('NOT_FOUND');
    if (bound === undefined)
      this.ctx.storage.sql.exec('INSERT INTO conversation_owner VALUES (1, ?)', owner);
    const result = work();
    await this.schedule();
    return result;
  }
  private async schedule(): Promise<void> {
    const expiry = this.ctx.storage.sql
      .exec<{ deadline: number | null }>(
        'SELECT MIN(expires_at) AS deadline FROM conversation_messages',
      )
      .one().deadline;
    const pending = this.runs.pending();
    const deletionDeadline = this.deletions.nextAlarm();
    const deadlines = [
      ...(deletionDeadline === null ? [] : [deletionDeadline]),
      ...(expiry === null ? [] : [expiry]),
      ...[...this.responses.values()].map((value) => value.expiresAt),
      ...pending.map(({ run }) =>
        Math.min(Date.now() + 15_000, Date.parse(run.updatedAt) + 10 * 60_000),
      ),
    ];
    if (deadlines.length > 0)
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    await this.deletions.flush();
    const now = new Date().toISOString();
    for (const [key, value] of this.responses)
      if (value.expiresAt <= Date.now()) this.responses.delete(key);
    this.records.purge(now);
    for (const { ownerScopeRef, run } of this.runs.pending()) {
      const scope = { ownerScopeRef, conversationId: run.conversationId, runId: run.runId };
      // RPC failures leave the durable pending record for the next bounded recovery attempt.
      try {
        await this.execution.reconcile(scope);
      } catch {
        if (Date.parse(now) - Date.parse(run.updatedAt) < 10 * 60_000) continue;
      }
      const latest = this.runs.readRun(scope);
      if (
        latest.ok &&
        (latest.run.status === 'accepted' || latest.run.status === 'running') &&
        Date.parse(now) - Date.parse(run.updatedAt) >= 10 * 60_000
      )
        this.runs.fail({
          ownerScopeRef,
          conversationId: run.conversationId,
          runId: run.runId,
          now,
          interrupted: true,
        });
    }
    await this.schedule();
  }
  async submit(input: {
    ownerScopeRef: string;
    conversationId: string;
    deviceId: string;
    request: ConversationTurnRequest;
  }) {
    const request = v.parse(ConversationTurnRequestSchema, input.request);
    const fingerprintFields = { ...request, requestId: 'request-id-excluded' };
    const runId = `run-${await conversationFingerprint([input.ownerScopeRef, input.conversationId, request.idempotencyKey])}`;
    const scope = {
      ownerScopeRef: input.ownerScopeRef,
      conversationId: input.conversationId,
      runId,
    };
    const accepted = await this.accept({
      ...scope,
      messageId: request.clientMessageId,
      text: request.text,
      now: new Date().toISOString(),
      expectedRevision: request.expectedRevision,
      idempotencyKey: request.idempotencyKey,
      inputFingerprint: await conversationFingerprint(fingerprintFields),
    });
    if (!accepted.ok || accepted.replayed) return accepted;
    const previous = this.ctx.storage.sql
      .exec<{ body: string }>(
        "SELECT body FROM conversation_runs WHERE owner = ? AND conversation_id = ? AND json_extract(body, '$.threadId') IS NOT NULL ORDER BY json_extract(body, '$.inputSequence') DESC LIMIT 1",
        input.ownerScopeRef,
        input.conversationId,
      )
      .toArray()[0];
    const previousThreadId =
      previous === undefined
        ? null
        : v.parse(ConversationRunSchema, JSON.parse(previous.body)).threadId;
    this.ctx.waitUntil(
      this.execution
        .execute({ scope, request, deviceId: input.deviceId, previousThreadId })
        .catch(async () => {
          // Execution outcome may be unknown. The alarm reconciles it without generating again.
          await this.schedule();
        }),
    );
    return accepted;
  }
  async getRun(scope: ConversationRunScope) {
    const initial = await this.readRun(scope);
    if (!initial.ok) return initial;
    const result =
      initial.run.status === 'running' ? await this.execution.reconcile(scope) : initial;
    const cached = this.responses.get(scope.runId);
    if (cached !== undefined && cached.expiresAt <= Date.now()) this.responses.delete(scope.runId);
    return {
      ...result,
      response:
        result.ok && result.run.status === 'completed'
          ? (this.responses.get(scope.runId)?.response ?? null)
          : null,
    };
  }
  cancelRun(scope: ConversationRunScope) {
    return this.execution.cancel(scope);
  }
  loadMemory(input: Parameters<ConversationMemoryStore['loadMemory']>[0]) {
    return this.access(input.ownerScopeRef, () =>
      new SqlConversationMemory(this.records).loadMemory(input),
    );
  }
  create(input: StoreInput<'create'>) {
    return this.access(input.ownerScopeRef, () => this.records.create(input));
  }
  read(input: StoreInput<'read'>) {
    return this.access(input.ownerScopeRef, () => this.records.read(input));
  }
  list(input: StoreInput<'list'>) {
    return this.access(input.ownerScopeRef, () => this.records.list(input));
  }
  append(input: StoreInput<'append'>) {
    return this.access(input.ownerScopeRef, () => this.records.append(input));
  }
  messages(input: StoreInput<'messages'>) {
    return this.access(input.ownerScopeRef, () => this.records.messages(input));
  }
  async remove(input: StoreInput<'remove'>) {
    const result = await this.access(input.ownerScopeRef, () => this.deletions.mark(input));
    if (result.ok) {
      for (const [key, value] of this.responses)
        if (value.conversationId === input.conversationId) this.responses.delete(key);
      await this.deletions.flush();
      await this.schedule();
    }
    return result;
  }
  accept(input: RunInput<'accept'>) {
    return this.access(input.ownerScopeRef, () => this.runs.accept(input));
  }
  readRun(input: RunInput<'readRun'>) {
    return this.access(input.ownerScopeRef, () => this.runs.readRun(input));
  }
  start(input: RunInput<'start'>) {
    return this.access(input.ownerScopeRef, () => this.runs.start(input));
  }
  complete(input: RunInput<'complete'>) {
    return this.access(input.ownerScopeRef, () => this.runs.complete(input));
  }
  fail(input: RunInput<'fail'>) {
    return this.access(input.ownerScopeRef, () => this.runs.fail(input));
  }
  async activeRun(input: RunInput<'activeRun'>) {
    const result = await this.access(input.ownerScopeRef, () => this.runs.activeRun(input));
    if (result !== null && 'ok' in result) throw new Error('CONVERSATION_SCOPE_REJECTED');
    return result;
  }
}
