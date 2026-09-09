import { describe, expect, it } from 'vitest';
import {
  SubmitApplication,
  type ObservationContext,
  type ObservationRegistration,
  type RegistryJsonValue,
  type SubmitValidationContext,
  type RegistryScope,
} from '@ima/core';
import {
  BarrierCommitHash,
  BarrierCommitPort,
  createCommitFixture,
  EvalCommitHash,
  InMemoryCommitPort,
} from './commit-fixture';
import { createRegistryFixture } from './registry-fixture';

const scope: RegistryScope = { ownerScopeRef: 'eval-owner', threadId: 'eval-thread' };
const context: SubmitValidationContext = {
  scope,
  serverNow: '2026-09-10T12:00:00Z',
  departureAt: '2026-09-10T12:00:00Z',
  expectedObservationContext: {
    ownerScopeRef: scope.ownerScopeRef,
    threadId: scope.threadId,
    capabilityVersion: 'eval-v1',
    locationRevision: 1,
    originRef: null,
    homeStationRef: null,
    minimumStayMinutes: null,
    timeContext: 'now',
  },
  preferences: {
    maxWalkMinutes: null,
    homeStationRef: null,
    minimumStayMinutes: null,
  },
  travel: [],
  requireLastOrderAtArrival: false,
};

const message = (text = '条件を確認しました') => ({
  text,
  evidenceIds: [],
  basis: 'conversational' as const,
});

const request = (idempotencyKey: string, expectedRevision = 1, turnId = 'eval-turn') => ({
  scope,
  turnId,
  expectedRevision,
  idempotencyKey,
});

const makeApplication = () => {
  const registryFixture = createRegistryFixture();
  const commitFixture = createCommitFixture();
  commitFixture.commits.startTurn(scope, 'eval-turn', 1);
  return {
    registry: registryFixture.registry,
    application: new SubmitApplication(
      commitFixture.commits,
      registryFixture.ids,
      commitFixture.hashes,
    ),
    commits: commitFixture.commits,
  };
};

const cardsNow = '2026-09-09T12:00:00Z';
const cardsContext: SubmitValidationContext = {
  scope,
  serverNow: cardsNow,
  departureAt: cardsNow,
  expectedObservationContext: {
    ownerScopeRef: scope.ownerScopeRef,
    threadId: scope.threadId,
    capabilityVersion: 'eval-v1',
    locationRevision: 1,
    originRef: null,
    homeStationRef: null,
    minimumStayMinutes: null,
    timeContext: 'now',
  },
  preferences: {
    maxWalkMinutes: null,
    homeStationRef: null,
    minimumStayMinutes: null,
  },
  travel: [],
  requireLastOrderAtArrival: false,
};

const cardsRetention = {
  retentionDecision: 'deny' as const,
  retentionMode: 'session_only' as const,
  sessionExpiresAt: '2026-09-09T23:00:00Z',
  freshUntil: '2026-09-09T13:00:00Z',
  displayUntil: '2026-09-09T22:00:00Z',
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: { label: 'eval', sourceLink: null },
  restoreMode: 'reference_only' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};

const registerCardObservation = (
  registry: ReturnType<typeof createRegistryFixture>['registry'],
  candidateId: string,
  field: string,
  value: RegistryJsonValue,
  observationContext: ObservationContext,
): string => {
  const input: ObservationRegistration = {
    scope,
    candidateId,
    field,
    value,
    basis: field === 'identity' || field === 'opening_hours' ? 'provider_reported' : 'computed',
    sourceUpdatedAt: null,
    freshUntil: '2026-09-09T13:00:00Z',
    expiresAt: '2026-09-09T14:00:00Z',
    context: observationContext,
    sources: [{ provider: 'eval', recordRef: `eval-${field}`, attribution: null, publicUrl: null }],
    retention: cardsRetention,
  };
  return registry.registerObservation(input).observationId;
};

