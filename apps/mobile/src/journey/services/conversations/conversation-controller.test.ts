import { describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  ConversationMessage,
  ConversationRunResponse,
  ConversationTurnRequest,
} from '@ima/contracts';
import type { ConversationClient } from '@mobile/platform/http/conversation-client';
import { ConversationController } from '@mobile/journey/services/conversations/conversation-controller';
import type { ApiResult } from '@mobile/platform/http/api';

const now = '2026-09-21T10:00:00.000Z';
const conversation = (id: string): Conversation => ({
  conversationId: id,
  title: id,
  revision: 1,
  lastSequence: 0,
  createdAt: now,
  updatedAt: now,
});
const message = (id: string): ConversationMessage => ({
  conversationId: id,
  sequence: 1,
  createdAt: now,
  message: {
    messageId: `message-${id}`,
    role: 'user',
    source: null,
    parts: [{ kind: 'user_text', text: id }],
  },
});
const run = (
  id: string,
  status: 'accepted' | 'completed' = 'accepted',
): ConversationRunResponse => ({
  schemaVersion: 'v1',
  requestId: 'request',
  conversation: {
    ...conversation(id),
    revision: status === 'completed' ? 3 : 2,
    lastSequence: status === 'completed' ? 2 : 1,
  },
  response: null,
  run: {
    runId: `run-${id}`,
    conversationId: id,
    userMessageId: `message-${id}`,
    inputSequence: 1,
    status,
    createdAt: now,
    updatedAt: now,
    threadId: status === 'completed' ? `thread-${id}` : null,
    turnId: status === 'completed' ? `turn-${id}` : null,
    assistantMessageId: status === 'completed' ? `answer-${id}` : null,
    failure: null,
  },
});
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data, requestId: 'request' });
const input: ConversationTurnRequest = {
  schemaVersion: 'v1',
  requestId: 'request',
  clientMessageId: 'message-a',
  expectedRevision: 1,
  text: 'a',
  clientNow: now,
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: null,
    budget: 'normal',
  },
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: 'send-a',
};
const client = (): ConversationClient => ({
  create: () =>
    Promise.resolve(
      ok({
        schemaVersion: 'v1',
        requestId: 'request',
        conversation: conversation('a'),
        activeRun: null,
      }),
    ),
  list: () =>
    Promise.resolve(
      ok({
        schemaVersion: 'v1',
        requestId: 'request',
        conversations: [conversation('a'), conversation('b')],
        nextCursor: null,
      }),
    ),
  get: (id) =>
    Promise.resolve(
      ok({
        schemaVersion: 'v1',
        requestId: 'request',
        conversation: conversation(id),
        activeRun: null,
      }),
    ),
  messages: (id) =>
    Promise.resolve(
      ok({
        schemaVersion: 'v1',
        requestId: 'request',
        messages: [message(id)],
        nextBeforeSequence: null,
      }),
    ),
  send: (id) => Promise.resolve(ok(run(id, 'completed'))),
  run: (id) => Promise.resolve(ok(run(id, 'completed'))),
  remove: () => Promise.resolve(ok(null)),
  cancel: (id) => Promise.resolve(ok(run(id, 'completed'))),
  watch: () => Promise.resolve(),
});
const make = (api: ConversationClient) =>
  new ConversationController({
    client: api,
    id: () => 'stable-id',
    now: () => now,
    onDisplay: () => {},
  });

