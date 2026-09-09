import { describe, expect, it } from 'vitest';
import { RuntimeSingleFlight } from '../../src/runtime/runtime-singleflight';
import type { RuntimeSingleFlightError } from '../../src/runtime/runtime-singleflight';

describe('RuntimeSingleFlight', () => {
  it('shares one in-flight read across equivalent keys and call IDs', async () => {
    let calls = 0;
    let resolveRead: (value: string) => void = () => undefined;
    const flight = new RuntimeSingleFlight<string>();
    const task = (): Promise<string> => {
      calls += 1;
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    };

    const first = flight.execute('call-1', 'scope/input/context/freshness', task);
    const second = flight.execute('call-2', 'scope/input/context/freshness', task);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);
    resolveRead('result');
    await expect(first).resolves.toBe('result');
    await expect(flight.execute('call-1', 'scope/input/context/freshness', task)).resolves.toBe(
      'result',
    );
    expect(calls).toBe(1);
  });

  it('rejects a call ID reused for a different operation', async () => {
    const flight = new RuntimeSingleFlight<string>();
    await expect(flight.execute('call-1', 'first', () => Promise.resolve('first'))).resolves.toBe(
      'first',
    );
    await expect(
      flight.execute('call-1', 'second', () => Promise.resolve('second')),
    ).rejects.toMatchObject({
      name: 'RuntimeSingleFlightError',
      code: 'CALL_ID_CONFLICT',
    } satisfies Partial<RuntimeSingleFlightError>);
  });

  it('rejects stale and cancelled turns before invoking the task', async () => {
    let calls = 0;
    const stale = new RuntimeSingleFlight<string>({ isStale: () => true });
    await expect(
      stale.execute('call-1', 'key', () => {
        calls += 1;
        return Promise.resolve('unexpected');
      }),
    ).rejects.toMatchObject({ code: 'STALE_TURN' });

    const cancelled = new RuntimeSingleFlight<string>({ isCancelled: () => true });
    await expect(
      cancelled.execute('call-2', 'key', () => {
        calls += 1;
        return Promise.resolve('unexpected');
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toBe(0);
  });

  it('rechecks cancellation and disposal before the microtask starts', async () => {
    let calls = 0;
    let cancelled = false;
    const cancellation = new RuntimeSingleFlight<string>({
      isCancelled: () => cancelled,
    });
    const cancelledResult = cancellation.execute('cancel-1', 'key', () => {
      calls += 1;
      return Promise.resolve('unexpected');
    });
    cancelled = true;
    await expect(cancelledResult).rejects.toMatchObject({ code: 'CANCELLED' });

    const disposed = new RuntimeSingleFlight<string>();
    const disposedResult = disposed.execute('dispose-1', 'key', () => {
      calls += 1;
      return Promise.resolve('unexpected');
    });
    disposed.dispose();
    await expect(disposedResult).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toBe(0);
  });

  it('allows a fresh read after a prior promise settles and blocks disposal reuse', async () => {
    let calls = 0;
    const flight = new RuntimeSingleFlight<number>();
    const read = (): Promise<number> => {
      calls += 1;
      return Promise.resolve(calls);
    };
    await expect(flight.execute('call-1', 'key', read)).resolves.toBe(1);
    await expect(flight.execute('call-2', 'key', read)).resolves.toBe(2);
    flight.dispose();
    await expect(flight.execute('call-3', 'key', read)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(calls).toBe(2);
  });
});
