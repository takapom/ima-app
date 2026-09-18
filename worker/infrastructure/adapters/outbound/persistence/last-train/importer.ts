import * as v from 'valibot';
import {
  IsoTimestampSchema,
  validateJourneyRecord,
  type Issue,
  type JourneyRecord,
} from '@ima/core';
import {
  JourneyDatasetStorageError,
  type JourneyDatasetMutationStore,
} from '@worker/infrastructure/adapters/outbound/persistence/last-train/store';
import {
  JOURNEY_DATASET_SCHEMA_VERSION,
  JourneyDatasetEnvelopeSchema,
  JourneyImportInputSchema,
  parseJourneyDataset,
  type JourneyDatasetEnvelope,
} from '@worker/infrastructure/adapters/outbound/persistence/last-train/types';

export type JourneyImportResult =
  | { readonly status: 'imported'; readonly revision: number; readonly recordCount: number }
  | {
      readonly status: 'rejected';
      readonly reason: 'invalid' | 'conflict' | 'storage';
      readonly issues: readonly Issue[];
    };

export type JourneyMaintenanceResult =
  | { readonly status: 'updated'; readonly revision: number; readonly removed: readonly string[] }
  | {
      readonly status: 'unchanged';
      readonly revision: number | null;
      readonly removed: readonly [];
    }
  | {
      readonly status: 'rejected';
      readonly reason: 'invalid' | 'conflict' | 'storage';
      readonly issues: readonly Issue[];
    };

const issue = (
  code: Issue['code'],
  path: string,
  message: string,
  missingFields: readonly string[] = [],
): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [...missingFields],
});

const invalidInput = (path: string): Issue =>
  issue('INVALID_EVIDENCE', path, 'journey record does not satisfy the Core contract');

const parseImportRecords = (
  input: unknown,
  now: string,
):
  | { readonly ok: true; readonly records: readonly JourneyRecord[] }
  | { readonly ok: false; readonly issues: readonly Issue[] } => {
  const parsedInput = v.safeParse(JourneyImportInputSchema, input);
  if (!parsedInput.success) return { ok: false, issues: [invalidInput('records')] };
  const parsedNow = v.safeParse(IsoTimestampSchema, now);
  if (!parsedNow.success) {
    return {
      ok: false,
      issues: [issue('MISSING_CONTEXT', 'journey.now', 'import clock is invalid')],
    };
  }
  const records: JourneyRecord[] = [];
  const issues: Issue[] = [];
  for (const [index, rawRecord] of parsedInput.output.records.entries()) {
    const validated = validateJourneyRecord(rawRecord, parsedNow.output);
    if (validated.status === 'invalid') {
      const recordIssues =
        validated.issues.length > 0 ? validated.issues : [invalidInput(`records[${index}]`)];
      for (const recordIssue of recordIssues) {
        issues.push({ ...recordIssue, path: `records[${index}].${recordIssue.path ?? 'journey'}` });
      }
      continue;
    }
    records.push(validated.journey);
  }
  if (new Set(records.map((record) => record.journeyRef)).size !== records.length) {
    issues.push(issue('CONSTRAINT_VIOLATION', 'records', 'journey references must be unique'));
  }
  return issues.length === 0 ? { ok: true, records } : { ok: false, issues };
};

const readDataset = async (
  store: JourneyDatasetMutationStore,
): Promise<
  | { readonly ok: true; readonly dataset: JourneyDatasetEnvelope | null }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'storage';
      readonly issues: readonly Issue[];
    }
> => {
  let raw: unknown;
  try {
    raw = await store.readCurrent();
  } catch {
    return {
      ok: false,
      reason: 'storage',
      issues: [
        issue('MISSING_CONTEXT', 'journey.storage', 'journey dataset storage is unavailable'),
      ],
    };
  }
  if (raw === null) return { ok: true, dataset: null };
  const parsed = parseJourneyDataset(raw);
  return parsed.ok
    ? { ok: true, dataset: parsed.dataset }
    : {
        ok: false,
        reason: 'invalid',
        issues: [
          issue('INVALID_EVIDENCE', 'journey.dataset', 'active journey dataset is invalid', [
            'records',
          ]),
        ],
      };
};

const commitRevision = async (
  store: JourneyDatasetMutationStore,
  dataset: JourneyDatasetEnvelope,
  expectedRevision: number | null,
): Promise<JourneyImportResult> => {
  try {
    const activated = await store.commitRevision(dataset, expectedRevision);
    if (!activated.ok) {
      return {
        status: 'rejected',
        reason: 'conflict',
        issues: [
          issue('STALE_TURN', 'journey.revision', 'journey dataset revision changed during update'),
        ],
      };
    }
    return { status: 'imported', revision: dataset.revision, recordCount: dataset.records.length };
  } catch (error: unknown) {
    if (error instanceof JourneyDatasetStorageError && error.code === 'INVALID_DATASET') {
      return { status: 'rejected', reason: 'invalid', issues: [invalidInput('records')] };
    }
    return {
      status: 'rejected',
      reason: 'storage',
      issues: [
        issue('MISSING_CONTEXT', 'journey.storage', 'journey dataset storage is unavailable'),
      ],
    };
  }
};

