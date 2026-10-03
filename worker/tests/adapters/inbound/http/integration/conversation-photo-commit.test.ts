import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { CommitRequest } from '@worker/application/ports/commit';
import { createDurableCommitPort } from '@worker/adapters/out/persistence/thread/durable-commit-adapter';
import { ThreadConversationOutbox } from '@worker/adapters/out/persistence/conversations/thread-conversation-outbox';
import { SqlConversationRecords } from '@worker/adapters/out/persistence/conversations/sql-conversation-records';
import { SqlConversationRuns } from '@worker/adapters/out/persistence/conversations/sql-conversation-runs';
import { createSqlPhotoReferenceStore } from '@worker/adapters/out/persistence/photo/sql-reference-store';
import { createPhotoTokenCodec } from '@worker/adapters/out/security/photo-token-codec';
import { createPhotoTokenIssuer } from '@worker/adapters/out/security/photo-token-issuer';
import { cardEvidenceResolver } from '@worker/composition/runtime-production-provider-config';
import { createPhotoTokenPreparer } from '@worker/runtime/response/photo-token-issuance';
import {
  NOW,
  SCOPE,
  allowRetention,
  context,
  createComposition,
  respondWith,
  validationContext,
} from '../../../../runtime/turn-execution/runtime-turn-composition-fixture';

const hasThreads = (value: unknown): value is { THREADS: DurableObjectNamespace<ThreadDO> } =>
  typeof value === 'object' && value !== null && 'THREADS' in value;
const target = { ...SCOPE, turnId: context.turnId, revision: 1 };
const scope = { ownerScopeRef: SCOPE.ownerScopeRef, conversationId: 'conversation', runId: 'run' };
const deviceId = 'photo-device';
const secret = 'fixture-photo-secret';
const photoRef = 'https://imgfp.hotp.jp/IMGH/fixture.jpg';
const photoUntil = '2026-09-10T00:00:30.000Z';

const setup = async () => {
  if (!hasThreads(env)) throw new Error('THREADS_MISSING');
  const stub = env.THREADS.getByName(crypto.randomUUID());
  await stub.initialize(SCOPE.ownerScopeRef, SCOPE.threadId);
  await runInDurableObject(stub, (_instance, state) => {
    new ThreadConversationOutbox(state.storage).bind({ ...scope, target });
    state.storage.sql.exec(
      'INSERT INTO runtime_turn (turn_id, owner_scope_ref, thread_id, revision, idempotency_key, input_digest, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      context.turnId,
      SCOPE.ownerScopeRef,
      SCOPE.threadId,
      1,
      'send',
      'digest',
      'running',
    );
  });
  return stub;
};

const compose = (storage: DurableObjectStorage, persistence: boolean, fail = false) => {
  const references = createSqlPhotoReferenceStore(storage);
  const codec = createPhotoTokenCodec({
    secret,
    referenceResolver: { resolve: () => Promise.resolve(references) },
  });
  const issuer = createPhotoTokenIssuer(codec);
  const issue = vi.fn<typeof issuer.issue>((input, now) =>
    fail ? Promise.reject(new Error('PHOTO_STORAGE_FAILED')) : issuer.issue(input, now),
  );
  const outbox = new ThreadConversationOutbox(storage);
  const port = createDurableCommitPort(storage, { outbox, now: () => NOW });
  const commits: CommitRequest[] = [];
  const policy = {
    decision: 'allow',
    activation: 'fixture_only',
    fieldStatus: 'known',
    policyStatus: 'available',
  } as const;
  const fixture = createComposition(
    {
      ...port,
      commit: (request) => {
        commits.push(request);
        return port.commit(request);
      },
    },
    1,
    allowRetention,
    () => NOW,
    { digest: () => 'digest' },
    {
      textRetention: allowRetention.retention,
      cardSetId: 'cards',
      resolveCardEvidence: (candidate, evidence) =>
        cardEvidenceResolver(registry, context)(candidate, evidence),
      preparePhotoTokens: (input) =>
        createPhotoTokenPreparer({
          issuer: { issue },
          registry,
          scope: SCOPE,
          deviceId,
          sourceTurnId: context.turnId,
          sourceRevision: 1,
          photosEnabled: true,
          displayPolicyFor: () => ({
            mode: 'fixture',
            policy: {
              llm_input: policy,
              display: policy,
              persistence: persistence
                ? policy
                : { ...policy, decision: 'deny', policyStatus: 'policy_withheld' },
            },
          }),
        })(input),
    },
  );
  const registry: CandidateObservationRegistryPort = fixture.registry;
  const observation = (
    field: string,
    value: Parameters<typeof fixture.registry.registerObservation>[0]['value'],
  ) =>
    fixture.registry.registerObservation({
      scope: SCOPE,
      candidateId: fixture.currentCandidateId,
      field,
      value,
      basis: 'provider_reported',
      sourceUpdatedAt: null,
      freshUntil: field === 'photos' ? photoUntil : allowRetention.retention.freshUntil,
      expiresAt: allowRetention.retention.displayUntil,
      context: validationContext.expectedObservationContext,
      sources: [
        { provider: 'hotpepper', recordRef: 'J123456', attribution: 'Fixture', publicUrl: null },
      ],
      retention: {
        ...allowRetention.retention,
        ...(field === 'photos' ? { freshUntil: photoUntil, displayUntil: photoUntil } : {}),
      },
    });
  observation('identity', {
    name: '写真を復元する店',
    area: '渋谷',
    address: null,
    category: null,
    stationName: null,
    accessText: null,
    businessStatus: 'operational',
    sourceUrl: null,
  });
  observation('opening_hours', {
    timeZone: 'UTC',
    intervals: [{ startAt: '2026-09-09T23:00:00Z', endAt: '2026-09-10T01:00:00Z' }],
    weeklyText: ['23:00-01:00'],
    evaluatedAt: NOW,
    listedOpenAtEvaluation: true,
    nextBoundaryAt: '2026-09-10T01:00:00Z',
    lastOrderAt: null,
    lastOrderRaw: null,
  });
  observation('photos', { photos: [{ photoRef, attributions: [], sourceUrl: null }] });
  return { ...fixture, issue, port, outbox, commits, codec };
};

