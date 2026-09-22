import { describe, expect, it } from 'vitest';
import { createMemoryConversationStore } from '@worker/adapters/out/persistence/conversations/memory-conversation-store';
import type {
  AppendConversationMessageInput,
  ConversationStore,
} from '@worker/application/ports/conversation-store';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';

const now = '2026-09-21T10:00:00.000Z';
const expiresAt = '2026-09-21T20:00:00.000Z';
const scope = { ownerScopeRef: 'owner-a', conversationId: 'conversation-a' };
const createInput = { ...scope, now, idempotencyKey: 'create-a' };
const userInput = (number = 1): AppendConversationMessageInput => ({
  ...scope,
  now,
  expectedRevision: number,
  idempotencyKey: `append-${number}`,
  inputFingerprint: number.toString(16).padStart(64, '0'),
  message: {
    messageId: `message-${number}`,
    role: 'user',
    source: null,
    parts: [
      { kind: 'user_text', text: number === 1 ? '恵比寿でカフェを探したい' : `発言${number}` },
    ],
  },
});
const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: expiresAt,
  freshUntil: null,
  displayUntil: expiresAt,
  retentionUntil: expiresAt,
  deletionScheduledAt: expiresAt,
  attribution: { label: 'Provider', sourceLink: 'https://example.com/' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};
const assistantInput = (): AppendConversationMessageInput => ({
  ...userInput(2),
  message: {
    messageId: 'message-2',
    role: 'assistant',
    source: { threadId: 'thread-a', turnId: 'turn-a', responseId: 'response-a' },
    parts: [{ kind: 'retained_text', text: '保存期限付きの提案', retention }],
  },
});
const readMessages = (store: ConversationStore, at = now, beforeSequence: number | null = null) =>
  store.messages({ ...scope, now: at, limit: 2, beforeSequence });
const initialized = async () => {
  const store = createMemoryConversationStore();
  expect((await store.create(createInput)).ok).toBe(true);
  return store;
};

