import * as v from 'valibot';
import { OpaqueIdSchema, RevisionSchema, type RegistryScope } from '@ima/core';
import {
  candidateIdentityForReference,
  type RuntimeProductionCandidateIdentityReference,
  type RuntimeProductionContextReference,
} from '../runtime/runtime-production-context-reference';

export type RuntimeSavedCandidateIdentity = RuntimeProductionCandidateIdentityReference;

export const runtimeSavedCandidateBindingFor = (
  row:
    | {
        readonly owner_scope_ref: string;
        readonly thread_id: string;
        readonly revision: number;
        readonly deleted: number;
      }
    | undefined,
):
  | {
      readonly ownerScopeRef: string;
      readonly threadId: string;
      readonly revision: number;
      readonly deleted: number;
    }
  | undefined =>
  row === undefined
    ? undefined
    : {
        ownerScopeRef: row.owner_scope_ref,
        threadId: row.thread_id,
        revision: row.revision,
        deleted: row.deleted,
      };

export type RuntimeSavedCandidateResult =
  | ({ readonly ok: true } & RuntimeSavedCandidateIdentity)
  | {
      readonly ok: false;
      readonly code:
        'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'STALE_TURN' | 'UNKNOWN_CANDIDATE';
    };

export const resolveRuntimeSavedCandidate = async (input: {
  readonly ownerScopeRef: unknown;
  readonly candidateId: unknown;
  readonly expectedRevision: unknown;
  readonly ready: () => Promise<void>;
  readonly expired: () => Promise<boolean>;
  readonly read: () =>
    | {
        readonly ownerScopeRef: string;
        readonly threadId: string;
        readonly revision: number;
        readonly deleted: number;
      }
    | undefined;
  readonly snapshotFor: (
    scope: Pick<RegistryScope, 'ownerScopeRef' | 'threadId'>,
  ) => RuntimeProductionContextReference | undefined;
  readonly now: () => string;
}): Promise<RuntimeSavedCandidateResult> => {
  const owner = v.safeParse(OpaqueIdSchema, input.ownerScopeRef);
  const candidate = v.safeParse(OpaqueIdSchema, input.candidateId);
  const revision = v.safeParse(RevisionSchema, input.expectedRevision);
  if (!owner.success || !candidate.success || !revision.success) {
    return { ok: false, code: 'INVALID_INPUT' };
  }
  await input.ready();
  if (await input.expired()) return { ok: false, code: 'NOT_FOUND' };
  const row = input.read();
  if (row === undefined || row.deleted === 1) return { ok: false, code: 'NOT_FOUND' };
  if (row.ownerScopeRef !== owner.output) return { ok: false, code: 'FORBIDDEN' };
  if (row.revision !== revision.output) return { ok: false, code: 'STALE_TURN' };
  const identity = candidateIdentityForReference({
    snapshot: input.snapshotFor({ ownerScopeRef: row.ownerScopeRef, threadId: row.threadId }),
    scope: { ownerScopeRef: row.ownerScopeRef, threadId: row.threadId },
    candidateId: candidate.output,
    now: input.now(),
  });
  return identity === undefined
    ? { ok: false, code: 'UNKNOWN_CANDIDATE' }
    : { ok: true, ...identity };
};

export type RuntimeSavedCandidateResolver = {
  readonly resolve: (
    ownerScopeRef: unknown,
    candidateId: unknown,
    expectedRevision: unknown,
  ) => Promise<RuntimeSavedCandidateResult>;
};

export const createRuntimeSavedCandidateResolver = (
  input: Omit<
    Parameters<typeof resolveRuntimeSavedCandidate>[0],
    'ownerScopeRef' | 'candidateId' | 'expectedRevision'
  >,
): RuntimeSavedCandidateResolver => ({
  resolve: (ownerScopeRef, candidateId, expectedRevision) =>
    resolveRuntimeSavedCandidate({ ...input, ownerScopeRef, candidateId, expectedRevision }),
});
