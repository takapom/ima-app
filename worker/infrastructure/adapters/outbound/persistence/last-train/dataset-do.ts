import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { IsoTimestampSchema, type Issue, type JourneyServiceDateContext } from '@ima/core';
import {
  createJourneyDatasetOwner,
  type JourneyDatasetCommandResult,
  type JourneyDatasetExecutionResult,
} from '@worker/infrastructure/adapters/outbound/persistence/last-train/owner';
import { type JourneyReadResult } from '@worker/infrastructure/adapters/outbound/persistence/last-train/reader';
import { JOURNEY_DATASET_MAX_RECORDS } from '@worker/infrastructure/adapters/outbound/persistence/last-train/types';
import { JourneyDatasetStorageError } from '@worker/infrastructure/adapters/outbound/persistence/last-train/store';

export { JOURNEY_DATASET_DO_NAME } from '@worker/infrastructure/adapters/outbound/persistence/last-train/dataset-identity';

const revision = v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)));
const records = v.pipe(v.array(v.unknown()), v.maxLength(JOURNEY_DATASET_MAX_RECORDS));

/** The RPC input never accepts a client supplied clock. The DO receives serverNow separately. */
export const JourneyDatasetRpcCommandSchema = v.union([
  v.strictObject({
    kind: v.literal('import'),
    records,
    expectedRevision: revision,
  }),
  v.strictObject({
    kind: v.literal('update'),
    records,
    expectedRevision: revision,
  }),
  v.strictObject({
    kind: v.literal('rollback'),
    targetRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    expectedRevision: revision,
  }),
  v.strictObject({ kind: v.literal('expire') }),
]);
export type JourneyDatasetRpcCommand = v.InferOutput<typeof JourneyDatasetRpcCommandSchema>;

export class JourneyDatasetRpcError extends Error {
  readonly code: 'INVALID_COMMAND' | 'INVALID_CLOCK';

  constructor(code: 'INVALID_COMMAND' | 'INVALID_CLOCK') {
    super(`journey dataset RPC rejected: ${code}`);
    this.name = 'JourneyDatasetRpcError';
    this.code = code;
  }
}

const alarmFailure = (
  result: Exclude<JourneyDatasetCommandResult, { status: 'rejected' }>,
): JourneyDatasetExecutionResult => ({
  status: 'alarm_failed',
  commandStatus: result.status,
  revision: result.revision,
  issues: [
    {
      code: 'MISSING_CONTEXT' satisfies Issue['code'],
      path: 'journey.alarm',
      retryable: true,
      retryAfterMs: null,
      message: 'journey dataset expiry alarm could not be synchronized',
      missingFields: [],
    },
  ],
});

/**
 * A single named SQLite Durable Object owns the shared, manually verified dataset. It exposes
 * only typed RPC methods; public thread requests never receive this binding directly.
 */
export class JourneyDatasetDO extends DurableObject {
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(() =>
      Promise.resolve().then(() => {
        createJourneyDatasetOwner(ctx.storage);
      }),
    );
  }

  private async executeInternal(
    command: JourneyDatasetRpcCommand,
    serverNow: string,
  ): Promise<JourneyDatasetExecutionResult> {
    await this.ready;
    const parsedCommand = v.safeParse(JourneyDatasetRpcCommandSchema, command);
    if (!parsedCommand.success) throw new JourneyDatasetRpcError('INVALID_COMMAND');
    const parsedNow = v.safeParse(IsoTimestampSchema, serverNow);
    if (!parsedNow.success) throw new JourneyDatasetRpcError('INVALID_CLOCK');

    const owner = createJourneyDatasetOwner(this.ctx.storage);
    const result =
      parsedCommand.output.kind === 'rollback'
        ? await owner.execute({
            kind: 'rollback',
            targetRevision: parsedCommand.output.targetRevision,
            now: parsedNow.output,
            expectedRevision: parsedCommand.output.expectedRevision,
          })
        : parsedCommand.output.kind === 'expire'
          ? await owner.execute({ kind: 'expire', now: parsedNow.output })
          : await owner.execute({
              kind: 'import',
              input: { records: parsedCommand.output.records },
              now: parsedNow.output,
              expectedRevision: parsedCommand.output.expectedRevision,
            });
    if (result.status === 'rejected') return result;
    try {
      const alarmAt = await owner.nextExpiryAt(parsedNow.output);
      await this.synchronizeAlarm(alarmAt);
      return result;
    } catch {
      return alarmFailure(result);
    }
  }

  async execute(
    command: JourneyDatasetRpcCommand,
    serverNow: string,
  ): Promise<JourneyDatasetExecutionResult> {
    return this.executeInternal(command, serverNow);
  }

  protected synchronizeAlarm(alarmAt: number | null): Promise<void> {
    return alarmAt === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(alarmAt);
  }

  /** Uses the real Worker clock for scheduled maintenance; tests override this protected seam. */
  protected serverNow(): string {
    return new Date().toISOString();
  }

  async alarm(): Promise<void> {
    const now = this.serverNow();
    const parsedNow = v.safeParse(IsoTimestampSchema, now);
    if (!parsedNow.success) throw new JourneyDatasetRpcError('INVALID_CLOCK');
    const result = await this.executeInternal({ kind: 'expire' }, parsedNow.output);
    if (result.status === 'rejected' || result.status === 'alarm_failed') {
      throw new Error('journey dataset expiry alarm failed');
    }
  }

  async read(context: JourneyServiceDateContext): Promise<JourneyReadResult> {
    await this.ready;
    return createJourneyDatasetOwner(this.ctx.storage).read(context);
  }

  /** Reads only the active revision; the dataset payload never crosses this RPC boundary. */
  async readRevision(): Promise<number | null> {
    await this.ready;
    const row = this.ctx.storage.sql
      .exec<{ readonly current_revision: number | null }>(
        'SELECT current_revision FROM m14_last_train_state WHERE singleton = 1',
      )
      .toArray()[0];
    if (row === undefined) throw new JourneyDatasetStorageError('READ_FAILED');
    if (row.current_revision === null) return null;
    if (!Number.isSafeInteger(row.current_revision) || row.current_revision < 1) {
      throw new JourneyDatasetStorageError('READ_FAILED');
    }
    return row.current_revision;
  }
}
