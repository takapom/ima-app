import { describe, expect, it } from 'vitest';
import { createApiRequestGate, type ApiOperationInput } from './request-gate';

const operation = (overrides: Partial<ApiOperationInput> = {}): ApiOperationInput => ({
  threadId: 'thread-1',
  turnId: 'turn-1',
  baseRevision: 0,
  idempotencyKey: 'idempotency-1',
  ...overrides,
});

const response = (revision: number, responseId = `response-${revision}`) => ({
  threadId: 'thread-1',
  turnId: 'turn-1',
  responseId,
  revision,
});

describe('API request gate', () => {
  it('keeps one idempotency key across retries and accepts only the new attempt', () => {
    const gate = createApiRequestGate();
    const first = gate.begin(operation());
    if (first === null) throw new Error('first operation should start');
    const same = gate.begin(operation());
    expect(same).toBe(first);

    const retry = gate.retry(first);
    if (retry === null) throw new Error('retry should remain the same operation');
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.attempt).not.toBe(first.attempt);
    gate.cancel(first);
    expect(gate.accept(first, response(1))).toEqual({
      accepted: false,
      reason: 'stale_attempt',
    });
    expect(gate.accept(retry, response(1))).toEqual({ accepted: true });
    expect(gate.accept(retry, response(1))).toEqual({
      accepted: false,
      reason: 'duplicate',
    });
  });

  it('rejects a reused key with another turn and does not let old operations affect a new thread', () => {
    const gate = createApiRequestGate();
    const first = gate.begin(operation());
    if (first === null) throw new Error('first operation should start');
    expect(gate.begin(operation({ turnId: 'turn-2' }))).toBeNull();

    gate.selectThread('thread-2', 0);
    expect(gate.retry(first)).toBeNull();
    const second = gate.begin(operation({ threadId: 'thread-2', turnId: 'turn-2' }));
    if (second === null) throw new Error('new thread operation should start');

    // The new thread intentionally reuses the key. A stale token from thread-1
    // must not cancel or retry the active operation for thread-2.
    gate.cancel(first);
    expect(gate.retry(first)).toBeNull();
    expect(gate.accept(second, { ...response(1), threadId: 'thread-2', turnId: 'turn-2' })).toEqual(
      {
        accepted: true,
      },
    );
    expect(gate.snapshot()).toMatchObject({ threadId: 'thread-2', revision: 1 });
  });

  it('rejects thread, turn, stale revision, and cancelled late responses', () => {
    const gate = createApiRequestGate();
    const token = gate.begin(operation());
    if (token === null) throw new Error('operation should start');
    expect(gate.accept(token, { ...response(1), threadId: 'thread-2' })).toEqual({
      accepted: false,
      reason: 'thread_mismatch',
    });
    expect(gate.accept(token, { ...response(1), turnId: 'turn-2' })).toEqual({
      accepted: false,
      reason: 'turn_mismatch',
    });
    expect(gate.accept(token, response(0))).toEqual({
      accepted: false,
      reason: 'stale_revision',
    });
    gate.cancel(token);
    expect(gate.accept(token, response(1))).toEqual({
      accepted: false,
      reason: 'cancelled',
    });
  });

  it('does not move back to an older revision when history is selected', () => {
    const gate = createApiRequestGate();
    gate.selectThread('thread-1', 4);
    gate.selectThread('thread-1', 2);
    expect(gate.snapshot()).toMatchObject({ threadId: 'thread-1', revision: 4 });
    gate.selectThread('thread-2', 2);
    expect(gate.snapshot()).toMatchObject({ threadId: 'thread-2', revision: 2 });
  });
});
