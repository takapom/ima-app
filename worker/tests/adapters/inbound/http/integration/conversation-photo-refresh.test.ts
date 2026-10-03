import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryDO } from '@worker/entrypoints/cloudflare/conversation-history-do';
import { deriveOwnerScopeRef } from '@worker/adapters/in/http/auth';
import { conversationOwnerName } from '@worker/adapters/out/persistence/conversations/durable-conversation-store';
import { routeRequest } from '@worker/adapters/in/http/router';
import { PhotoProviderError } from '@worker/runtime/ports/photo-media';
import type { ConversationPhotoReader } from '@worker/runtime/ports/conversation-photo';
import { ConversationMessageSchema } from '@worker/domain/conversations/conversation-message';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import { makeHarness, makeRequest, ownerCredential } from '../router-fixtures';
import { ConversationMessagesResponseSchema } from '@ima/contracts';
import * as v from 'valibot';

const hasConversations = (
  value: unknown,
): value is {
  CONVERSATIONS: DurableObjectNamespace<ConversationHistoryDO>;
} => typeof value === 'object' && value !== null && 'CONVERSATIONS' in value;
const setup = async () => {
  if (!hasConversations(env)) throw new Error('CONVERSATIONS_MISSING');
  const ownerScopeRef = await deriveOwnerScopeRef(ownerCredential);
  if (ownerScopeRef === null) throw new Error('OWNER_MISSING');
  const scope = { ownerScopeRef, conversationId: crypto.randomUUID() };
  const stub = env.CONVERSATIONS.getByName(conversationOwnerName(ownerScopeRef));
  const now = new Date().toISOString();
  const tomorrow = new Date(Date.parse(now) + 86_400_000).toISOString();
  const retention = {
    retentionDecision: 'allow',
    retentionMode: 'provider_limited',
    sessionExpiresAt: tomorrow,
    freshUntil: tomorrow,
    displayUntil: tomorrow,
    retentionUntil: tomorrow,
    deletionScheduledAt: tomorrow,
    attribution: null,
    restoreMode: 'full',
    policyStatus: 'available',
    displayPolicyStatus: 'available',
  } as const;
  expect(await stub.create({ ...scope, now, idempotencyKey: crypto.randomUUID() })).toMatchObject({
    ok: true,
  });
  expect(
    await stub.append({
      ...scope,
      now,
      expectedRevision: 1,
      idempotencyKey: 'answer',
      inputFingerprint: 'a'.repeat(64),
      message: {
        messageId: 'answer',
        role: 'assistant',
        source: { threadId: 'old-thread', turnId: 'turn', responseId: 'answer' },
        parts: [
          { kind: 'retained_text', text: '提案時の本文', retention },
          {
            kind: 'card_set',
            threadId: 'old-thread',
            revision: 2,
            cardSetId: 'cards',
            photosExpireAt: null,
            cards: {
              hero: {
                candidateId: 'shop',
                facts: {
                  identity: {
                    status: 'known',
                    value: {
                      name: '履歴の店舗',
                      area: '渋谷',
                      address: null,
                      category: null,
                      stationName: null,
                      accessText: null,
                      businessStatus: 'unknown',
                      sourceUrl: 'https://www.hotpepper.jp/strJ123456/',
                    },
                    evidence: [{ evidenceId: 'id', attribution: null, retention }],
                  },
                  photos: { status: 'unknown', reason: '写真を表示できません' },
                },
                why: { text: '当時の理由', retention },
              },
              alts: [],
            },
          },
        ],
      },
    }),
  ).toMatchObject({ ok: true });
  const media = () => ({
    contentType: 'image/jpeg' as const,
    contentLength: 3,
    body: new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1, 2, 3]));
        stream.close();
      },
    }),
  });
  const read = vi
    .fn<ConversationPhotoReader['read']>()
    .mockImplementation(() => Promise.resolve(media()));
  const config = {
    ...makeHarness().config,
    conversations: env.CONVERSATIONS,
    conversationPhotos: { read },
    now: () => now,
  };
  const path = `/v1/conversations/${scope.conversationId}/messages/1/photos/shop`;
  return { stub, scope, read, config, path, now, tomorrow, media };
};

