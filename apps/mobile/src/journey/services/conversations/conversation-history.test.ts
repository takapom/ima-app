import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationMessage } from '@ima/contracts';
import type { ApiResult } from '@mobile/platform/http/api';
import type { ConversationClient } from '@mobile/platform/http/conversation-client';
import { createConversationCache } from '@mobile/platform/sqlite/conversations';
import { ConversationHistory } from '@mobile/journey/services/conversations/conversation-history';
import { ConversationController } from '@mobile/journey/services/conversations/conversation-controller';

const now = '2026-09-22T10:00:00Z';
const conversation = (id: string): Conversation => ({
  conversationId: id,
  title: id,
  createdAt: now,
  updatedAt: now,
  revision: 121,
  lastSequence: 120,
});
const records = (id: string): ConversationMessage[] =>
  Array.from({ length: 120 }, (_, index) => ({
    conversationId: id,
    sequence: index + 1,
    createdAt: now,
    message: {
      messageId: `m-${index}`,
      role: 'user',
      source: null,
      parts: [{ kind: 'user_text', text: `発言${index}` }],
    },
  }));
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data, requestId: 'request' });
const setup = () => {
  const db = new DatabaseSync(':memory:');
  let cacheNow = now;
  const cache = createConversationCache(
    {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const statement = db.prepare(sql);
        return {
          run: (...args) => {
            statement.run(...args);
          },
          all: (...args) => statement.all(...args),
          get: (...args) => statement.get(...args),
        };
      },
    },
    { now: () => cacheNow },
  );
  const recent = ['d', 'c', 'b'].map(conversation);
  const messages = vi.fn<ConversationClient['messages']>((id, before) => {
    const eligible = records(id).filter(
      (message) => before === null || before === undefined || message.sequence < before,
    );
    const page = eligible.slice(-50);
    return Promise.resolve(
      ok({
        schemaVersion: 'v1',
        requestId: 'request',
        messages: page,
        nextBeforeSequence: eligible.length > 50 ? (page[0]?.sequence ?? null) : null,
      }),
    );
  });
  const client: ConversationClient = {
    messages,
    get: vi.fn((id: string) =>
      Promise.resolve(
        ok({
          schemaVersion: 'v1' as const,
          requestId: 'request',
          conversation: conversation(id),
          activeRun: null,
        }),
      ),
    ),
    list: vi.fn(() =>
      Promise.resolve(
        ok({
          schemaVersion: 'v1' as const,
          requestId: 'request',
          conversations: recent,
          nextCursor: null,
        }),
      ),
    ),
    create: vi.fn(),
    send: vi.fn(),
    run: vi.fn(),
    watch: vi.fn(),
    cancel: vi.fn(),
    remove: vi.fn(),
  };
  const history = new ConversationHistory(client, cache);
  return {
    db,
    cache,
    recent,
    messages,
    client,
    history,
    advance: (at: string) => {
      cacheNow = at;
    },
  };
};