const makeCardsApplication = () => {
  const registryFixture = createRegistryFixture(cardsNow);
  const candidate = registryFixture.registry.registerCandidate({
    ...scope,
    provider: 'eval',
    recordRef: 'eval-place-1',
    displayName: '評価店',
    status: 'operational',
  });
  const identity = registerCardObservation(
    registryFixture.registry,
    candidate.candidateId,
    'identity',
    {
      name: '評価店',
      area: '恵比寿',
      address: null,
      category: 'cafe',
      businessStatus: 'operational',
      sourceUrl: null,
    },
    cardsContext.expectedObservationContext,
  );
  const opening = registerCardObservation(
    registryFixture.registry,
    candidate.candidateId,
    'opening_hours',
    {
      timeZone: 'UTC',
      intervals: [{ startAt: '2026-09-09T11:00:00Z', endAt: '2026-09-09T15:00:00Z' }],
      weeklyText: ['11:00-15:00'],
      evaluatedAt: cardsNow,
      listedOpenAtEvaluation: true,
      nextBoundaryAt: '2026-09-09T15:00:00Z',
      lastOrderAt: '2026-09-09T14:00:00Z',
      lastOrderRaw: '14:00',
    },
    cardsContext.expectedObservationContext,
  );
  const input = {
    message: [{ text: '候補を提案します', evidenceIds: [identity], basis: 'grounded' as const }],
    hero: {
      candidateId: candidate.candidateId,
      evidenceIds: [identity, opening],
      why: { text: '営業中です', evidenceIds: [identity], basis: 'grounded' as const },
      diff: { text: '比較の基準です', evidenceIds: [identity], basis: 'grounded' as const },
    },
    alts: [],
  };
  const commits = createCommitFixture();
  commits.commits.startTurn(scope, 'eval-turn', 1);
  return {
    registry: registryFixture.registry,
    input,
    application: new SubmitApplication(commits.commits, registryFixture.ids, commits.hashes),
    commits: commits.commits,
    candidateId: candidate.candidateId,
    identity,
    opening,
  };
};

