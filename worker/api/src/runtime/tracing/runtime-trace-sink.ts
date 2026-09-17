import type { TraceRecord } from '../../telemetry/schema';
import type { TelemetryTraceStore } from '../../telemetry/trace';

export type RuntimeTraceSinkFailure = 'write_failed';

type RuntimeTraceWithOwner = { readonly ownerScopeRef: string };

/**
 * Schedules validated telemetry writes without making the runtime operation depend on them.
 * The conversion starts before the first await so a DO waitUntil hook receives the full job.
 */
export const createBestEffortRuntimeTraceSink = <Trace extends RuntimeTraceWithOwner>(
  store: Pick<TelemetryTraceStore, 'write'>,
  toRecord: (trace: Trace) => Promise<TraceRecord | undefined>,
  schedule?: (promise: Promise<void>) => void,
  onFailure?: (failure: RuntimeTraceSinkFailure) => void,
): ((trace: Trace) => void | Promise<void>) => {
  return (trace) => {
    let failureReported = false;
    const notifyFailure = (): void => {
      if (failureReported) return;
      failureReported = true;
      try {
        onFailure?.('write_failed');
      } catch {
        // Telemetry failure reporting must not affect the runtime operation.
      }
    };
    const pipeline = (async (): Promise<void> => {
      let record: TraceRecord | undefined;
      try {
        record = await toRecord(trace);
      } catch {
        notifyFailure();
        return;
      }
      if (record === undefined) {
        notifyFailure();
        return;
      }
      try {
        await store.write(record, trace.ownerScopeRef);
      } catch {
        notifyFailure();
      }
    })();
    if (schedule === undefined) {
      pipeline.catch(() => undefined);
      return pipeline;
    }
    try {
      schedule(pipeline);
    } catch {
      notifyFailure();
      pipeline.catch(() => undefined);
    }
    return pipeline;
  };
};