describe('recent conversation cache hydration', () => {
  it('drains every expired cache batch while preserving message identities', async () => {
    const { db, cache, history, advance } = setup();
    try {
      const until = '2026-09-22T11:00:00Z';
      cache.setRecent([conversation('d')]);
      const expired: ConversationMessage[] = records('d').map((record) => ({
        ...record,
        message: {
          ...record.message,
          role: 'assistant',
          source: { threadId: 'thread', turnId: 'turn', responseId: 'response' },
          parts: [
            {
              kind: 'retained_text',
              text: '物理削除する回答',
              retention: {
                retentionDecision: 'allow',
                retentionMode: 'session_only',
                sessionExpiresAt: until,
                freshUntil: until,
                displayUntil: until,
                retentionUntil: until,
                deletionScheduledAt: until,
                attribution: null,
                restoreMode: 'full',
                policyStatus: 'available',
                displayPolicyStatus: 'available',
              },
            },
          ],
        },
      }));
      for (let page = 0; page < expired.length; page += 50)
        cache.write(conversation('d'), expired.slice(page, page + 50));
      advance(until);
      await history.purge();
      expect(
        JSON.stringify(db.prepare('SELECT body FROM conversation_message_cache').all()),
      ).not.toContain('物理削除する回答');
      expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_message_cache').get()).toEqual({
        count: 120,
      });
      expect(cache.page('d').messages[0]?.message.parts).toEqual([
        { kind: 'unavailable', reason: 'expired' },
      ]);
    } finally {
      history.dispose();
      db.close();
    }
  });

  it('caches all 120 messages in each of three conversations, pages display and avoids unchanged downloads', async () => {
    const { db, cache, recent, history, messages } = setup();
    try {
      await history.prefetch(recent);
      expect(messages).toHaveBeenCalledTimes(9);
      expect(cache.completeRevision('d')).toBe(121);
      expect(db.prepare('SELECT COUNT(*) AS count FROM conversation_message_cache').get()).toEqual({
        count: 360,
      });
      const page = await history.page(conversation('d'), null, new AbortController().signal);
      expect(page.messages).toHaveLength(50);
      expect(page.messages[0]?.sequence).toBe(71);
      expect(page.nextBeforeSequence).toBe(71);
      expect(cache.page('d', 21).messages).toHaveLength(20);
      await history.prefetch(recent);
      expect(messages).toHaveBeenCalledTimes(9);
    } finally {
      history.dispose();
      db.close();
    }
  });
  it('fetches older conversations on every open and promotes only the server-updated top three', async () => {
    const { db, cache, recent, history, messages } = setup();
    try {
      await history.prefetch(recent);
      for (let open = 0; open < 2; open++) {
        const page = await history.page(conversation('a'), null, new AbortController().signal);
        cache.write(conversation('a'), page.messages);
      }
      expect(messages).toHaveBeenCalledTimes(11);
      expect(cache.page('a').messages).toEqual([]);
      const promoted = { ...conversation('a'), updatedAt: '2026-09-22T10:01:00Z' };
      await history.prefetch([promoted, conversation('d'), conversation('c')]);
      expect(cache.list().map((item) => item.conversationId)).toEqual(['a', 'd', 'c']);
      expect(cache.page('b').messages).toEqual([]);
      expect(cache.completeRevision('b')).toBeNull();
      expect(cache.completeRevision('a')).toBe(121);
    } finally {
      history.dispose();
      db.close();
    }
  });
  it('keeps interrupted hydration incomplete and resumes safely on retry', async () => {
    const { db, cache, recent, history, messages } = setup();
    try {
      const original = messages.getMockImplementation();
      if (original === undefined) throw new Error('FIXTURE_MISSING');
      messages.mockImplementation((id, before, options) =>
        before === 71 ? Promise.reject(new Error('OFFLINE')) : original(id, before, options),
      );
      await expect(history.prefetch(recent)).rejects.toThrow('OFFLINE');
      expect(cache.page('d').messages).toHaveLength(50);
      expect(cache.completeRevision('d')).toBeNull();
      cache.markComplete(conversation('d'));
      expect(cache.completeRevision('d')).toBeNull();
      messages.mockImplementation(original);
      await history.prefetch(recent);
      expect(cache.completeRevision('d')).toBe(121);
    } finally {
      history.dispose();
      db.close();
    }
  });
  it('does not mark a changed revision complete and never lets a late old prefetch restore an evicted conversation', async () => {
    const { db, cache, recent, history, client, messages } = setup();
    try {
      client.get = (id) =>
        Promise.resolve(
          ok({
            schemaVersion: 'v1',
            requestId: 'request',
            conversation: { ...conversation(id), revision: 122 },
            activeRun: null,
          }),
        );
      await history.prefetch(recent);
      expect(cache.completeRevision('d')).toBeNull();
      const pending: {
        resolve?: (value: Awaited<ReturnType<ConversationClient['messages']>>) => void;
      } = {};
      messages.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            pending.resolve = resolve;
          }),
      );
      const old = history.prefetch(recent);
      await Promise.resolve();
      await history.prefetch([]);
      pending.resolve?.(
        ok({
          schemaVersion: 'v1',
          requestId: 'request',
          messages: records('d').slice(-50),
          nextBeforeSequence: 71,
        }),
      );
      await old;
      expect(cache.list()).toEqual([]);
      expect(cache.page('d').messages).toEqual([]);
    } finally {
      history.dispose();
      db.close();
    }
  });
  it('restores from a matching complete cache, checks server revision, and fetches when it changes', async () => {
    const { db, cache, recent, history, client, messages } = setup();
    const controller = new ConversationController({
      client,
      cache,
      now: () => now,
      id: () => 'id',
      onDisplay: () => {},
    });
    try {
      await history.prefetch(recent);
      messages.mockClear();
      await controller.select('d');
      expect(messages).not.toHaveBeenCalled();
      expect(controller.getSnapshot().messages).toHaveLength(50);
      await controller.older();
      expect(controller.getSnapshot().messages).toHaveLength(100);
      expect(messages).not.toHaveBeenCalled();
      client.get = (id) =>
        Promise.resolve(
          ok({
            schemaVersion: 'v1',
            requestId: 'request',
            conversation: { ...conversation(id), revision: 122 },
            activeRun: null,
          }),
        );
      await controller.select('d');
      expect(messages).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
      history.dispose();
      db.close();
    }
  });
});