/** Validates and atomically activates a complete replacement dataset. */
export const importJourneyDataset = async (
  store: JourneyDatasetMutationStore,
  input: unknown,
  now: string,
  expectedRevision: number | null,
): Promise<JourneyImportResult> => {
  const records = parseImportRecords(input, now);
  if (!records.ok) return { status: 'rejected', reason: 'invalid', issues: records.issues };
  const current = await readDataset(store);
  if (!current.ok) return { status: 'rejected', reason: current.reason, issues: current.issues };
  const currentRevision = current.dataset?.revision ?? null;
  if (currentRevision !== expectedRevision) {
    return {
      status: 'rejected',
      reason: 'conflict',
      issues: [issue('STALE_TURN', 'journey.revision', 'journey dataset revision is stale')],
    };
  }
  const revision = (currentRevision ?? 0) + 1;
  const dataset = {
    schemaVersion: JOURNEY_DATASET_SCHEMA_VERSION,
    revision,
    importedAt: now,
    sourceRevision: currentRevision,
    records: records.records,
  };
  const parsed = v.safeParse(JourneyDatasetEnvelopeSchema, dataset);
  if (!parsed.success)
    return { status: 'rejected', reason: 'invalid', issues: [invalidInput('records')] };
  const result = await commitRevision(store, parsed.output, expectedRevision);
  return result.status === 'imported'
    ? result
    : { status: 'rejected', reason: result.reason, issues: result.issues };
};

/** Activates a validated historical revision as a new monotonic revision. */
export const rollbackJourneyDataset = async (
  store: JourneyDatasetMutationStore,
  targetRevision: number,
  now: string,
  expectedRevision: number | null,
): Promise<JourneyImportResult> => {
  const current = await readDataset(store);
  if (!current.ok) return { status: 'rejected', reason: current.reason, issues: current.issues };
  const currentRevision = current.dataset?.revision ?? null;
  if (currentRevision !== expectedRevision) {
    return {
      status: 'rejected',
      reason: 'conflict',
      issues: [issue('STALE_TURN', 'journey.revision', 'journey dataset revision is stale')],
    };
  }
  let rawTarget: unknown;
  try {
    rawTarget = await store.readRevision(targetRevision);
  } catch {
    return {
      status: 'rejected',
      reason: 'storage',
      issues: [
        issue('MISSING_CONTEXT', 'journey.storage', 'journey dataset storage is unavailable'),
      ],
    };
  }
  const parsedTarget = parseJourneyDataset(rawTarget);
  if (!parsedTarget.ok) {
    return {
      status: 'rejected',
      reason: 'invalid',
      issues: [
        issue('MISSING_EVIDENCE', 'journey.revision', 'target journey revision is unavailable', [
          'revision',
        ]),
      ],
    };
  }
  const records = parseImportRecords({ records: parsedTarget.dataset.records }, now);
  if (!records.ok) return { status: 'rejected', reason: 'invalid', issues: records.issues };
  const revision = (currentRevision ?? 0) + 1;
  const dataset = v.safeParse(JourneyDatasetEnvelopeSchema, {
    schemaVersion: JOURNEY_DATASET_SCHEMA_VERSION,
    revision,
    importedAt: now,
    sourceRevision: targetRevision,
    records: records.records,
  });
  if (!dataset.success)
    return { status: 'rejected', reason: 'invalid', issues: [invalidInput('records')] };
  const result = await commitRevision(store, dataset.output, expectedRevision);
  return result.status === 'imported'
    ? result
    : { status: 'rejected', reason: result.reason, issues: result.issues };
};

/** Removes only records that the shared Core validator now marks stale. */
export const expireJourneyDataset = async (
  store: JourneyDatasetMutationStore,
  now: string,
): Promise<JourneyMaintenanceResult> => {
  const current = await readDataset(store);
  if (!current.ok) return { status: 'rejected', reason: current.reason, issues: current.issues };
  if (current.dataset === null) return { status: 'unchanged', revision: null, removed: [] };
  const parsedNow = v.safeParse(IsoTimestampSchema, now);
  if (!parsedNow.success)
    return {
      status: 'rejected',
      reason: 'invalid',
      issues: [issue('MISSING_CONTEXT', 'journey.now', 'expiry clock is invalid')],
    };
  const keep: JourneyRecord[] = [];
  const removed: string[] = [];
  for (const record of current.dataset.records) {
    const validation = validateJourneyRecord(record, parsedNow.output);
    if (validation.status === 'valid') {
      keep.push(validation.journey);
    } else if (validation.issues.some((item) => item.code === 'STALE_EVIDENCE')) {
      removed.push(record.journeyRef);
    } else {
      return { status: 'rejected', reason: 'invalid', issues: validation.issues };
    }
  }
  if (removed.length === 0) {
    return { status: 'unchanged', revision: current.dataset.revision, removed: [] };
  }
  const next = v.safeParse(JourneyDatasetEnvelopeSchema, {
    schemaVersion: JOURNEY_DATASET_SCHEMA_VERSION,
    revision: current.dataset.revision + 1,
    importedAt: parsedNow.output,
    sourceRevision: current.dataset.revision,
    records: keep,
  });
  if (!next.success)
    return { status: 'rejected', reason: 'invalid', issues: [invalidInput('records')] };
  try {
    const activated = await store.commitRevision(next.output, current.dataset.revision);
    if (!activated.ok)
      return {
        status: 'rejected',
        reason: 'conflict',
        issues: [issue('STALE_TURN', 'journey.revision', 'journey dataset revision is stale')],
      };
    return { status: 'updated', revision: next.output.revision, removed };
  } catch {
    return {
      status: 'rejected',
      reason: 'storage',
      issues: [
        issue('MISSING_CONTEXT', 'journey.storage', 'journey dataset storage is unavailable'),
      ],
    };
  }
};
