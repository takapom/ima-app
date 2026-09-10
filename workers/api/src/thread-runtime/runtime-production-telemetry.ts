import type { RuntimeProviderTraceSink } from '../providers/telemetry/runtime-provider-trace';
import { createBestEffortRuntimeProviderTraceSink } from '../providers/telemetry/runtime-provider-trace';
import type { RuntimeModelTraceSink } from '../runtime/runtime-model-trace';
import { createBestEffortRuntimeModelTraceSink } from '../runtime/runtime-model-trace';
import type { RuntimeTurnTraceSink } from '../runtime/runtime-turn-trace';
import { createBestEffortRuntimeTurnTraceSink } from '../runtime/runtime-turn-trace';
import type { RuntimeTraceSinkFailure } from '../runtime/runtime-trace-sink';
import type { TelemetryTraceStore } from '../telemetry/trace';

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
