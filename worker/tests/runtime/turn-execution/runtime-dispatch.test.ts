import { describe, expect, it, vi } from 'vitest';
import {
  dispatchRuntimeRequest,
  RuntimeDispatchError,
  type RuntimeDispatchTarget,
} from '@worker/infrastructure/runtime/turn-execution/runtime-dispatch';

const target: RuntimeDispatchTarget = {
  ownerScopeRef: 'owner-dispatch',
  threadId: 'thread-dispatch',
  turnId: 'turn-dispatch',
  revision: 4,
};

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('dispatchRuntimeRequest', () => {
  it('records an abort before admission without invoking run', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(() => Promise.resolve('unreachable'));
    const cancel = vi.fn((_target: RuntimeDispatchTarget) => Promise.resolve());
    const onCancellationError = vi.fn();

    await expect(
      dispatchRuntimeRequest({
        target,
        run,
        cancel,
        signal: controller.signal,
        onCancellationError,
      }),
    ).rejects.toBeInstanceOf(RuntimeDispatchError);
    expect(run).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel.mock.calls[0]).toEqual([target]);
    expect(onCancellationError).not.toHaveBeenCalled();
  });

  it('cancels once during a run and preserves the run result', async () => {
    const controller = new AbortController();
    let resolveRun!: (value: { ok: true }) => void;
    const run = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const cancel = vi.fn((_target: RuntimeDispatchTarget) => Promise.resolve());
    const onCancellationError = vi.fn();
    const pending = dispatchRuntimeRequest({
      target,
      run,
      cancel,
      signal: controller.signal,
      onCancellationError,
    });

    await tick();
    controller.abort();
    await tick();
    expect(run).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel.mock.calls[0]).toEqual([target]);
    expect(onCancellationError).not.toHaveBeenCalled();
    resolveRun({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('removes the abort listener after completion', async () => {
    const controller = new AbortController();
    const cancel = vi.fn((_target: RuntimeDispatchTarget) => Promise.resolve());
    const onCancellationError = vi.fn();
    await expect(
      dispatchRuntimeRequest({
        target,
        run: () => Promise.resolve('done'),
        cancel,
        signal: controller.signal,
        onCancellationError,
      }),
    ).resolves.toBe('done');

    controller.abort();
    await tick();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('preserves an arbitrary run exception and observes rejected cancellation', async () => {
    const controller = new AbortController();
    const runError = new Error('run failure');
    const cancelError = new Error('cancel RPC rejected');
    const cancel = vi.fn((_target: RuntimeDispatchTarget) => Promise.reject(cancelError));
    const onCancellationError = vi.fn();
    const waitUntil = vi.fn((promise: Promise<void>) => {
      promise.catch(() => undefined);
    });
    const pending = dispatchRuntimeRequest({
      target,
      run: () => {
        controller.abort();
        return Promise.reject(runError);
      },
      cancel,
      signal: controller.signal,
      waitUntil,
      onCancellationError,
    });

    await expect(pending).rejects.toBe(runError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(cancel.mock.calls[0]).toEqual([target]);
    expect(onCancellationError).toHaveBeenCalledWith(cancelError);
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
  });

  it('reports waitUntil registration failure without changing the run result', async () => {
    const controller = new AbortController();
    const registrationError = new Error('waitUntil rejected');
    const onCancellationError = vi.fn();
    const result = await dispatchRuntimeRequest({
      target,
      run: () => {
        controller.abort();
        return Promise.resolve('accepted');
      },
      cancel: (_target: RuntimeDispatchTarget) => Promise.resolve(),
      signal: controller.signal,
      waitUntil: () => {
        throw registrationError;
      },
      onCancellationError,
    });

    expect(result).toBe('accepted');
    expect(onCancellationError).toHaveBeenCalledWith(registrationError);
  });

  it('passes the cancellation target without sending a signal', async () => {
    const controller = new AbortController();
    const cancel = vi.fn((_target: RuntimeDispatchTarget) => Promise.resolve());
    const onCancellationError = vi.fn();
    const result = await dispatchRuntimeRequest({
      target,
      run: () => {
        controller.abort();
        return Promise.resolve('accepted');
      },
      cancel,
      signal: controller.signal,
      onCancellationError,
    });

    expect(result).toBe('accepted');
    expect(cancel.mock.calls[0]).toEqual([target]);
    expect(onCancellationError).not.toHaveBeenCalled();
  });
});
