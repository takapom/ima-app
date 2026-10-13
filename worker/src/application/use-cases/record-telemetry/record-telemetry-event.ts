import * as v from 'valibot';
import {
  telemetryEventRecordSchema,
  type TelemetryEventRecord,
  type TelemetryEventStore,
  type TelemetryEventFailure,
} from '@worker/application/ports/telemetry';
/** テレメトリ1件を owner スコープ付きで永続化する関数型。 */
export type RecordTelemetryEvent = (
  record: TelemetryEventRecord,
  ownerScopeRef: string,
) => Promise<void>;
/**
 * 許可リストを通過した記録だけをストアへ書く。
 * 形式不正は記録せず戻る。書き込み失敗は呼び出し側へ投げ直し、成功したことにしない。
 */
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
