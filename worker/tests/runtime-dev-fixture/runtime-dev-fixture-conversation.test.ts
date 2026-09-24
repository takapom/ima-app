import { SELF, env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  ConversationResponseSchema,
  ConversationRunResponseSchema,
  ConversationMessagesResponseSchema,
  type ConversationTurnRequest,
} from '@ima/contracts';
import type { ThreadDO } from './runtime-dev-llm';
import type { ConversationHistoryDO } from '@worker/entrypoints/cloudflare/conversation-history-do';
import { conversationOwnerName } from '@worker/adapters/out/persistence/conversations/durable-conversation-store';
import { deriveOwnerScopeRef } from '@worker/adapters/in/http/auth';

const owner = `${'G'.repeat(42)}E`;
const hasBindings = (
  value: unknown,
): value is Cloudflare.Env & {
  THREADS: DurableObjectNamespace<ThreadDO>;
  CONVERSATIONS: DurableObjectNamespace<ConversationHistoryDO>;
} => typeof value === 'object' && value !== null && 'THREADS' in value && 'CONVERSATIONS' in value;
const call = (path: string, requestId: string, body?: unknown, method?: string) =>
  SELF.fetch(`https://ima.dev/v1/conversations${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      'content-type': 'application/json',
      'x-app-token': 'dev-fixture-app-token',
      'x-ima-owner-credential': owner,
      'x-device-id': 'conversation-runtime-device',
      'x-ima-request-id': requestId,
      'x-app-version': 'conversation-runtime',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const turn = (requestId: string, revision: number): ConversationTurnRequest => ({
  schemaVersion: 'v1',
  requestId,
  expectedRevision: revision,
  clientMessageId: `message-${requestId}`,
  text: '恵比寿で24時間営業のカフェを探して',
  clientNow: new Date().toISOString(),
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    areaText: '恵比寿',
    budget: 'normal',
  },
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: `key-${requestId}`,
});
const send = async (conversationId: string, revision: number) => {
  const requestId = crypto.randomUUID();
  const input = turn(requestId, revision);
  const accepted = await call(`/${conversationId}/turns`, requestId, input);
  expect(accepted.status).toBe(202);
  let state = v.parse(ConversationRunResponseSchema, await accepted.json());
  for (let count = 0; count < 100 && ['accepted', 'running'].includes(state.run.status); count++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = v.parse(
      ConversationRunResponseSchema,
      await (await call(`/${conversationId}/runs/${state.run.runId}`, crypto.randomUUID())).json(),
    );
  }
  expect(state.run.status).toBe('completed');
  expect(state.response).not.toBeNull();
  const replay = v.parse(
    ConversationRunResponseSchema,
    await (await call(`/${conversationId}/turns`, requestId, input)).json(),
  );
  expect(replay.run.runId).toBe(state.run.runId);
  return state;
};
describe('conversation runtime with the real Think SDK and fixture model', () => {
  it('persists both roles, reuses a live thread, and resumes with a new thread after session expiry', async () => {
    if (!hasBindings(env)) throw new Error('CONVERSATION_BINDINGS_MISSING');
    const requestId = crypto.randomUUID();
    const created = v.parse(
      ConversationResponseSchema,
      await (
        await call('', requestId, { schemaVersion: 'v1', requestId, idempotencyKey: requestId })
      ).json(),
    );
    const id = created.conversation.conversationId;
    const first = await send(id, 1);
    const second = await send(id, first.conversation.revision);
    expect(second.run.threadId).toBe(first.run.threadId);
    if (second.run.threadId === null) throw new Error('THREAD_MISSING');
    const ownerRef = await deriveOwnerScopeRef(owner);
    if (ownerRef === null) throw new Error('OWNER_MISSING');
    await evictDurableObject(env.CONVERSATIONS.getByName(conversationOwnerName(ownerRef)));
    const messages = v.parse(
      ConversationMessagesResponseSchema,
      await (await call(`/${id}/messages`, crypto.randomUUID())).json(),
    );
    expect(messages.messages.map((item) => item.message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    const thread = env.THREADS.getByName(second.run.threadId);
    await runInDurableObject(thread, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE runtime_retention_anchor SET thread_created_at = '2020-01-01T00:00:00.000Z'",
      );
    });
    await evictDurableObject(thread);
    const third = await send(id, second.conversation.revision);
    expect(third.run.threadId).not.toBe(second.run.threadId);
    const events = await call(`/${id}/runs/${third.run.runId}/events`, crypto.randomUUID());
    expect(events.headers.get('content-type')).toContain('text/event-stream');
    expect(await events.text()).toContain('"status":"completed"');
    expect((await call(`/${id}`, crypto.randomUUID(), undefined, 'DELETE')).status).toBe(204);
    expect((await call(`/${id}/messages`, crypto.randomUUID())).status).toBe(404);
    if (third.run.threadId === null) throw new Error('THREAD_MISSING');
    expect(await env.THREADS.getByName(third.run.threadId).read(ownerRef)).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
  }, 30_000);
});
