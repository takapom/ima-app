import { describe, expect, it } from 'vitest';
import type { ModelContextSource, RegistryScope } from '@ima/core';
import {
  candidateIdentityForReference,
  parseRuntimeProductionContextReference,
  referenceSnapshotFor,
  type RuntimeProductionContextReference,
} from '../../../src/runtime/context/runtime-production-context-reference';
import {
  resolveRuntimeSavedCandidate,
  type RuntimeSavedCandidateResult,
} from '../../../src/thread-runtime/runtime-saved-candidate-rpc';

const scope: RegistryScope = { ownerScopeRef: 'saved-owner', threadId: 'saved-thread' };
const snapshot = {
  ownerScopeRef: scope.ownerScopeRef,
  threadId: scope.threadId,
  sessionExpiresAt: '2026-09-10T23:00:00.000Z',
  savedPlaceRefs: [],
  excludedCandidateIds: ['candidate-excluded'],
  history: [],
  originalTurns: [],
  cardSet: {
    cardSetId: 'card-set-current',
    scope,
    responseId: 'response-current',
    entries: [
      { candidateId: 'candidate-current', displayOrder: 0, role: 'hero' as const },
      { candidateId: 'candidate-excluded', displayOrder: 1, role: 'alt' as const },
    ],
    selectedCandidateId: null,
    excludedCandidateIds: ['candidate-excluded'],
  },
  evidence: [],
  candidateIdentities: [
    { candidateId: 'candidate-current', provider: 'fixture', recordRef: 'record-current' },
    { candidateId: 'candidate-excluded', provider: 'fixture', recordRef: 'record-excluded' },
  ],
} satisfies RuntimeProductionContextReference;
const snapshotCandidateIdentities = snapshot.candidateIdentities ?? [];

const candidateState = (candidateId: string) => ({
  record: {
    ...snapshot.cardSet,
    entries: snapshot.cardSet.entries.filter((entry) => entry.candidateId === candidateId),
    excludedCandidateIds: [],
  },
  candidates: [
    {
      candidateId,
      ownerScopeRef: scope.ownerScopeRef,
      threadId: scope.threadId,
      displayName: '[withheld]',
      status: 'unknown' as const,
      excluded: false,
    },
  ],
});

describe('saved candidate identity reference', () => {
  it('accepts only a current, non-excluded identity before session expiry', () => {
    expect(
      candidateIdentityForReference({
        snapshot,
        scope,
        candidateId: 'candidate-current',
        now: '2026-09-10T22:59:59.000Z',
      }),
    ).toEqual({
      candidateId: 'candidate-current',
      provider: 'fixture',
      recordRef: 'record-current',
    });
    expect(
      candidateIdentityForReference({
        snapshot,
        scope,
        candidateId: 'candidate-excluded',
        now: '2026-09-10T22:00:00.000Z',
      }),
    ).toBeUndefined();
    expect(
      candidateIdentityForReference({
        snapshot,
        scope: { ...scope, ownerScopeRef: 'other-owner' },
        candidateId: 'candidate-current',
        now: '2026-09-10T22:00:00.000Z',
      }),
    ).toBeUndefined();
    expect(
      candidateIdentityForReference({
        snapshot,
        scope,
        candidateId: 'candidate-current',
        now: '2026-09-10T23:00:00.000Z',
      }),
    ).toBeUndefined();
  });

  it('drops identities outside the replacement card set and fails closed for old snapshots', () => {
    const state = {
      history: [],
      originalTurns: [],
      cardSet: candidateState('candidate-current') as NonNullable<ModelContextSource['cardSet']>,
      evidence: [],
      savedPlaceRefs: [],
      excludedCandidateIds: [],
      candidateIdentities: [
        ...snapshotCandidateIdentities,
        { candidateId: 'candidate-old', provider: 'fixture', recordRef: 'record-old' },
      ],
    };
    const persisted = referenceSnapshotFor({
      scope,
      sessionExpiresAt: snapshot.sessionExpiresAt,
      state,
    });
    expect(persisted.candidateIdentities).toEqual([
      { candidateId: 'candidate-current', provider: 'fixture', recordRef: 'record-current' },
    ]);

    const oldSnapshot = { ...snapshot };
    Reflect.deleteProperty(oldSnapshot, 'candidateIdentities');
    const parsedOld = parseRuntimeProductionContextReference(oldSnapshot);
    expect(parsedOld).toBeDefined();
    expect(
      candidateIdentityForReference({
        snapshot: parsedOld,
        scope,
        candidateId: 'candidate-current',
        now: '2026-09-10T22:00:00.000Z',
      }),
    ).toBeUndefined();
    expect(
      parseRuntimeProductionContextReference({
        ...snapshot,
        candidateIdentities: [
          ...snapshotCandidateIdentities,
          { candidateId: 'candidate-outside', provider: 'fixture', recordRef: 'record-outside' },
        ],
      }),
    ).toBeUndefined();
  });

  it('maps binding, snapshot, owner and revision checks to typed results', async () => {
    const resolve = (input: {
      readonly ownerScopeRef: unknown;
      readonly candidateId: unknown;
      readonly expectedRevision: unknown;
      readonly row:
        | {
            readonly ownerScopeRef: string;
            readonly threadId: string;
            readonly revision: number;
            readonly deleted: number;
          }
        | undefined;
    }): Promise<RuntimeSavedCandidateResult> =>
      resolveRuntimeSavedCandidate({
        ownerScopeRef: input.ownerScopeRef,
        candidateId: input.candidateId,
        expectedRevision: input.expectedRevision,
        ready: () => Promise.resolve(),
        expired: () => Promise.resolve(false),
        read: () => input.row,
        snapshotFor: () => snapshot,
        now: () => '2026-09-10T22:00:00.000Z',
      });

    await expect(
      resolve({
        ownerScopeRef: scope.ownerScopeRef,
        candidateId: 'candidate-current',
        expectedRevision: 2,
        row: { ...scope, revision: 2, deleted: 0 },
      }),
    ).resolves.toMatchObject({ ok: true, provider: 'fixture', recordRef: 'record-current' });
    await expect(
      resolve({
        ownerScopeRef: scope.ownerScopeRef,
        candidateId: 'candidate-current',
        expectedRevision: 1,
        row: { ...scope, revision: 2, deleted: 0 },
      }),
    ).resolves.toEqual({ ok: false, code: 'STALE_TURN' });
  });
});
