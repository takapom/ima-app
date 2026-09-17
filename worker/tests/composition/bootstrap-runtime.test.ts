import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import {
  SearchResponseSchema,
  ThreadReadResponseSchema,
  type SearchResponse,
} from '@ima/contracts';
import {
  createRuntimeApplicationHandler,
  serverTurnId,
  type RuntimeThreadStub,
} from '@worker/adapters/inbound/http/runtime-handler';
import type { HandlerContext } from '@worker/adapters/inbound/http/handler';
import {
  isThreadRuntimeTarget,
  isThreadRuntimeTurnInput,
  runtimeFailure,
  type ThreadRuntimeResponseMetadata,
  type ThreadRuntimeTarget,
  type ThreadRuntimeTurnInput,
  type ThreadRuntimeTurnResult,
} from '@worker/runtime/threads/admission';
import { searchInput, searchResponse } from '../adapters/inbound/http/router-fixtures';

const ownerScopeRef = 'owner-bootstrap-runtime';
const threadId = 'thread-bootstrap-runtime';

const contextFor = (signal: AbortSignal = new AbortController().signal): HandlerContext => ({
  requestId: 'request-bootstrap-runtime',
  ownerScopeRef,
  deviceId: 'device-bootstrap-runtime',
  appVersion: 'test',
  serverNow: '2026-09-10T12:00:00Z',
  cancellation: { isCancelled: () => signal.aborted },
  signal,
});

const snapshot = {
  ok: true as const,
  snapshot: {
    threadId,
    ownerScopeRef,
    revision: 2,
    active: true,
    state: 'active' as const,
  },
};

const responseFor = (target: ThreadRuntimeTarget): SearchResponse['response'] => ({
  ...searchResponse.response,
  threadId: target.threadId,
  turnId: target.turnId,
  revision: target.revision + 1,
});

const runtimeResultFor = (target: ThreadRuntimeTarget): ThreadRuntimeTurnResult => ({
  status: 'completed',
  requestId: 'sdk-request',
  response: responseFor(target),
});

const runtimeOperation = {
  kind: 'search' as const,
  input: { ...searchInput, threadId },
};

const makeStub = (overrides: Partial<RuntimeThreadStub> = {}): RuntimeThreadStub => ({
  read: vi.fn(() => Promise.resolve(snapshot)),
  runRuntimeTurn: vi.fn((value: unknown) => {
    if (!isThreadRuntimeTurnInput(value)) throw new Error('invalid fixture runtime input');
    return Promise.resolve(runtimeResultFor(value));
  }),
  cancelRuntimeTurn: vi.fn(() => Promise.resolve({ status: 'accepted' as const })),
  listRuntimeResponses: vi.fn(() => Promise.resolve([])),
  ...overrides,
});