describe('current photos of durable conversation history', () => {
  it('migrates old links, survives eviction and expiry, and leaves proposal/revision unchanged', async () => {
    const { stub, scope, read, config, path, tomorrow } = await setup();
    const original = await stub.read(scope);
    const messagesUrl = `/v1/conversations/${scope.conversationId}/messages`;
    const restored = await routeRequest(makeRequest(messagesUrl), config);
    const body = v.parse(ConversationMessagesResponseSchema, await restored.json());
    expect(body.messages[0]?.message.parts).toContainEqual(
      expect.objectContaining({ photoCandidateIds: ['shop'] }),
    );
    expect(JSON.stringify(body)).not.toContain('recordRef');
    await evictDurableObject(stub);
    const result = await routeRequest(makeRequest(path), { ...config, now: () => tomorrow });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(Date.parse(result.headers.get('expires') ?? '')).toBeLessThanOrEqual(
      Date.parse(tomorrow) + 30 * 60_000,
    );
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(read).toHaveBeenCalledWith('J123456', expect.any(AbortSignal));
    expect(await stub.read(scope)).toEqual(original);
    const expired = await routeRequest(makeRequest(messagesUrl), {
      ...config,
      now: () => tomorrow,
    });
    const expiredBody = v.parse(ConversationMessagesResponseSchema, await expired.json());
    expect(JSON.stringify(expiredBody)).not.toContain('提案時の本文');
    expect(expiredBody.messages[0]?.message.parts).toContainEqual(
      expect.objectContaining({ photoCandidateIds: ['shop'] }),
    );
  });
  it('does not promote an expired legacy link on its first read', async () => {
    const { scope, read, config, path, tomorrow } = await setup();
    const messages = await routeRequest(
      makeRequest(`/v1/conversations/${scope.conversationId}/messages`),
      { ...config, now: () => tomorrow },
    );
    const body = v.parse(ConversationMessagesResponseSchema, await messages.json());
    expect(body.messages[0]?.message.parts).not.toContainEqual(
      expect.objectContaining({ photoCandidateIds: ['shop'] }),
    );
    expect((await routeRequest(makeRequest(path), { ...config, now: () => tomorrow })).status).toBe(
      404,
    );
    expect(read).not.toHaveBeenCalled();
  });
  it('does not promote an expired legacy link during scheduled purge', async () => {
    const { stub, scope } = await setup();
    await runInDurableObject(stub, async (instance, state) => {
      const row = state.storage.sql
        .exec<{ body: string }>(
          'SELECT body FROM conversation_messages WHERE conversation_id = ? AND id = ?',
          scope.conversationId,
          'answer',
        )
        .one();
      const body = v.parse(ConversationMessageSchema, JSON.parse(row.body));
      const deadline = new Date(Date.now() - 1_000).toISOString();
      const expire = (retention: RetentionMetadata): RetentionMetadata => ({
        ...retention,
        sessionExpiresAt: deadline,
        freshUntil: deadline,
        displayUntil: deadline,
        retentionUntil: deadline,
        deletionScheduledAt: deadline,
      });
      for (const part of body.message.parts) {
        if (part.kind === 'retained_text') part.retention = expire(part.retention);
        if (part.kind !== 'card_set') continue;
        if (part.cards.hero.facts.identity.status !== 'known') throw new Error('FIXTURE');
        for (const evidence of part.cards.hero.facts.identity.evidence)
          evidence.retention = expire(evidence.retention);
        part.cards.hero.why.retention = expire(part.cards.hero.why.retention);
      }
      state.storage.sql.exec(
        'UPDATE conversation_messages SET body = ?, expires_at = ? WHERE conversation_id = ? AND id = ?',
        JSON.stringify(body),
        Date.parse(deadline),
        scope.conversationId,
        'answer',
      );

      await instance.alarm();

      const purged = state.storage.sql
        .exec<{ body: string }>(
          'SELECT body FROM conversation_messages WHERE conversation_id = ? AND id = ?',
          scope.conversationId,
          'answer',
        )
        .one().body;
      expect(purged).not.toContain('J123456');
      expect(purged).not.toContain('photoSources');
    });
  });
  it('rejects foreign owners, unknown candidates, invalid sequences and deleted conversations before provider access', async () => {
    const { stub, scope, read, config, path } = await setup();
    expect(
      (
        await routeRequest(
          makeRequest(path, { headers: { 'X-Ima-Owner-Credential': `${'C'.repeat(42)}E` } }),
          config,
        )
      ).status,
    ).toBe(404);
    expect(
      (await routeRequest(makeRequest(path.replace('/photos/shop', '/photos/other')), config))
        .status,
    ).toBe(404);
    expect(
      (await routeRequest(makeRequest(path.replace('/messages/1/', '/messages/0/')), config))
        .status,
    ).toBe(400);
    expect(
      (await routeRequest(makeRequest(path.replace('/messages/1/', '/messages/2/')), config))
        .status,
    ).toBe(404);
    await stub.remove(scope);
    expect((await routeRequest(makeRequest(path), config)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
  it('distinguishes missing photos and provider failure without damaging saved text', async () => {
    const { read, config, path, scope } = await setup();
    read.mockResolvedValueOnce(null);
    expect((await routeRequest(makeRequest(path), config)).status).toBe(404);
    read.mockRejectedValueOnce(new PhotoProviderError('TIMEOUT'));
    expect((await routeRequest(makeRequest(path), config)).status).toBe(504);
    read.mockRejectedValueOnce(new PhotoProviderError('RATE_LIMITED', 2_000));
    expect((await routeRequest(makeRequest(path), config)).status).toBe(429);
    const messages = await routeRequest(
      makeRequest(`/v1/conversations/${scope.conversationId}/messages`),
      config,
    );
    expect(await messages.text()).toContain('提案時の本文');
  });
  it('cancels the image when the conversation is deleted while the provider is responding', async () => {
    const { stub, scope, read, config, path } = await setup();
    const cancel = vi.fn();
    read.mockImplementationOnce(async () => {
      await stub.remove(scope);
      return {
        contentType: 'image/png',
        contentLength: null,
        body: new ReadableStream({ cancel }),
      };
    });
    expect((await routeRequest(makeRequest(path), config)).status).toBe(404);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
