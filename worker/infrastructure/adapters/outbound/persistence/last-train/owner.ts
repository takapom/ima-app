import * as v from 'valibot';
import {
  IsoTimestampSchema,
  JOURNEY_VERIFICATION_MAX_AGE_MS,
  type Issue,
  type JourneyServiceDateContext,
} from '@ima/core';
import {
  expireJourneyDataset,
  importJourneyDataset,
  rollbackJourneyDataset,
  type JourneyImportResult,
  type JourneyMaintenanceResult,
} from '@worker/infrastructure/adapters/outbound/persistence/last-train/importer';
import {
  createJourneyReader,
  type JourneyReadResult,
} from '@worker/infrastructure/adapters/outbound/persistence/last-train/reader';
import {
  createDurableJourneyDatasetStore,
  JourneyDatasetStorageError,
} from '@worker/infrastructure/adapters/outbound/persistence/last-train/store';
import { parseJourneyDataset } from '@worker/infrastructure/adapters/outbound/persistence/last-train/types';

export type JourneyDatasetCommand =
  | {
      readonly kind: 'import';
      readonly input: unknown;
      readonly now: string;
      readonly expectedRevision: number | null;
    }
  | {
      readonly kind: 'rollback';
      readonly targetRevision: number;
      readonly now: string;
      readonly expectedRevision: number | null;
    }
  | { readonly kind: 'expire'; readonly now: string };

export type JourneyDatasetCommandResult = JourneyImportResult | JourneyMaintenanceResult;

export type JourneyDatasetAlarmFailure = {
  readonly status: 'alarm_failed';
  readonly commandStatus: Exclude<JourneyDatasetCommandResult['status'], 'rejected'>;
  readonly revision: number | null;
  readonly issues: readonly Issue[];
};

export type JourneyDatasetExecutionResult =
  JourneyDatasetCommandResult | JourneyDatasetAlarmFailure;

export type JourneyDatasetOwner = {
  /** The named JourneyDatasetDO owns this storage and is the scope boundary for maintenance. */
  readonly read: (context: JourneyServiceDateContext) => Promise<JourneyReadResult>;
  readonly execute: (command: JourneyDatasetCommand) => Promise<JourneyDatasetCommandResult>;
  /** Returns the next record deadline for a DO alarm, or null when no record is active. */
  readonly nextExpiryAt: (now: string) => Promise<number | null>;
};

const nextExpiryAt = async (
  store: ReturnType<typeof createDurableJourneyDatasetStore>,
  now: string,
): Promise<number | null> => {
  const parsedNow = v.safeParse(IsoTimestampSchema, now);
  if (!parsedNow.success) throw new JourneyDatasetStorageError('INVALID_DATASET');
  const raw = await store.readCurrent();
  if (raw === null) return null;
  const parsed = parseJourneyDataset(raw);
  if (!parsed.ok) throw new JourneyDatasetStorageError('INVALID_DATASET');
  const nowMilliseconds = Date.parse(parsedNow.output);
  const deadlines = parsed.dataset.records.map(
    (record) => Date.parse(record.verifiedAt) + JOURNEY_VERIFICATION_MAX_AGE_MS,
  );
  if (deadlines.some((deadline) => Number.isFinite(deadline) && deadline <= nowMilliseconds)) {
    return nowMilliseconds;
  }
  const future = deadlines.filter(
    (deadline): deadline is number => Number.isFinite(deadline) && deadline > nowMilliseconds,
  );
  return future.length === 0 ? null : Math.min(...future);
};

/**
 * Creates the internal maintenance boundary for the JourneyDatasetDO-owned dataset. No KV publish,
 * global registry, or production fixture fallback is hidden behind this factory.
 */
export const createJourneyDatasetOwner = (storage: DurableObjectStorage): JourneyDatasetOwner => {
  const store = createDurableJourneyDatasetStore(storage);
  const reader = createJourneyReader(store);
  return {
    read: (context) => reader.read(context),
    execute: (command) => {
      switch (command.kind) {
        case 'import':
          return importJourneyDataset(store, command.input, command.now, command.expectedRevision);
        case 'rollback':
          return rollbackJourneyDataset(
            store,
            command.targetRevision,
            command.now,
            command.expectedRevision,
          );
        case 'expire':
          return expireJourneyDataset(store, command.now);
      }
    },
    nextExpiryAt: (now) => nextExpiryAt(store, now),
  };
};