const makeHandler = (
  stub: RuntimeThreadStub,
  extra: {
    readonly waitUntil?: (promise: Promise<void>) => void;
    readonly onCancellationError?: (classification: 'CANCELLATION_FAILED') => void;
  } = {},
) =>
  createRuntimeApplicationHandler({
    threads: { getByName: () => stub },
    ...extra,
  });

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('HTTP runtime bootstrap adapter', () => {
  it('splits search threadId, derives a stable null turn ID, and validates the initial response', async () => {
    let received: ThreadRuntimeTurnInput | undefined;
    let receivedHasThreadId: boolean | undefined;
    const stub = makeStub({
      runRuntimeTurn: vi.fn((value: unknown) => {
        if (!isThreadRuntimeTurnInput(value)) throw new Error('invalid fixture runtime input');
        received = value;
        receivedHasThreadId = 'threadId' in value.input;
        return Promise.resolve(runtimeResultFor(value));
      }),
    });
    const handler = makeHandler(stub);

    const result = await handler.handle(runtimeOperation, contextFor());
    if (result.kind !== 'search') throw new Error('expected search result');
    const parsed = v.safeParse(SearchResponseSchema, result.response);
    expect(parsed.success).toBe(true);
    expect(received).toBeDefined();
    expect(received?.threadId).toBe(threadId);
    expect(received?.turnId).toBe(
      await serverTurnId(ownerScopeRef, threadId, searchInput.idempotencyKey),
    );
    expect(received?.revision).toBe(searchInput.revision);
    expect(received?.deviceId).toBe('device-bootstrap-runtime');
    expect(receivedHasThreadId).toBe(false);
    expect(result.response.response.threadId).toBe(threadId);
    expect(result.response.response.turnId).toBe(received?.turnId);
    expect(result.response.response.revision).toBe(searchInput.revision + 1);
  });

  it('passes displayed-card context through the HTTP adapter into the runtime input', async () => {
    let received: ThreadRuntimeTurnInput | undefined;
    const stub = makeStub({
      runRuntimeTurn: vi.fn((value: unknown) => {
        if (!isThreadRuntimeTurnInput(value)) throw new Error('invalid fixture runtime input');
        received = value;
        return Promise.resolve(runtimeResultFor(value));
      }),
    });
    const operation = {
      ...runtimeOperation,
      input: {
        ...runtimeOperation.input,
        cardSetId: 'card-set-1',
        promotedCandidateId: 'candidate-2',
        selectedCandidateId: 'candidate-2',
        candidateOrder: ['candidate-2', 'candidate-1'],
        excludeCandidateIds: ['candidate-3'],
      },
    };

    await expect(makeHandler(stub).handle(operation, contextFor())).resolves.toMatchObject({
      kind: 'search',
    });
    expect(received?.input.cardSetId).toBe('card-set-1');
    expect(received?.input.promotedCandidateId).toBe('candidate-2');
    expect(received?.input.selectedCandidateId).toBe('candidate-2');
    expect(received?.input.candidateOrder).toEqual(['candidate-2', 'candidate-1']);
    expect(received?.input.excludeCandidateIds).toEqual(['candidate-3']);
  });

  it('maps a completed duplicate to CONFLICT so the client can GET replay', async () => {
    const stub = makeStub({
      runRuntimeTurn: vi.fn(() => Promise.resolve(runtimeFailure('IDEMPOTENCY_CONFLICT'))),
    });
    const handler = makeHandler(stub);

    await expect(handler.handle(runtimeOperation, contextFor())).rejects.toMatchObject({
      failure: { status: 409, code: 'CONFLICT' },
    });
  });

  it('maps a rejected displayed-card context to a public conflict', async () => {
    const stub = makeStub({
      runRuntimeTurn: vi.fn(() => Promise.resolve(runtimeFailure('REVISION_CONFLICT'))),
    });
    await expect(makeHandler(stub).handle(runtimeOperation, contextFor())).rejects.toMatchObject({
      failure: { status: 409, code: 'CONFLICT' },
    });
  });

  it('maps a completed reference-only runtime result to CONFLICT instead of a success body', async () => {
    const stub = makeStub({
      runRuntimeTurn: vi.fn((value: unknown) => {
        if (!isThreadRuntimeTurnInput(value)) throw new Error('invalid fixture runtime input');
        return Promise.resolve({
          status: 'completed' as const,
          requestId: 'sdk-request',
          response: {
            turnId: value.turnId,
            responseId: 'response-reference-only',
            revision: value.revision + 1,
            kind: 'message' as const,
            presentation: 'keep' as const,
            cardSetId: null,
            restoreMode: 'reference_only' as const,
          },
        });
      }),
    });

    await expect(makeHandler(stub).handle(runtimeOperation, contextFor())).rejects.toMatchObject({
      failure: { status: 409, code: 'CONFLICT' },
    });
  });

  it('uses only completed runtime metadata for reference-only read responses', async () => {
    const metadata: readonly ThreadRuntimeResponseMetadata[] = [
      {
        turnId: 'turn-completed',
        revision: 2,
        status: 'completed',
        responseId: 'response-completed',
        kind: 'message',
        presentation: 'keep',
        cardSetId: null,
      },
      {
        turnId: 'turn-failed',
        revision: 1,
        status: 'failed',
        responseId: null,
        kind: null,
        presentation: null,
        cardSetId: null,
      },
    ];
    const stub = makeStub({ listRuntimeResponses: vi.fn(() => Promise.resolve(metadata)) });
    const handler = makeHandler(stub);
    const result = await handler.handle({ kind: 'read_thread', path: { threadId } }, contextFor());

    if (result.kind !== 'read_thread') throw new Error('expected read result');
    const parsed = v.safeParse(ThreadReadResponseSchema, result.response);
    expect(parsed.success).toBe(true);
    expect(result.response.responses).toEqual([
      {
        turnId: 'turn-completed',
        responseId: 'response-completed',
        revision: 2,
        kind: 'message',
        presentation: 'keep',
        cardSetId: null,
        restoreMode: 'reference_only',
      },
    ]);
  });

  it('re-reads the snapshot after metadata so a commit during listing is not rejected as future data', async () => {
    let readCount = 0;
    const stub = makeStub({
      read: vi.fn(() => {
        readCount += 1;
        return Promise.resolve({
          ...snapshot,
          snapshot: { ...snapshot.snapshot, revision: readCount === 1 ? 1 : 2 },
        });
      }),
      listRuntimeResponses: vi.fn(() =>
        Promise.resolve([
          {
            turnId: 'turn-during-read',
            revision: 2,
            status: 'completed' as const,
            responseId: 'response-during-read',
            kind: 'message' as const,
            presentation: 'keep' as const,
            cardSetId: null,
          },
        ]),
      ),
    });
    const result = await makeHandler(stub).handle(
      { kind: 'replay_thread', path: { threadId } },
      contextFor(),
    );

    if (result.kind !== 'replay_thread') throw new Error('expected replay result');
    expect(result.response.revision).toBe(2);
    expect(result.response.responses[0]?.responseId).toBe('response-during-read');
  });

  it('cancels the owner/thread/revision-bound RPC and reports a fixed classification', async () => {
    const controller = new AbortController();
    let resolveRun!: (result: ThreadRuntimeTurnResult) => void;
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancelTargets: ThreadRuntimeTarget[] = [];
    const stub = makeStub({
      runRuntimeTurn: vi.fn((value: unknown) => {
        if (!isThreadRuntimeTurnInput(value)) throw new Error('invalid fixture runtime input');
        started();
        return new Promise<ThreadRuntimeTurnResult>((resolve) => {
          resolveRun = resolve;
        });
      }),
      cancelRuntimeTurn: vi.fn((value: unknown) => {
        if (!isThreadRuntimeTarget(value)) throw new Error('invalid cancellation target');
        cancelTargets.push(value);
        return Promise.resolve({ status: 'accepted' as const });
      }),
    });
    const waitUntil = vi.fn((promise: Promise<void>) => {
      promise.catch(() => undefined);
    });
    const classification = vi.fn();
    const handler = makeHandler(stub, {
      waitUntil,
      onCancellationError: classification,
    });
    const pending = handler.handle(runtimeOperation, contextFor(controller.signal));
    await runStarted;
    controller.abort();
    await tick();
    expect(cancelTargets).toHaveLength(1);
    expect(cancelTargets[0]?.ownerScopeRef).toBe(ownerScopeRef);
    expect(cancelTargets[0]?.threadId).toBe(threadId);
    expect(waitUntil).toHaveBeenCalledOnce();
    resolveRun({ status: 'cancelled', requestId: null, response: null, code: 'CANCELLED' });
    await expect(pending).rejects.toMatchObject({
      failure: { status: 409, code: 'CANCELLED' },
    });
    expect(classification).not.toHaveBeenCalled();
  });

  it('keeps malformed runtime responses and unexpected errors at the HTTP boundary', async () => {
    const malformed = makeStub({
      runRuntimeTurn: vi.fn((value: unknown) => {
        if (!isThreadRuntimeTurnInput(value)) throw new Error('invalid fixture runtime input');
        return Promise.resolve({
          status: 'completed' as const,
          requestId: 'sdk-request',
          response: { ...responseFor(value), revision: value.revision },
        });
      }),
    });
    const malformedHandler = makeHandler(malformed);
    await expect(malformedHandler.handle(runtimeOperation, contextFor())).rejects.toMatchObject({
      failure: { status: 500, code: 'INTERNAL' },
    });

    const unexpected = new Error('provider secret');
    const failing = makeStub({ runRuntimeTurn: vi.fn(() => Promise.reject(unexpected)) });
    await expect(makeHandler(failing).handle(runtimeOperation, contextFor())).rejects.toBe(
      unexpected,
    );
  });
});
