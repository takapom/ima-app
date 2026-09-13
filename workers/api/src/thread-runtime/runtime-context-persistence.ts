import type { RegistryScope } from '@ima/core';
import {
  parseRuntimeProductionContextReference,
  type RuntimeProductionContextPersistence,
  type RuntimeProductionContextReference,
} from '../runtime/context/runtime-production-context-reference';

type RuntimeContextRow = { readonly payload: string };

const keyFor = (scope: RegistryScope): readonly [string, string] => [
  scope.ownerScopeRef,
  scope.threadId,
];

/** Persists only validated IDs, expiry metadata, and reference-only state; never raw content. */
export const createDurableRuntimeContextPersistence = (
  storage: DurableObjectStorage,
): RuntimeProductionContextPersistence => {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS runtime_context_reference (
      owner_scope_ref TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (owner_scope_ref, thread_id)
    )
  `);

  return {
    load(scope) {
      const [ownerScopeRef, threadId] = keyFor(scope);
      const row = storage.sql
        .exec<RuntimeContextRow>(
          'SELECT payload FROM runtime_context_reference WHERE owner_scope_ref = ? AND thread_id = ?',
          ownerScopeRef,
          threadId,
        )
        .toArray()[0];
      if (row === undefined) return undefined;
      try {
        return parseRuntimeProductionContextReference(JSON.parse(row.payload));
      } catch {
        return undefined;
      }
    },
    save(snapshot: RuntimeProductionContextReference) {
      const [ownerScopeRef, threadId] = keyFor(snapshot);
      storage.transactionSync(() => {
        storage.sql.exec(
          'INSERT INTO runtime_context_reference (owner_scope_ref, thread_id, payload) VALUES (?, ?, ?) ON CONFLICT(owner_scope_ref, thread_id) DO UPDATE SET payload = excluded.payload',
          ownerScopeRef,
          threadId,
          JSON.stringify(snapshot),
        );
      });
    },
    clear(scope) {
      const [ownerScopeRef, threadId] = keyFor(scope);
      storage.sql.exec(
        'DELETE FROM runtime_context_reference WHERE owner_scope_ref = ? AND thread_id = ?',
        ownerScopeRef,
        threadId,
      );
    },
  };
};
