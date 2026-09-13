import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeProductionTelemetrySinks,
  createRuntimeTelemetryFailureObserver,
  type RuntimeTelemetryDiagnostic,
} from '../../src/thread-runtime/runtime-production-telemetry';
import type { RuntimeModelTrace } from '../../src/runtime/tracing/runtime-model-trace';
import type { RuntimeProviderTrace } from '../../src/providers/telemetry/runtime-provider-trace';
import type { RuntimeTurnTrace } from '../../src/runtime/tracing/runtime-turn-trace';

const turnTrace: RuntimeTurnTrace = {
  ownerScopeRef: 'owner-m26-diagnostic',
  threadId: 'thread-m26-diagnostic',
  turnId: 'turn-m26-diagnostic',
  revision: 1,
  occurredAt: '2026-09-11T00:00:00.000Z',
  status: 'ok',
  resultCode: 'OK',
};

const modelTrace: RuntimeModelTrace = {
  ...turnTrace,
  callId: 'call-m26-diagnostic',
};

const providerTrace: RuntimeProviderTrace = {
  ...turnTrace,
  callId: 'provider-call-m26-diagnostic',
  provider: 'places',
};

const failingStoreFor = (asynchronous: boolean) => ({
  write: (): Promise<void> => {
    if (!asynchronous) throw new Error('raw owner token must not be observed');
    return Promise.reject(new Error('raw owner token must not be observed'));
  },
});

describe('production telemetry diagnostics', () => {
  it('reports each host sink failure with only its fixed operation and failure code', async () => {
    for (const asynchronous of [false, true]) {
      const scheduled: Promise<void>[] = [];
      const diagnostics: RuntimeTelemetryDiagnostic[] = [];
      const sinks = createRuntimeProductionTelemetrySinks({
        store: failingStoreFor(asynchronous),
        schedule: (promise) => scheduled.push(promise),
        writeDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      const pending = [
        Promise.resolve(sinks.turn?.(turnTrace)),
        Promise.resolve(sinks.model?.(modelTrace)),
        Promise.resolve(sinks.provider?.(providerTrace)),
      ];
      await Promise.all(pending);
      await Promise.all(scheduled);

      expect(diagnostics).toHaveLength(3);
      expect(
        [...diagnostics].sort((left, right) => left.operation.localeCompare(right.operation)),
      ).toEqual([
        { operation: 'model', failure: 'write_failed' },
        { operation: 'provider', failure: 'write_failed' },
        { operation: 'turn', failure: 'write_failed' },
      ]);
      expect(JSON.stringify(diagnostics)).not.toMatch(/owner-m26|token|raw/iu);
    }
  });

  it('keeps a throwing diagnostic writer from rejecting the sink pipeline', async () => {
    const scheduled: Promise<void>[] = [];
    const sinks = createRuntimeProductionTelemetrySinks({
      store: failingStoreFor(true),
      schedule: (promise) => scheduled.push(promise),
      writeDiagnostic: () => {
        throw new Error('diagnostic writer failed');
      },
    });
    const turn = sinks.turn;
    if (turn === undefined) throw new Error('turn telemetry sink missing');

    const pending = turn(turnTrace);
    await expect(pending).resolves.toBeUndefined();
    await expect(Promise.all(scheduled)).resolves.toEqual([undefined]);
  });

  it('writes a structured standard-console record with fixed fields', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      createRuntimeTelemetryFailureObserver('provider')('write_failed');
      expect(warning).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'runtime_telemetry_failure',
          operation: 'provider',
          failure: 'write_failed',
        }),
      );
    } finally {
      warning.mockRestore();
    }
  });
});
