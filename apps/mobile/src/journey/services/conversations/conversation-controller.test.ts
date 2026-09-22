import { describe, expect, it, vi } from 'vitest';
import type {
  AssistantResponse,
  Conversation,
  ConversationMessage,
  ConversationRunResponse,
  ConversationTurnRequest,
} from '@ima/contracts';
import type { ConversationClient } from '@mobile/platform/http/conversation-client';
import { ConversationController } from '@mobile/journey/services/conversations/conversation-controller';
import type { ApiResult } from '@mobile/platform/http/api';
import { projectAssistantResponseState } from '@mobile/journey/state/assistant-response-projection';
import { selectAssistantMessageRecords } from '@mobile/journey/state/assistant-response';
import { conversationTranscriptEntries } from '@mobile/journey/services/conversations/conversation-transcript';

const liveAnswer = (): AssistantResponse => {
  const text = {
    text: 'その場で表示できる回答',
    basis: 'conversational' as const,
    evidence: [],
    evidenceIds: [],
    retention: {
      retentionDecision: 'deny' as const,
      retentionMode: 'session_only' as const,
      sessionExpiresAt: '2026-09-21T11:00:00Z',
      freshUntil: null,
      displayUntil: '2026-09-21T11:00:00Z',
      retentionUntil: null,
      deletionScheduledAt: null,
      attribution: null,
      restoreMode: 'reference_only' as const,
      policyStatus: 'policy_withheld' as const,
      displayPolicyStatus: 'available' as const,
    },
  };
  return {
    schemaVersion: 'v1',
    threadId: 'thread-a',
    turnId: 'turn-a',
    responseId: 'response-a',
    revision: 2,
    kind: 'cards',
    presentation: 'replace',
    cardSetId: 'cards-a',
    message: [text],
    cards: {
      hero: {
        candidateId: 'candidate',
        facts: { identity: { status: 'unknown', reason: 'fixture' } },
        why: text,
      },
      alts: [],
    },
  };
};

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
  it('retains live text and cards on same-conversation refresh, still expires them, and clears on a different conversation', async () => {
    const controller = make({
      ...client(),
      send: () => Promise.resolve(ok({ ...run('a', 'completed'), response: liveAnswer() })),
    });
    await controller.activate();
    await controller.select('a');
    await controller.submit(input);
    const response = controller.getSnapshot().responseState;
    expect(response?.cards).not.toBeNull();
    controller.expire();
    await controller.select('a');
    expect(controller.getSnapshot().responseState).toBe(response);
    if (response === null) throw new Error('MISSING_RESPONSE');
    const expired = projectAssistantResponseState(response, '2026-09-21T11:00:00Z');
    expect(expired.cards?.hero.why.retention.displayPolicyStatus).toBe('expired');
    expect(
      conversationTranscriptEntries([], selectAssistantMessageRecords(expired), 'turn-a'),
    ).toEqual([]);
    await controller.select('b');
    expect(controller.getSnapshot().responseState).toBeNull();
    controller.dispose();
  });

  it('keeps a completed live answer visible during history sync failure and retries only the read', async () => {
    const completed = { ...run('a', 'completed'), response: liveAnswer() };
    const saved: ConversationMessage = {
      conversationId: 'a',
      sequence: 2,
      createdAt: now,
      message: {
        messageId: 'answer-a',
        role: 'assistant',
        source: { threadId: 'thread-a', turnId: 'turn-a', responseId: 'response-a' },
        parts: [{ kind: 'unavailable', reason: 'policy_withheld' }],
      },
    };
    let reads = 0;
    const api = client();
    const send = vi.fn<ConversationClient['send']>().mockResolvedValue(ok(completed));
    const controller = make({
      ...api,
      send,
      messages: async (id) => {
        reads++;
        if (reads === 2) return { ok: false, requestId: 'request', error: { kind: 'offline' } };
        const result = await api.messages(id);
        return result.ok && reads > 2
          ? ok({ ...result.data, messages: [message('a'), saved] })
          : result;
      },
    });
    await controller.select('a');
    await controller.submit(input);
    const received = controller.getSnapshot();
    expect(received).toMatchObject({ error: null, pending: false, run: { status: 'completed' } });
    expect(received.syncError).not.toBeNull();
    if (received.responseState === null) throw new Error('MISSING_RESPONSE');
    const entries = conversationTranscriptEntries(
      received.messages,
      selectAssistantMessageRecords(received.responseState),
      'turn-a',
    );
    expect(JSON.stringify(entries)).toContain('その場で表示できる回答');
    expect(JSON.stringify(received.messages)).not.toContain('その場で表示できる回答');
    await controller.retry();
    expect(send).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().syncError).toBeNull();
    expect(controller.getSnapshot().responseState).toBe(received.responseState);
    expect(controller.getSnapshot().messages).toContainEqual(saved);
    controller.dispose();
  });

  it('refreshes the revision after a definitive 409 and resends only on user retry', async () => {
    let revision = 1;
    const send = vi
      .fn<ConversationClient['send']>()
      .mockImplementationOnce(() => {
        revision = 3;
        return Promise.resolve({
          ok: false,
          requestId: 'request',
          error: {
            kind: 'http',
            status: 409,
            retryAfterSeconds: null,
            publicError: {
              schemaVersion: 'v1',
              requestId: 'request',
              status: 409,
              code: 'CONFLICT',
              message: '会話が更新されています',
            },
          },
        });
      })
      .mockImplementationOnce((_id, request) => {
        const result = run('a', 'completed');
        return Promise.resolve(
          ok({ ...result, run: { ...result.run, userMessageId: request.clientMessageId } }),
        );
      });
    const controller = make({
      ...client(),
      send,
      get: () =>
        Promise.resolve(
          ok({
            schemaVersion: 'v1',
            requestId: 'request',
            conversation: { ...conversation('a'), revision },
            activeRun: null,
          }),
        ),
    });
    await controller.select('a');
    await controller.submit(input);
    expect(send).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().selected?.revision).toBe(3);
    await controller.retry();
    expect(send.mock.calls[1]?.[1]).toMatchObject({ text: input.text, expectedRevision: 3 });
    expect(send.mock.calls[1]?.[1].idempotencyKey).not.toBe(send.mock.calls[0]?.[1].idempotencyKey);
    expect(controller.getSnapshot().error).toBeNull();
    controller.dispose();
  });
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
    readRun.mockResolvedValue(ok(run('a', 'completed')));
    await controller.select('a');
    expect(controller.getSnapshot()).toMatchObject({
      pending: false,
      run: { status: 'completed' },
    });
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
