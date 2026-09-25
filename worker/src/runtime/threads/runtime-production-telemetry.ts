import type { RuntimeProviderTraceSink } from '@worker/runtime/tracing/runtime-provider-trace';
import { createBestEffortRuntimeProviderTraceSink } from '@worker/runtime/tracing/runtime-provider-trace';
import type { RuntimeModelTraceSink } from '@worker/runtime/tracing/runtime-model-trace';
import { createBestEffortRuntimeModelTraceSink } from '@worker/runtime/tracing/runtime-model-trace';
import type { RuntimeTurnTraceSink } from '@worker/runtime/tracing/runtime-turn-trace';
import { createBestEffortRuntimeTurnTraceSink } from '@worker/runtime/tracing/runtime-turn-trace';
import type { RuntimeTraceSinkFailure } from '@worker/runtime/tracing/runtime-trace-sink';
import type { TelemetryTraceStore } from '@worker/application/ports/telemetry';

export type RuntimeTelemetryDiagnosticOperation = 'turn' | 'model' | 'provider';
export type RuntimeTelemetryDiagnosticFailure = RuntimeTraceSinkFailure;

export type RuntimeTelemetryDiagnostic = {
  readonly operation: RuntimeTelemetryDiagnosticOperation;
  readonly failure: RuntimeTelemetryDiagnosticFailure;
};

export type RuntimeTelemetryDiagnosticWriter = (diagnostic: RuntimeTelemetryDiagnostic) => void;

const writeRuntimeTelemetryDiagnostic: RuntimeTelemetryDiagnosticWriter = (diagnostic) => {
  console.warn(
    JSON.stringify({
      event: 'runtime_telemetry_failure',
      operation: diagnostic.operation,
      failure: diagnostic.failure,
    }),
  );
};

export const createRuntimeTelemetryFailureObserver =
  (
    operation: RuntimeTelemetryDiagnosticOperation,
    writer: RuntimeTelemetryDiagnosticWriter = writeRuntimeTelemetryDiagnostic,
  ): ((failure: RuntimeTelemetryDiagnosticFailure) => void) =>
  (failure): void => {
    try {
      writer({ operation, failure });
    } catch {
      // A diagnostic writer is best effort and must never alter the runtime operation.
    }
  };

export type RuntimeProductionTelemetrySinks = {
  readonly turn: RuntimeTurnTraceSink | undefined;
  readonly model: RuntimeModelTraceSink | undefined;
  readonly provider: RuntimeProviderTraceSink | undefined;
};

export const createRuntimeProductionTelemetrySinks = (input: {
  readonly store: Pick<TelemetryTraceStore, 'write'> | undefined;
  readonly schedule: (promise: Promise<void>) => void;
  readonly writeDiagnostic?: RuntimeTelemetryDiagnosticWriter;
}): RuntimeProductionTelemetrySinks => {
  if (input.store === undefined) {
    return { turn: undefined, model: undefined, provider: undefined };
  }
  return {
    turn: createBestEffortRuntimeTurnTraceSink(
      input.store,
      input.schedule,
      createRuntimeTelemetryFailureObserver('turn', input.writeDiagnostic),
    ),
    model: createBestEffortRuntimeModelTraceSink(
      input.store,
      input.schedule,
      createRuntimeTelemetryFailureObserver('model', input.writeDiagnostic),
    ),
    provider: createBestEffortRuntimeProviderTraceSink(
      input.store,
      input.schedule,
      createRuntimeTelemetryFailureObserver('provider', input.writeDiagnostic),
    ),
  };
};
