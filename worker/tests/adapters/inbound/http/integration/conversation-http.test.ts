import { SELF, env, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  ConversationResponseSchema,
  ConversationRunResponseSchema,
  ConversationListResponseSchema,
  ConversationMessagesResponseSchema,
} from '@ima/contracts';
import type { ConversationHistoryDO } from '@worker/entrypoints/cloudflare/conversation-history-do';
import { deriveOwnerScopeRef } from '@worker/adapters/in/http/auth';
import { conversationOwnerName } from '@worker/adapters/out/persistence/conversations/durable-conversation-store';

const owner = `${'C'.repeat(42)}E`;
const hasConversations = (
  value: unknown,
): value is Cloudflare.Env & { CONVERSATIONS: DurableObjectNamespace<ConversationHistoryDO> } =>
  typeof value === 'object' && value !== null && 'CONVERSATIONS' in value;
const call = (
  path: string,
  method = 'GET',
  body?: unknown,
  credential = owner,
  requestId = crypto.randomUUID(),
) =>
  SELF.fetch(`https://ima.test/v1/conversations${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-app-token': 'test-app-token',
      'x-device-id': `device-${owner}`,
      'x-ima-owner-credential': credential,
      'x-ima-request-id': requestId,
      'x-app-version': 'conversation-test',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('conversation HTTP ownership and restoration', () => {
  it('creates, lists, restores after eviction, and deletes without exposing owner identifiers', async () => {
    if (!hasConversations(env)) throw new Error('CONVERSATION_BINDING_MISSING');
    const requestId = crypto.randomUUID();
    const key = crypto.randomUUID();
    const created = await call(
      '',
      'POST',
      { schemaVersion: 'v1', requestId, idempotencyKey: key },
      owner,
      requestId,
    );
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const body = v.parse(ConversationResponseSchema, await created.json());
    const scopeOwner = await deriveOwnerScopeRef(owner);
    if (scopeOwner === null) throw new Error('OWNER_MISSING');
    const stub = env.CONVERSATIONS.getByName(conversationOwnerName(scopeOwner));
    await stub.append({
      ownerScopeRef: scopeOwner,
      conversationId: body.conversation.conversationId,
      now: new Date().toISOString(),
      expectedRevision: 1,
      idempotencyKey: 'message-key',
      inputFingerprint: 'a'.repeat(64),
      message: {
        messageId: 'first-message',
        role: 'user',
        source: null,
        parts: [{ kind: 'user_text', text: '静かなカフェが好きです' }],
      },
    });
    await evictDurableObject(stub);
    const listed = v.parse(ConversationListResponseSchema, await (await call('?limit=1')).json());
    expect(listed.conversations[0]).toMatchObject({
      conversationId: body.conversation.conversationId,
      title: '静かなカフェが好きです',
      revision: 2,
    });
    expect(JSON.stringify(listed)).not.toContain(scopeOwner);
    const path = `/${body.conversation.conversationId}`;
    const messages = v.parse(
      ConversationMessagesResponseSchema,
      await (await call(`${path}/messages`)).json(),
    );
    expect(messages.messages.map((item) => item.message.messageId)).toEqual(['first-message']);
    expect((await call(path, 'GET', undefined, `${'D'.repeat(42)}E`)).status).toBe(404);
    expect((await call(path, 'DELETE')).status).toBe(204);
    expect((await call(`${path}/messages`)).status).toBe(404);
    expect((await call(path, 'DELETE')).status).toBe(204);
    expect(
      (
        await call(
          '',
          'POST',
          { schemaVersion: 'v1', requestId, idempotencyKey: key },
          owner,
          requestId,
        )
      ).status,
    ).toBe(404);
  });
  it('cancels an accepted run durably without removing the accepted user message', async () => {
    if (!hasConversations(env)) throw new Error('CONVERSATION_BINDING_MISSING');
    const ownerScopeRef = await deriveOwnerScopeRef(owner);
    if (ownerScopeRef === null) throw new Error('OWNER_MISSING');
    const stub = env.CONVERSATIONS.getByName(conversationOwnerName(ownerScopeRef));
    const scope = { ownerScopeRef, conversationId: crypto.randomUUID() };
    const now = new Date().toISOString();
    await stub.create({ ...scope, now, idempotencyKey: crypto.randomUUID() });
    await stub.accept({
      ...scope,
      now,
      expectedRevision: 1,
      runId: 'cancel-run',
      messageId: 'cancel-message',
      text: '受理後に中断',
      idempotencyKey: 'cancel-send',
      inputFingerprint: 'd'.repeat(64),
    });
    const requestId = crypto.randomUUID();
    const path = `/${scope.conversationId}/runs/cancel-run/cancel`;
    expect(
      (
        await call(
          path,
          'POST',
          { schemaVersion: 'v1', requestId },
          `${'D'.repeat(42)}E`,
          requestId,
        )
      ).status,
    ).toBe(404);
    const result = await call(path, 'POST', { schemaVersion: 'v1', requestId }, owner, requestId);
    expect(result.status).toBe(200);
    expect(v.parse(ConversationRunResponseSchema, await result.json()).run.status).toBe(
      'interrupted',
    );
    await evictDurableObject(stub);
    expect(await stub.readRun({ ...scope, runId: 'cancel-run' })).toMatchObject({
      ok: true,
      run: { status: 'interrupted' },
    });
    expect(await stub.messages({ ...scope, now, limit: 20, beforeSequence: null })).toMatchObject({
      ok: true,
      messages: [{ message: { messageId: 'cancel-message' } }],
    });
  });
  it('rejects invalid pagination, unknown fields, missing auth and malformed paths', async () => {
    for (const path of [
      '?limit=0',
      '?limit=101',
      '?limit=1&limit=2',
      '?owner=someone',
      '?cursor=invalid',
      '/bad%ZZ/messages',
    ])
      expect((await call(path)).status).toBe(400);
    expect((await SELF.fetch('https://ima.test/v1/conversations')).status).toBe(401);
    expect((await call('', 'HEAD')).status).toBe(404);
    const requestId = crypto.randomUUID();
    expect(
      (
        await call(
          '',
          'POST',
          { schemaVersion: 'v1', requestId, idempotencyKey: 'key', ownerScopeRef: 'forged' },
          owner,
          requestId,
        )
      ).status,
    ).toBe(400);
  });
});
