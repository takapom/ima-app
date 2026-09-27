import * as v from 'valibot';
import type { AssistantResponse } from '@ima/contracts';
import type { ThreadConversationOutbox } from '@worker/adapters/out/persistence/conversations/thread-conversation-outbox';
import {
  CommitRequestSchema,
  type CommitPort,
  type CommitPortResult,
  type CommitRecord,
  type CommitRequest,
} from '@worker/application/ports/commit';
import { CardSetIdSchema } from '@worker/domain/primitives';
import type { ThreadRuntimeTarget } from '@worker/runtime/threads/admission';

type ThreadStateRow = {
  readonly thread_id: string;
  readonly owner_scope_ref: string;
  readonly revision: number;
  readonly active: number;
  readonly deleted: number;
};

type RuntimeTurnRow = {
  readonly status: 'running' | 'cancel_requested' | 'cancelled' | 'stale' | 'completed' | 'failed';
};

type CommitRow = {
  readonly owner_scope_ref: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly idempotency_key: string;
  readonly response_id: string;
  readonly revision: number;
  readonly payload_digest: string;
  readonly presentation: 'keep' | 'replace';
  readonly candidate_ids: string;
  readonly observation_ids: string;
};

export class DurableCommitPortError extends Error {
  readonly code = 'COMMIT_PORT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'DurableCommitPortError';
  }
}

type CommitScope = CommitRecord['scope'];

export type DurableCommitPort = CommitPort & {
  /** Registers the server-owned card-set metadata before the atomic commit. */
  setCardSetId(scope: CommitScope, idempotencyKey: string, cardSetId: string): void;
  /** Releases pending card metadata when a turn ends before a commit. */
  clearCardSetId(scope: CommitScope, idempotencyKey: string): void;
  setConversationResponse(record: CommitRecord, response: AssistantResponse): void;
};

const pendingKey = (scope: CommitScope, idempotencyKey: string): string =>
  JSON.stringify([scope.ownerScopeRef, scope.threadId, idempotencyKey]);

const isDurableCommitPort = (value: CommitPort): value is DurableCommitPort =>
  typeof value === 'object' &&
  value !== null &&
  'setCardSetId' in value &&
  typeof value.setCardSetId === 'function' &&
  'clearCardSetId' in value &&
  typeof value.clearCardSetId === 'function' &&
  'setConversationResponse' in value &&
  typeof value.setConversationResponse === 'function';

/** Supplies Worker-owned card metadata without extending Core's reference-only commit record. */
export const registerRuntimeCardSetId = (
  port: CommitPort,
  scope: CommitScope,
  idempotencyKey: string,
  cardSetId: string,
): void => {
  if (isDurableCommitPort(port)) port.setCardSetId(scope, idempotencyKey, cardSetId);
};

/** Drops a card-set sidecar when validation, cancellation, or disposal prevents a commit. */
export const clearRuntimeCardSetId = (
  port: CommitPort,
  scope: CommitScope,
  idempotencyKey: string,
): void => {
  if (isDurableCommitPort(port)) port.clearCardSetId(scope, idempotencyKey);
};

/** Worker-owned preparation; Core's commit contract remains reference-only. */
export const prepareRuntimeConversationResponse = (
  port: CommitPort,
  record: CommitRecord,
  response: () => AssistantResponse,
): void => {
  if (isDurableCommitPort(port)) port.setConversationResponse(record, response());
};