describe('conversation store', () => {
  it('creates once, preserves creation on replay, and derives its title from the first user input', async () => {
    const store = await initialized();
    expect(await store.create({ ...createInput, now: expiresAt })).toMatchObject({
      ok: true,
      replayed: true,
      conversation: { revision: 1, createdAt: now },
    });
    expect(await store.append(userInput())).toMatchObject({
      ok: true,
      replayed: false,
      conversation: { title: '恵比寿でカフェを探したい', revision: 2 },
      message: { sequence: 1 },
    });
    expect(await store.append(userInput(2))).toMatchObject({
      ok: true,
      conversation: { title: '恵比寿でカフェを探したい', revision: 3 },
      message: { sequence: 2 },
    });
  });

  it('isolates all reads and writes by owner', async () => {
    const store = await initialized();
    await store.append(userInput());
    const foreign = { ...scope, ownerScopeRef: 'owner-b' };
    expect(await store.read(foreign)).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await store.append({ ...userInput(), ...foreign })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await store.messages({ ...foreign, now, limit: 10, beforeSequence: null })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await store.list({ ownerScopeRef: 'owner-b', before: null, limit: 10 })).toEqual({
      ok: true,
      conversations: [],
      nextCursor: null,
    });
    expect(await store.remove(foreign)).toEqual({ ok: true, deleted: false });
    expect((await store.read(scope)).ok).toBe(true);
  });

  it('replays the same message before revision checks and rejects changed input', async () => {
    const store = await initialized();
    await store.append(userInput());
    expect(await store.append(userInput())).toMatchObject({ ok: true, replayed: true });
    expect(await store.append({ ...userInput(), inputFingerprint: 'b'.repeat(64) })).toEqual({
      ok: false,
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await store.append({ ...userInput(), idempotencyKey: 'different-key' })).toEqual({
      ok: false,
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await readMessages(store)).toMatchObject({ messages: [{ sequence: 1 }] });
  });

  it('admits only one concurrent append at the same revision', async () => {
    const store = await initialized();
    const results = await Promise.all([
      store.append(userInput()),
      store.append({ ...userInput(2), expectedRevision: 1 }),
    ]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(results[1]).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
  });

  it('pages messages in stable chronological order and returns the older-page boundary', async () => {
    const store = await initialized();
    for (let index = 1; index <= 5; index += 1) await store.append(userInput(index));
    const latest = await readMessages(store);
    expect(latest).toMatchObject({
      messages: [{ sequence: 4 }, { sequence: 5 }],
      nextBeforeSequence: 4,
    });
    expect(await readMessages(store, now, 4)).toMatchObject({
      messages: [{ sequence: 2 }, { sequence: 3 }],
      nextBeforeSequence: 2,
    });
    expect(await readMessages(store, now, 2)).toMatchObject({
      messages: [{ sequence: 1 }],
      nextBeforeSequence: null,
    });
  });

  it('uses the conversation ID as the tie-breaker for equal update times', async () => {
    const store = await initialized();
    await store.create({
      ...createInput,
      conversationId: 'conversation-b',
      idempotencyKey: 'create-b',
    });
    await store.create({
      ...createInput,
      conversationId: 'conversation-c',
      idempotencyKey: 'create-c',
    });
    const page = await store.list({ ownerScopeRef: scope.ownerScopeRef, limit: 2, before: null });
    if (!page.ok) throw new Error('expected page');
    expect(page.conversations.map((conversation) => conversation.conversationId)).toEqual([
      'conversation-c',
      'conversation-b',
    ]);
    const next = await store.list({
      ownerScopeRef: scope.ownerScopeRef,
      limit: 2,
      before: page.nextCursor,
    });
    expect(next).toMatchObject({
      conversations: [{ conversationId: 'conversation-a' }],
      nextCursor: null,
    });
  });

  it('removes expired answer text on reads and retries without deleting user speech or renewing deadlines', async () => {
    const store = await initialized();
    await store.append(userInput());
    await store.append(assistantInput());
    expect(await readMessages(store, expiresAt)).toMatchObject({
      messages: [
        { message: { parts: [{ kind: 'user_text', text: '恵比寿でカフェを探したい' }] } },
        { message: { parts: [{ kind: 'unavailable', reason: 'expired' }] } },
      ],
    });
    expect(await store.append({ ...assistantInput(), now: expiresAt })).toMatchObject({
      ok: true,
      replayed: true,
      message: { message: { parts: [{ kind: 'unavailable', reason: 'expired' }] } },
    });
    expect(JSON.stringify(await readMessages(store))).not.toContain('保存期限付きの提案');
  });

  it('scrubs content before storage when its display deadline already passed', async () => {
    const store = await initialized();
    await store.append(userInput());
    expect(await store.append({ ...assistantInput(), now: expiresAt })).toMatchObject({
      message: { message: { parts: [{ kind: 'unavailable', reason: 'expired' }] } },
    });
    expect(JSON.stringify(await readMessages(store))).not.toContain('保存期限付きの提案');
  });

  it('does not resurrect deleted conversations on create replay or late append', async () => {
    const store = await initialized();
    await store.append(userInput());
    expect(await store.remove(scope)).toEqual({ ok: true, deleted: true });
    expect(await store.remove(scope)).toEqual({ ok: true, deleted: false });
    expect(await store.append(userInput())).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await store.create(createInput)).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await store.create({ ...createInput, idempotencyKey: 'another-create' })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
  });

  it('does not expose mutable storage through inputs or returned values', async () => {
    const store = await initialized();
    const input = userInput();
    const result = await store.append(input);
    input.message.parts.length = 0;
    if (!result.ok) throw new Error('expected append');
    Object.assign(result.conversation, { title: 'modified' });
    result.message.message.parts.length = 0;
    expect(await readMessages(store)).toMatchObject({
      messages: [{ message: { parts: [{ text: '恵比寿でカフェを探したい' }] } }],
    });
    expect(await store.read(scope)).toMatchObject({
      conversation: { title: '恵比寿でカフェを探したい' },
    });
  });

  it('rejects invalid paging, fingerprints and backdated writes', async () => {
    const store = await initialized();
    expect(
      await store.list({ ownerScopeRef: scope.ownerScopeRef, limit: 101, before: null }),
    ).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await store.append({ ...userInput(), inputFingerprint: 'raw body' })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await store.append({ ...userInput(), now: '2026-09-20T10:00:00.000Z' })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });
});