const propose = (fixture: ReturnType<typeof compose>) =>
  respondWith(fixture.composition, {
    kind: 'propose',
    message: ['写真付きの候補です'],
    hero: { candidateId: fixture.currentCandidateId, why: '当時の提案理由' },
    alts: [],
  });

describe('photos across preparation, commit and conversation restoration', () => {
  it('persists prepared tokens before publishing, recovers from SQL and replays without extending expiry', async () => {
    const stub = await setup();
    const delivery = await runInDurableObject(stub, async (_instance, state) => {
      const fixture = compose(state.storage, true);
      expect(await propose(fixture)).toMatchObject({ status: 'committed' });
      // Recovery before getCommittedResponse/completed: only the commit transaction has run.
      const recovered = await new ThreadConversationOutbox(state.storage).read(scope, NOW);
      const part = recovered?.message.parts.find((part) => part.kind === 'card_set');
      if (
        recovered === null ||
        part?.kind !== 'card_set' ||
        part.cards.hero.facts.photos?.status !== 'known'
      )
        throw new Error('PHOTO_SNAPSHOT_MISSING');
      const photo = part.cards.hero.facts.photos.value.photos[0];
      if (photo === undefined) throw new Error('PHOTO_MISSING');
      expect(part.photosExpireAt).toBe(photoUntil);
      expect(part.photoSources).toEqual([
        { candidateId: fixture.currentCandidateId, provider: 'hotpepper', recordRef: 'J123456' },
      ]);
      const live = await fixture.composition.getCommittedResponse();
      expect(live).toMatchObject({
        kind: 'cards',
        cards: {
          hero: {
            facts: {
              photos: {
                status: 'known',
                value: { photos: [{ photoToken: photo.photoToken }] },
              },
            },
          },
        },
      });
      await fixture.composition.getCommittedResponse();
      expect(fixture.issue).toHaveBeenCalledTimes(1);
      const request = fixture.commits[0];
      if (request === undefined) throw new Error('COMMIT_MISSING');
      expect(fixture.port.commit(request)).toMatchObject({
        status: 'committed',
        receipt: { replayed: true },
      });
      fixture.composition.dispose();
      const restoredCodec = createPhotoTokenCodec({
        secret,
        referenceResolver: {
          resolve: () => Promise.resolve(createSqlPhotoReferenceStore(state.storage)),
        },
      });
      expect(
        await restoredCodec.verify(photo.photoToken, { ...SCOPE, deviceId }, NOW),
      ).toMatchObject({
        photoRef,
        expiresAt: photoUntil,
      });
      await expect(
        restoredCodec.verify(photo.photoToken, { ...SCOPE, deviceId: 'foreign' }, NOW),
      ).rejects.toThrow('SCOPE_MISMATCH');
      await expect(
        restoredCodec.verify(photo.photoToken, { ...SCOPE, deviceId }, photoUntil),
      ).rejects.toThrow('EXPIRED');
      const expired = await new ThreadConversationOutbox(state.storage).read(scope, photoUntil);
      expect(expired?.inputFingerprint).toBe(recovered.inputFingerprint);
      expect(JSON.stringify(expired?.message)).not.toContain(photo.photoToken);
      return recovered;
    });
    // The receiving history DB has its own storage and retains the original token/deadline.
    if (!hasThreads(env)) throw new Error('THREADS_MISSING');
    await runInDurableObject(env.THREADS.getByName(crypto.randomUUID()), (_instance, state) => {
      let records = new SqlConversationRecords(state.storage);
      const runs = new SqlConversationRuns(records);
      const conversationScope = {
        ownerScopeRef: scope.ownerScopeRef,
        conversationId: scope.conversationId,
      };
      expect(
        records.create({ ...conversationScope, now: NOW, idempotencyKey: 'create' }),
      ).toMatchObject({ ok: true });
      runs.accept({
        ...scope,
        now: NOW,
        expectedRevision: 1,
        messageId: 'question',
        text: 'お店を探して',
        idempotencyKey: 'send',
        inputFingerprint: 'a'.repeat(64),
      });
      runs.start({ ...scope, now: NOW, threadId: SCOPE.threadId, turnId: context.turnId });
      expect(runs.complete({ ...delivery, now: NOW })).toMatchObject({ ok: true });
      expect(runs.complete({ ...delivery, now: NOW })).toMatchObject({ ok: true, replayed: true });
      records = new SqlConversationRecords(state.storage);
      const page = records.messages({
        ...conversationScope,
        now: NOW,
        beforeSequence: null,
        limit: 50,
      });
      expect(page).toMatchObject({
        ok: true,
        messages: [{ sequence: 1 }, { sequence: 2, message: delivery.message }],
      });
      const expired = records.messages({
        ...conversationScope,
        now: photoUntil,
        beforeSequence: null,
        limit: 50,
      });
      expect(JSON.stringify(expired)).not.toContain('p1.');
      expect(JSON.stringify(expired)).toContain('写真を復元する店');
    });
  });

  it.each([false, true])(
    'keeps the answer when photos are nonpersistent or issuance fails (failure=%s)',
    async (fail) => {
      const stub = await setup();
      await runInDurableObject(stub, async (_instance, state) => {
        const fixture = compose(state.storage, false, fail);
        expect(await propose(fixture)).toMatchObject({ status: 'committed' });
        const stored = await fixture.outbox.read(scope, NOW);
        expect(JSON.stringify(stored?.message)).toContain('写真を復元する店');
        expect(JSON.stringify(stored?.message)).not.toContain('p1.');
        expect(stored?.message.parts).toContainEqual(
          expect.objectContaining({
            photoSources: [
              {
                candidateId: fixture.currentCandidateId,
                provider: 'hotpepper',
                recordRef: 'J123456',
              },
            ],
          }),
        );
        expect(JSON.stringify(stored?.message)).not.toContain('期限が過ぎています');
        const live = await fixture.composition.getCommittedResponse();
        expect(live).toMatchObject({
          kind: 'cards',
          cards: { hero: { facts: { photos: { status: fail ? 'unknown' : 'known' } } } },
        });
        expect(state.storage.sql.exec('SELECT * FROM photo_references').toArray()).toEqual([]);
        fixture.composition.dispose();
      });
    },
  );

  it.each(['cancel', 'revision'])(
    'rejects a turn changed during asynchronous preparation: %s',
    async (change) => {
      const stub = await setup();
      await runInDurableObject(stub, async (_instance, state) => {
        const fixture = compose(state.storage, true);
        const issue = fixture.issue.getMockImplementation();
        if (issue === undefined) throw new Error('ISSUER_MISSING');
        fixture.issue.mockImplementation(async (...args) => {
          const issued = await issue(...args);
          if (change === 'cancel')
            state.storage.sql.exec("UPDATE runtime_turn SET status = 'cancel_requested'");
          else state.storage.sql.exec('UPDATE thread_state SET revision = 2');
          return issued;
        });
        expect(await propose(fixture)).toMatchObject({ status: 'invalid' });
        expect(await fixture.outbox.read(scope, NOW)).toBeNull();
        expect(state.storage.sql.exec('SELECT * FROM runtime_commit').toArray()).toEqual([]);
        expect(await fixture.composition.getCommittedResponse()).toBeUndefined();
        fixture.composition.dispose();
      });
    },
  );
});
