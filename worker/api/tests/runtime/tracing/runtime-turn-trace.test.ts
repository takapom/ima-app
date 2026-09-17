import { describe, expect, it } from 'vitest';
import {
  createBestEffortRuntimeTurnTraceSink,
  runtimeTurnTraceOutcome,
  runtimeTraceModeFor,
  traceIdForRuntimeTurn,
  traceRecordForRuntimeTurn,
  telemetryObjectNameForRuntimeTraceMode,
  type RuntimeTurnTrace,
} from '@api/runtime/tracing/runtime-turn-trace';

const trace: RuntimeTurnTrace = {
  ownerScopeRef: 'owner-runtime-trace',
  threadId: 'thread-runtime-trace',
  turnId: 'turn-runtime-trace',
  revision: 1,
  occurredAt: '2026-09-11T00:00:00.000Z',
  status: 'ok',
  resultCode: 'OK',
  durationMs: 42,
};

describe('runtime turn trace producer', () => {
  it('separates fixture, live, and unknown telemetry namespaces', () => {
    expect(runtimeTraceModeFor('fixture')).toBe('fixture');
    expect(runtimeTraceModeFor('live')).toBe('live');
    expect(runtimeTraceModeFor('disabled')).toBe('unknown');
    expect(telemetryObjectNameForRuntimeTraceMode('fixture')).toBe('telemetry-fixture');
    expect(telemetryObjectNameForRuntimeTraceMode('live')).toBe('telemetry-live');
    expect(telemetryObjectNameForRuntimeTraceMode('unknown')).toBe('telemetry-unknown');
  });

  it('uses a SHA-256 identity that separates thread and revision while replay stays idempotent', async () => {
    const record = await traceRecordForRuntimeTurn(trace);
    expect(record).toMatchObject({ operation: 'turn', durationMs: 42, resultCode: 'OK' });
    await expect(traceIdForRuntimeTurn(trace)).resolves.toBe(
      await traceIdForRuntimeTurn({ ...trace }),
    );
    await expect(traceIdForRuntimeTurn(trace)).resolves.not.toBe(
      await traceIdForRuntimeTurn({ ...trace, threadId: 'thread-other' }),
    );
    await expect(traceIdForRuntimeTurn(trace)).resolves.not.toBe(
      await traceIdForRuntimeTurn({ ...trace, revision: 2 }),
    );
    expect(JSON.stringify(record)).not.toMatch(/secret|token|lat|lng|provider/iu);
  });

  it('keeps telemetry writes best effort for synchronous and asynchronous store failures', async () => {
    const failures: string[] = [];
    const scheduled: Promise<void>[] = [];
    const writes: unknown[] = [];
    const sink = createBestEffortRuntimeTurnTraceSink(
      {
        write: (record) => {
          writes.push(record);
          return Promise.resolve();
        },
      },
      (promise) => scheduled.push(promise),
      (failure) => failures.push(failure),
    );
    const pending = sink(trace);
    expect(scheduled).toHaveLength(1);
    await expect(pending).resolves.toBeUndefined();
    await Promise.all(scheduled);
    expect(writes).toHaveLength(1);
    expect(failures).toEqual([]);

    const syncFailure = createBestEffortRuntimeTurnTraceSink(
      {
        write: () => {
          throw new Error('storage secret');
        },
      },
      undefined,
      (failure) => failures.push(failure),
    );
    await expect(syncFailure(trace)).resolves.toBeUndefined();

    const asyncFailure = createBestEffortRuntimeTurnTraceSink(
      {
        write: () => Promise.reject(new Error('provider token')),
      },
      (promise) => scheduled.push(promise),
      (failure) => failures.push(failure),
    );
    await expect(asyncFailure(trace)).resolves.toBeUndefined();
    await Promise.all(scheduled);
    expect(failures).toEqual(['write_failed', 'write_failed']);

    const schedulingFailure = createBestEffortRuntimeTurnTraceSink(
      { write: () => Promise.resolve() },
      () => {
        throw new Error('waitUntil secret');
      },
      (failure) => failures.push(failure),
    );
    await expect(schedulingFailure(trace)).resolves.toBeUndefined();
    expect(failures).toEqual(['write_failed', 'write_failed', 'write_failed']);
  });

  it('does not mark a saved turn successful when final response metadata is absent', () => {
    expect(
      runtimeTurnTraceOutcome({
        savedStatus: 'completed',
        responseAvailable: false,
        guardFailureCode: undefined,
        failureCode: undefined,
        cancelled: false,
      }),
    ).toEqual({ status: 'error', resultCode: 'INTERNAL' });
    expect(
      runtimeTurnTraceOutcome({
        savedStatus: 'completed',
        responseAvailable: true,
        guardFailureCode: undefined,
        failureCode: undefined,
        cancelled: false,
      }),
    ).toEqual({ status: 'ok', resultCode: 'OK' });
  });
});
