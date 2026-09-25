import * as v from 'valibot';
import {
  telemetryEventRecordSchema,
  type TelemetryEventRecord,
  type TelemetryEventStore,
  type TelemetryEventFailure,
} from '@worker/application/ports/telemetry';
export type RecordTelemetryEvent = (
  record: TelemetryEventRecord,
  ownerScopeRef: string,
) => Promise<void>;
/** Only an internal allowlisted record reaches the store. Persistence failures remain observable. */
export const createRecordTelemetryEvent =
  (
    store: TelemetryEventStore,
    onFailure?: (failure: TelemetryEventFailure) => void,
  ): RecordTelemetryEvent =>
  async (record, ownerScopeRef) => {
    const checked = v.safeParse(telemetryEventRecordSchema, record);
    if (!checked.success) {
      onFailure?.('invalid_event');
      return;
    }
    try {
      await store.write(checked.output, ownerScopeRef);
    } catch {
      onFailure?.('write_failed');
      throw new Error('TELEMETRY_WRITE_FAILED');
    }
  };
