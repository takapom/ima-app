import { describe, expect, it, vi } from 'vitest';
import type { CreateThreadRequest, CreateThreadResponse } from '@ima/contracts';
import { createJourneyApiController } from './journey-controller';
import type { ApiResult, JourneyApiClient } from '../api/api';

const createInput = (idempotencyKey: string): CreateThreadRequest => ({
  schemaVersion: 'v1',
  requestId: `request-${idempotencyKey}`,
  idempotencyKey,
});

const createResponse = (input: CreateThreadRequest, threadId: string): CreateThreadResponse => ({
  schemaVersion: 'v1',
  requestId: input.requestId,
  threadId,
  revision: 0,
  state: 'active',
});

const success = <T>(requestId: string, data: T): ApiResult<T> => ({
  ok: true,
  requestId,
  data,
});

const clientWithCreate = (createThread: JourneyApiClient['createThread']): JourneyApiClient =>
  ({
    mode: 'fixture',
    createThread,
    search: vi.fn(),
    turn: vi.fn(),
    readThread: vi.fn(),
    replayThread: vi.fn(),
    lifecycle: vi.fn(),
    deleteThread: vi.fn(),
  }) as unknown as JourneyApiClient;

describe('Journey API controller create lifecycle', () => {
  it('retries an ambiguous create with the identical request body and key', async () => {
    const attempts: CreateThreadRequest[] = [];
    const api = clientWithCreate(
      vi.fn((input: CreateThreadRequest) => {
        attempts.push(input);
        return attempts.length === 1
          ? Promise.resolve({
              ok: false as const,
              requestId: input.requestId,
              error: { kind: 'timeout' as const },
            })
          : Promise.resolve(success(input.requestId, createResponse(input, 'thread-retried')));
      }),
    );
    const controller = createJourneyApiController({ api });
    const input = createInput('create-timeout');

    await expect(controller.createThread(input)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    });
    const firstRetry = controller.retry();
    const duplicateRetry = controller.retry();
    expect(duplicateRetry).toBe(firstRetry);
    await expect(firstRetry).resolves.toMatchObject({
      ok: true,
      data: { threadId: 'thread-retried', revision: 0 },
    });
    expect(api.createThread).toHaveBeenCalledTimes(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(controller.getState()).toMatchObject({
      threadId: 'thread-retried',
      status: 'idle',
    });
  });

  it('rejects a second create while another key is in flight', async () => {
    let resolveCreate: ((value: ApiResult<CreateThreadResponse>) => void) | undefined;
    const pending = new Promise<ApiResult<CreateThreadResponse>>((resolve) => {
      resolveCreate = resolve;
    });
    const api = clientWithCreate(vi.fn(() => pending));
    const controller = createJourneyApiController({ api });
    const first = controller.createThread(createInput('create-first'));
    const duplicate = controller.createThread(createInput('create-second'));

    await expect(duplicate).resolves.toMatchObject({
      ok: false,
      error: { kind: 'contract' },
    });
    expect(api.createThread).toHaveBeenCalledTimes(1);
    const input = createInput('create-first');
    resolveCreate?.(success(input.requestId, createResponse(input, 'thread-first')));
    await expect(first).resolves.toMatchObject({ ok: true, data: { threadId: 'thread-first' } });
  });

  it('allows a replacement after cancellation and ignores the old late response', async () => {
    let resolveFirst: ((value: ApiResult<CreateThreadResponse>) => void) | undefined;
    const firstPending = new Promise<ApiResult<CreateThreadResponse>>((resolve) => {
      resolveFirst = resolve;
    });
    const api = clientWithCreate(
      vi
        .fn()
        .mockReturnValueOnce(firstPending)
        .mockImplementationOnce((input: CreateThreadRequest) =>
          Promise.resolve(success(input.requestId, createResponse(input, 'thread-second'))),
        ),
    );
    const controller = createJourneyApiController({ api });
    const first = controller.createThread(createInput('create-first'));
    await Promise.resolve();
    controller.cancelPending();
    const second = controller.createThread(createInput('create-second'));
    resolveFirst?.(
      success('request-create-first', createResponse(createInput('create-first'), 'thread-first')),
    );

    await expect(first).resolves.toMatchObject({ ok: false, error: { kind: 'contract' } });
    await expect(second).resolves.toMatchObject({ ok: true, data: { threadId: 'thread-second' } });
    expect(controller.getState().threadId).toBe('thread-second');
  });
});