export const initializeDurableCommitTable = (storage: DurableObjectStorage): void => {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS runtime_commit (
      owner_scope_ref TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      response_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload_digest TEXT NOT NULL,
      presentation TEXT NOT NULL CHECK (presentation IN ('keep', 'replace')),
      candidate_ids TEXT NOT NULL,
      observation_ids TEXT NOT NULL,
      PRIMARY KEY (owner_scope_ref, thread_id, idempotency_key)
    )
  `);
};

/** Test-only compatibility CAS; production finalization uses the Durable CommitPort transaction. */
export const advanceThreadRevision = (
  storage: DurableObjectStorage,
  target: ThreadRuntimeTarget,
  responseRevision: number,
): boolean =>
  responseRevision === target.revision + 1 &&
  storage.sql.exec(
    'UPDATE thread_state SET revision = ? WHERE singleton = 1 AND thread_id = ? AND owner_scope_ref = ? AND revision = ? AND active = 1 AND deleted = 0',
    responseRevision,
    target.threadId,
    target.ownerScopeRef,
    target.revision,
  ).rowsWritten === 1;

const conflict = (code: 'IDEMPOTENCY_CONFLICT' | 'STALE_REVISION'): CommitPortResult => ({
  status: 'conflict',
  conflict: {
    code,
    message:
      code === 'IDEMPOTENCY_CONFLICT'
        ? 'commit idempotency key has different content'
        : 'commit revision is no longer current',
  },
});

const encodedIds = (ids: readonly string[]): string => JSON.stringify(ids);

const matchesRecord = (row: CommitRow, request: CommitRequest): boolean => {
  const { record } = request;
  return (
    row.owner_scope_ref === record.scope.ownerScopeRef &&
    row.thread_id === record.scope.threadId &&
    row.turn_id === record.turnId &&
    row.idempotency_key === record.idempotencyKey &&
    row.revision === record.revision &&
    row.payload_digest === record.payloadDigest &&
    row.presentation === record.presentation &&
    row.candidate_ids === encodedIds(record.references.candidateIds) &&
    row.observation_ids === encodedIds(record.references.observationIds)
  );
};

const replayReceipt = (row: CommitRow): CommitPortResult => ({
  status: 'committed',
  receipt: {
    responseId: row.response_id,
    revision: row.revision,
    payloadDigest: row.payload_digest,
    presentation: row.presentation,
    replayed: true,
  },
});

const newReceipt = (record: CommitRecord): CommitPortResult => ({
  status: 'committed',
  receipt: {
    responseId: record.responseId,
    revision: record.revision,
    payloadDigest: record.payloadDigest,
    presentation: record.presentation,
    replayed: false,
  },
});

const validateRequest = (value: CommitRequest): CommitRequest => {
  const parsed = v.safeParse(CommitRequestSchema, value);
  if (!parsed.success) throw new DurableCommitPortError('commit request is invalid');
  if (parsed.output.record.revision !== parsed.output.expectedRevision + 1) {
    throw new DurableCommitPortError('commit revision does not advance expected revision');
  }
  return parsed.output;
};

/**
 * Commits only reference metadata in one DO transaction. When a runtime row is active, its
 * completion metadata and the retention-approved conversation delivery are finalized in the
 * same transaction as the snapshot CAS. The commit ledger itself remains reference-only.
 */
export const createDurableCommitPort = (
  storage: DurableObjectStorage,
  delivery?: { readonly outbox: ThreadConversationOutbox; readonly now: () => string },
): DurableCommitPort => {
  const pendingCardSets = new Map<string, string>();
  const pendingResponses = new Map<string, AssistantResponse>();
  return {
    setConversationResponse(record, response) {
      if (delivery !== undefined)
        pendingResponses.set(pendingKey(record.scope, record.idempotencyKey), response);
    },
    setCardSetId(scope, idempotencyKey, cardSetId) {
      if (!v.safeParse(CardSetIdSchema, cardSetId).success)
        throw new DurableCommitPortError('card set ID is invalid');
      const key = pendingKey(scope, idempotencyKey);
      const previous = pendingCardSets.get(key);
      if (previous !== undefined && previous !== cardSetId)
        throw new DurableCommitPortError('card set ID changed during commit');
      pendingCardSets.set(key, cardSetId);
    },
    clearCardSetId(scope, idempotencyKey) {
      const key = pendingKey(scope, idempotencyKey);
      pendingCardSets.delete(key);
      pendingResponses.delete(key);
    },
    commit(value) {
      const request = validateRequest(value);
      const { record } = request;
      const key = pendingKey(record.scope, record.idempotencyKey);
      const cardSetId = pendingCardSets.get(key) ?? null;
      const candidateIds = encodedIds(record.references.candidateIds);
      const observationIds = encodedIds(record.references.observationIds);
      try {
        return storage.transactionSync(() => {
          const thread = storage.sql
            .exec<ThreadStateRow>(
              'SELECT thread_id, owner_scope_ref, revision, active, deleted FROM thread_state WHERE singleton = 1',
            )
            .toArray()[0];
          if (
            thread === undefined ||
            thread.thread_id !== record.scope.threadId ||
            thread.owner_scope_ref !== record.scope.ownerScopeRef ||
            thread.deleted !== 0
          ) {
            return conflict('STALE_REVISION');
          }

          const prior = storage.sql
            .exec<CommitRow>(
              'SELECT owner_scope_ref, thread_id, turn_id, idempotency_key, response_id, revision, payload_digest, presentation, candidate_ids, observation_ids FROM runtime_commit WHERE owner_scope_ref = ? AND thread_id = ? AND idempotency_key = ?',
              record.scope.ownerScopeRef,
              record.scope.threadId,
              record.idempotencyKey,
            )
            .toArray()[0];
          if (prior !== undefined)
            return matchesRecord(prior, request)
              ? replayReceipt(prior)
              : conflict('IDEMPOTENCY_CONFLICT');

          if (record.presentation === 'replace' && cardSetId === null)
            throw new DurableCommitPortError('card set ID is required for card commit');

          const runtime = storage.sql
            .exec<RuntimeTurnRow>(
              'SELECT status FROM runtime_turn WHERE owner_scope_ref = ? AND thread_id = ? AND turn_id = ? AND revision = ?',
              record.scope.ownerScopeRef,
              record.scope.threadId,
              record.turnId,
              request.expectedRevision,
            )
            .toArray()[0];
          if (
            runtime === undefined ||
            runtime.status !== 'running' ||
            thread.revision !== request.expectedRevision ||
            thread.active !== 1 ||
            thread.deleted !== 0
          ) {
            return conflict('STALE_REVISION');
          }

          const advanced = storage.sql.exec(
            'UPDATE thread_state SET revision = ? WHERE singleton = 1 AND thread_id = ? AND owner_scope_ref = ? AND revision = ? AND active = 1 AND deleted = 0',
            record.revision,
            record.scope.threadId,
            record.scope.ownerScopeRef,
            request.expectedRevision,
          );
          if (advanced.rowsWritten !== 1) return conflict('STALE_REVISION');

          storage.sql.exec(
            'INSERT INTO runtime_commit (owner_scope_ref, thread_id, turn_id, idempotency_key, response_id, revision, payload_digest, presentation, candidate_ids, observation_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            record.scope.ownerScopeRef,
            record.scope.threadId,
            record.turnId,
            record.idempotencyKey,
            record.responseId,
            record.revision,
            record.payloadDigest,
            record.presentation,
            candidateIds,
            observationIds,
          );

          const finalized = storage.sql.exec(
            "UPDATE runtime_turn SET status = 'completed', response_id = ?, response_revision = ?, response_kind = ?, response_presentation = ?, response_card_set_id = ? WHERE owner_scope_ref = ? AND thread_id = ? AND turn_id = ? AND revision = ? AND status = 'running'",
            record.responseId,
            record.revision,
            record.presentation === 'replace' ? 'cards' : 'message',
            record.presentation,
            cardSetId,
            record.scope.ownerScopeRef,
            record.scope.threadId,
            record.turnId,
            request.expectedRevision,
          );
          if (finalized.rowsWritten !== 1)
            throw new DurableCommitPortError('runtime turn finalization failed');
          delivery?.outbox.commit(request, pendingResponses.get(key), delivery.now());
          return newReceipt(record);
        });
      } finally {
        pendingCardSets.delete(key);
        pendingResponses.delete(key);
      }
    },
  };
};