describe('conversation controller', () => {
  it('restores a conversation, continues at its saved revision, deletes it, and starts empty', async () => {
    const restored = { ...conversation('a'), revision: 3, lastSequence: 2 };
    const oldAnswer: ConversationMessage = {
      ...message('a'),
      sequence: 2,
      message: {
        messageId: 'old-answer',
        role: 'assistant',
        source: { threadId: 'old-thread', turnId: 'old-turn', responseId: 'old-response' },
        parts: [{ kind: 'unavailable', reason: 'expired' }],
      },
    };
    const next = run('a', 'completed');
    const completed: ConversationRunResponse = {
      ...next,
      conversation: { ...restored, revision: 5, lastSequence: 4 },
      run: { ...next.run, inputSequence: 3, userMessageId: 'follow-up' },
    };
    const api = client();
    const create = vi.fn<ConversationClient['create']>((...args) => api.create(...args));
    const send = vi.fn<ConversationClient['send']>().mockResolvedValue(ok(completed));
    const remove = vi.fn<ConversationClient['remove']>((...args) => api.remove(...args));
    const removeCache = vi.fn();
    const writeCache = vi.fn();
    const controller = new ConversationController({
      client: {
        ...client(),
        create,
        send,
        remove,
        get: () =>
          Promise.resolve(
            ok({
              schemaVersion: 'v1',
              requestId: 'request',
              conversation: restored,
              activeRun: null,
            }),
          ),
        messages: () =>
          Promise.resolve(
            ok({
              schemaVersion: 'v1',
              requestId: 'request',
              messages: [message('a'), oldAnswer],
              nextBeforeSequence: null,
            }),
          ),
      },
      cache: {
        list: () => [restored],
        messages: () => [],
        write: writeCache,
        remove: removeCache,
        cleanup: () => {},
      },
      id: () => 'new-id',
      now: () => now,
      onDisplay: () => {},
    });
    await controller.activate();
    await controller.select('a');
    expect(controller.getSnapshot().messages).toEqual([message('a'), oldAnswer]);
    await controller.submit({ ...input, text: 'その条件で続けて', clientMessageId: 'follow-up' });
    expect(create).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.slice(0, 2)).toEqual([
      'a',
      expect.objectContaining({ expectedRevision: 3, text: 'その条件で続けて' }),
    ]);
    expect(controller.getSnapshot().messages.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(writeCache).toHaveBeenCalled();
    await controller.remove('a');
    expect(remove).toHaveBeenCalledWith('a');
    expect(removeCache).toHaveBeenCalledWith('a');
    expect(controller.getSnapshot()).toMatchObject({ selected: null, messages: [], run: null });
    await controller.select('b');
    controller.newConversation();
    expect(controller.getSnapshot()).toMatchObject({ selected: null, messages: [], run: null });
    controller.dispose();
  });
  it('queries an accepted run after a stream disconnect without sending it again', async () => {
    const accepted = run('a');
    const send = vi.fn<ConversationClient['send']>().mockResolvedValue(ok(accepted));
    const readRun = vi.fn<ConversationClient['run']>().mockResolvedValue(ok(accepted));
    const controller = make({
      ...client(),
      send,
      run: readRun,
      watch: () => Promise.reject(new Error('CONNECTION_LOST')),
    });
    await controller.select('a');
    await controller.submit(input);
    expect(readRun).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ pending: false, run: accepted.run });
    await controller.submit({ ...input, clientMessageId: 'second', idempotencyKey: 'second' });
    expect(send).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().error).toContain('処理中');
    controller.dispose();
  });
  it('ignores a completed stream from a conversation selected before the current one', async () => {
    let finish: (() => void) | undefined;
    let frame: ((value: ConversationRunResponse) => void) | undefined;
    const api = client();
    const controller = make({
      ...api,
      send: (id) => Promise.resolve(ok(run(id))),
      watch: async (_id, _run, receive) => {
        frame = receive;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    await controller.activate();
    await controller.select('a');
    const pending = controller.submit(input);
    await vi.waitFor(() => expect(frame).toBeDefined());
    await controller.select('b');
    frame?.(run('a', 'completed'));
    finish?.();
    await pending;
    expect(controller.getSnapshot().selected?.conversationId).toBe('b');
    expect(controller.getSnapshot().messages).toEqual([message('b')]);
    expect(controller.getSnapshot().run).toBeNull();
    controller.dispose();
  });
  it('reuses the exact request after an ambiguous transport failure', async () => {
    const send = vi
      .fn<ConversationClient['send']>()
      .mockResolvedValueOnce({ ok: false, requestId: 'request', error: { kind: 'offline' } })
      .mockResolvedValueOnce(ok(run('a', 'completed')));
    const controller = make({ ...client(), send });
    await controller.select('a');
    await controller.submit(input);
    expect(controller.getSnapshot().error).toContain('送信');
    await controller.retry();
    expect(send.mock.calls[0]?.[1]).toEqual(send.mock.calls[1]?.[1]);
    expect(controller.getSnapshot().run?.status).toBe('completed');
    controller.dispose();
  });
  it('retries creation with the same key and retains the draft until accepted', async () => {
    const create = vi
      .fn<ConversationClient['create']>()
      .mockResolvedValueOnce({ ok: false, requestId: 'request', error: { kind: 'offline' } })
      .mockResolvedValueOnce(
        ok({
          schemaVersion: 'v1',
          requestId: 'request',
          conversation: conversation('a'),
          activeRun: null,
        }),
      );
    const send = vi.fn<ConversationClient['send']>().mockResolvedValue(ok(run('a', 'completed')));
    const controller = make({ ...client(), create, send });
    await controller.submit(input);
    await controller.retry();
    expect(create.mock.calls[0]?.[0].idempotencyKey).toBe(create.mock.calls[1]?.[0].idempotencyKey);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1].text).toBe('a');
    controller.dispose();
  });
  it('keeps list failures distinct from a successfully empty list', async () => {
    const controller = make({
      ...client(),
      list: () => Promise.resolve({ ok: false, requestId: 'request', error: { kind: 'offline' } }),
    });
    await controller.activate();
    expect(controller.getSnapshot().listError).toBe(true);
    controller.dispose();
  });
});