describe('SubmitApplication and Core CAS fixture', () => {
  it('keeps invalid message evidence at zero durable mutations', async () => {
    const fixture = makeApplication();
    const result = await fixture.application.commitMessage(
      { text: '根拠が必要', evidenceIds: [], basis: 'grounded' },
      context,
      fixture.registry,
      request('invalid-key'),
    );

    expect(result.status).toBe('invalid');
    expect(fixture.commits.calls).toBe(0);
    expect(fixture.commits.writes).toBe(0);
  });

  it('commits a valid message once and exposes its payload only for the same turn', async () => {
    const fixture = makeApplication();
    const result = await fixture.application.commitMessage(
      message(),
      context,
      fixture.registry,
      request('message-key'),
    );

    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.receipt.revision).toBe(2);
    expect(result.receipt.replayed).toBe(false);
    expect(fixture.commits.writes).toBe(1);
    const response = fixture.application.getCommittedResponse(
      scope,
      'eval-turn',
      result.receipt.responseId,
    );
    expect(response?.presentation).toBe('keep');
    if (response?.presentation === 'keep') response.message.text = '呼出元による変更';
    const storedResponse = fixture.application.getCommittedResponse(
      scope,
      'eval-turn',
      result.receipt.responseId,
    );
    expect(storedResponse?.presentation === 'keep' ? storedResponse.message.text : undefined).toBe(
      '条件を確認しました',
    );
    expect(
      fixture.application.getCommittedResponse(scope, 'other-turn', result.receipt.responseId),
    ).toBeUndefined();
    const durable = fixture.commits.read(scope, 'eval-turn');
    expect(durable).toBeDefined();
    expect(Object.keys(durable ?? {}).sort()).toEqual([
      'idempotencyKey',
      'payloadDigest',
      'presentation',
      'references',
      'responseId',
      'revision',
      'schemaVersion',
      'scope',
      'turnId',
    ]);
    expect(durable).not.toHaveProperty('response');
    expect(durable).not.toHaveProperty('message');
    fixture.application.clearTurn(scope, 'eval-turn');
    expect(
      fixture.application.getCommittedResponse(scope, 'eval-turn', result.receipt.responseId),
    ).toBeUndefined();
  });

  it('returns the same receipt for an idempotent same-content replay', async () => {
    const fixture = makeApplication();
    const first = await fixture.application.commitMessage(
      message(),
      context,
      fixture.registry,
      request('replay-key'),
    );
    const second = await fixture.application.commitMessage(
      message(),
      context,
      fixture.registry,
      request('replay-key'),
    );

    expect(first.status).toBe('committed');
    expect(second.status).toBe('committed');
    if (first.status !== 'committed' || second.status !== 'committed') return;
    expect(second.receipt).toEqual({ ...first.receipt, replayed: true });
    expect(fixture.commits.calls).toBe(2);
    expect(fixture.commits.writes).toBe(1);
  });

  it('commits registry-derived cards and keeps message, why, and diff in the same ephemeral response', async () => {
    const fixture = makeCardsApplication();
    const result = await fixture.application.commitCards(
      fixture.input,
      cardsContext,
      fixture.registry,
      request('cards-key'),
    );

    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    expect(result.receipt.presentation).toBe('replace');
    const response = fixture.application.getCommittedResponse(
      scope,
      'eval-turn',
      result.receipt.responseId,
    );
    expect(response?.presentation).toBe('replace');
    if (response?.presentation !== 'replace') return;
    expect(response.hero.identity.name).toBe('評価店');
    expect(response.message[0]?.text).toBe('候補を提案します');
    expect(response.hero.why.text).toBe('営業中です');
    expect(response.hero.diff?.text).toBe('比較の基準です');
    expect(fixture.commits.writes).toBe(1);
    const durable = fixture.commits.read(scope, 'eval-turn');
    expect(durable?.references).toEqual({
      candidateIds: [fixture.candidateId],
      observationIds: [fixture.identity, fixture.opening],
    });
    expect(durable).not.toHaveProperty('identity');
    expect(durable).not.toHaveProperty('why');
    expect(durable).not.toHaveProperty('diff');
  });

  it('keeps invalid cards at zero durable mutations', async () => {
    const fixture = makeCardsApplication();
    const invalidInput = {
      ...fixture.input,
      hero: { ...fixture.input.hero, evidenceIds: ['missing-observation'] },
    };
    const result = await fixture.application.commitCards(
      invalidInput,
      cardsContext,
      fixture.registry,
      request('invalid-cards-key'),
    );

    expect(result.status).toBe('invalid');
    expect(fixture.commits.calls).toBe(0);
    expect(fixture.commits.writes).toBe(0);
  });

  it('rejects a different digest for the same idempotency key', async () => {
    const fixture = makeApplication();
    await fixture.application.commitMessage(
      message(),
      context,
      fixture.registry,
      request('conflict-key'),
    );
    const result = await fixture.application.commitMessage(
      message('内容が変わりました'),
      context,
      fixture.registry,
      request('conflict-key'),
    );

    expect(result).toEqual({
      status: 'conflict',
      conflict: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'idempotency key was already used for different content',
      },
    });
    expect(fixture.commits.writes).toBe(1);
  });

  it('allows only one side of a same-revision concurrent submit to commit', async () => {
    const registryFixture = createRegistryFixture();
    const commits = new InMemoryCommitPort();
    commits.startTurn(scope, 'eval-turn', 1);
    const application = new SubmitApplication(
      new BarrierCommitPort(commits),
      registryFixture.ids,
      new BarrierCommitHash(new EvalCommitHash()),
    );
    const [first, second] = await Promise.all([
      application.commitMessage(message(), context, registryFixture.registry, request('first-key')),
      application.commitMessage(
        message('競合した内容'),
        context,
        registryFixture.registry,
        request('second-key'),
      ),
    ]);

    expect([first.status, second.status].sort()).toEqual(['committed', 'conflict']);
    expect(commits.calls).toBe(2);
    expect(commits.writes).toBe(1);
  });

  it('rejects an old turn after the thread advances and accepts one commit for the new turn', async () => {
    const fixture = makeApplication();
    const first = await fixture.application.commitMessage(
      message(),
      context,
      fixture.registry,
      request('first-turn-key'),
    );
    expect(first.status).toBe('committed');
    fixture.commits.startTurn(scope, 'new-turn', 2);

    const oldTurn = await fixture.application.commitMessage(
      message('旧turnの再送'),
      context,
      fixture.registry,
      request('old-turn-key', 1),
    );
    const newTurn = await fixture.application.commitMessage(
      message('新turnの内容'),
      context,
      fixture.registry,
      request('new-turn-key', 2, 'new-turn'),
    );

    expect(oldTurn).toEqual({
      status: 'conflict',
      conflict: {
        code: 'STALE_REVISION',
        message: 'commit turn is no longer active',
      },
    });
    expect(newTurn.status).toBe('committed');
    if (newTurn.status === 'committed') expect(newTurn.receipt.revision).toBe(3);
    expect(fixture.commits.writes).toBe(2);
  });
});
