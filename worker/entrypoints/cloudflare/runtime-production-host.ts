import * as v from 'valibot';
import type { Session } from '@cloudflare/think';
import type { CommitPort, RegistryScope } from '@ima/core';
import { IsoTimestampSchema } from '@ima/core';
import {
  createRuntimeProductionConnectionOptions,
  type RuntimeProductionOverrides,
} from '@worker/composition/runtime-production-factory';
import { sessionExpiryAt } from '@worker/composition/runtime-production-support';
import { createDurableRuntimeContextPersistence } from '@worker/infrastructure/runtime/threads/runtime-context-persistence';
import type { RuntimeProductionContextReference } from '@worker/infrastructure/runtime/context/runtime-production-context-reference';
import { createRuntimeRetentionAlarmCapability } from '@worker/infrastructure/runtime/threads/runtime-retention-alarm';
import type { RuntimeThinkConnectionOptions } from '@worker/infrastructure/runtime/turn-execution/runtime-think-connection';
import {
  emitRuntimeTurnTrace,
  runtimeTraceModeFor,
  runtimeTurnTraceOutcome,
  telemetryObjectNameForRuntimeTraceMode,
  type RuntimeTurnTraceSink,
} from '@worker/infrastructure/runtime/tracing/runtime-turn-trace';
import type { RuntimeModelTraceSink } from '@worker/infrastructure/runtime/tracing/runtime-model-trace';
import type { RuntimeProviderTraceSink } from '@worker/infrastructure/runtime/tracing/runtime-provider-trace';
import {
  createDurableTelemetryStore,
  type TelemetryNamespace,
} from '@worker/infrastructure/adapters/outbound/persistence/telemetry/telemetry-do';
import { createRuntimeProductionTelemetrySinks } from '@worker/infrastructure/runtime/threads/runtime-production-telemetry';
import { RuntimeThinkHost } from '@worker/entrypoints/cloudflare/runtime-host';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnResult,
} from '@worker/infrastructure/runtime/threads/admission';
import { type JourneyDatasetRuntimeNamespace } from '@worker/infrastructure/adapters/outbound/persistence/last-train/dataset-binding';

type RuntimeRetentionAnchorRow = { readonly thread_created_at: string };
type RuntimeTelemetryEnv = {
  readonly IMA_RUNTIME_MODE?: unknown;
  readonly TELEMETRY?: TelemetryNamespace;
};

const durableThreadCreatedAt = (ctx: DurableObjectState): string => {
  ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS runtime_retention_anchor (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      thread_created_at TEXT NOT NULL
    )
  `);
  const current = ctx.storage.sql
    .exec<RuntimeRetentionAnchorRow>(
      'SELECT thread_created_at FROM runtime_retention_anchor WHERE singleton = 1',
    )
    .toArray()[0];
  if (current !== undefined) {
    const parsed = v.safeParse(IsoTimestampSchema, current.thread_created_at);
    if (!parsed.success) throw new Error('RUNTIME_RETENTION_ANCHOR_INVALID');
    return parsed.output;
  }
  const createdAt = new Date().toISOString();
  ctx.storage.sql.exec(
    'INSERT INTO runtime_retention_anchor (singleton, thread_created_at) VALUES (1, ?)',
    createdAt,
  );
  return createdAt;
};

/**
 * Production Think host: the DO supplies only its durable CommitPort and environment.
 * Model/provider/registry construction stays in the Worker-owned production factory.
 */
export abstract class RuntimeProductionThinkHost<
  Env extends Cloudflare.Env & { readonly JOURNEY_DATASETS?: JourneyDatasetRuntimeNamespace } =
    Cloudflare.Env & { readonly JOURNEY_DATASETS?: JourneyDatasetRuntimeNamespace },
> extends RuntimeThinkHost<Env> {
  private readonly productionEnv: Env;
  private readonly productionContextPersistence: ReturnType<
    typeof createDurableRuntimeContextPersistence
  >;
  private readonly productionThreadCreatedAt: string | undefined;
  private readonly productionAnchorError: Error | undefined;
  private readonly productionTraceSink: RuntimeTurnTraceSink | undefined;
  private readonly productionModelTraceSink: RuntimeModelTraceSink | undefined;
  private readonly productionProviderTraceSink: RuntimeProviderTraceSink | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.productionEnv = env;
    const runtimeEnv = env as RuntimeTelemetryEnv;
    const telemetry = runtimeEnv.TELEMETRY;
    const runtimeMode = runtimeTraceModeFor(runtimeEnv.IMA_RUNTIME_MODE);
    const telemetryStore =
      telemetry === undefined
        ? undefined
        : createDurableTelemetryStore(
            telemetry,
            telemetryObjectNameForRuntimeTraceMode(runtimeMode),
          );
    const telemetrySinks = createRuntimeProductionTelemetrySinks({
      store: telemetryStore,
      schedule: (promise) => ctx.waitUntil(promise),
    });
    this.productionTraceSink = telemetrySinks.turn;
    this.productionModelTraceSink = telemetrySinks.model;
    this.productionProviderTraceSink = telemetrySinks.provider;
    this.productionContextPersistence = createDurableRuntimeContextPersistence(ctx.storage);
    try {
      this.productionThreadCreatedAt = durableThreadCreatedAt(ctx);
      this.productionAnchorError = undefined;
    } catch (error: unknown) {
      // Keep the DO constructible for lifecycle RPCs, but never replace a corrupt anchor with now.
      this.productionThreadCreatedAt = undefined;
      this.productionAnchorError =
        error instanceof Error ? error : new Error('RUNTIME_RETENTION_ANCHOR_INVALID');
    }
    this.lifecycle.use(
      createRuntimeRetentionAlarmCapability({
        storage: ctx.storage,
        now: () => this.runtimeProductionNow(),
        expiryAt: () => {
          try {
            return this.runtimeProductionSessionExpiresAt();
          } catch {
            return undefined;
          }
        },
        onDue: (markComplete) => this.runtimeProductionRetentionAlarmDue(markComplete),
        rearm: () => this.lifecycle.rearmAlarm(),
      }),
    );
  }

  protected createRuntimeProductionOverrides(): RuntimeProductionOverrides {
    const threadCreatedAt = this.productionThreadCreatedAt;
    if (this.productionAnchorError !== undefined || threadCreatedAt === undefined) {
      throw this.productionAnchorError ?? new Error('RUNTIME_RETENTION_ANCHOR_INVALID');
    }
    return {
      threadCreatedAt,
      contextPersistence: this.productionContextPersistence,
      ...(this.productionModelTraceSink === undefined
        ? {}
        : { modelTraceSink: this.productionModelTraceSink }),
      ...(this.productionProviderTraceSink === undefined
        ? {}
        : { providerTraceSink: this.productionProviderTraceSink }),
    };
  }

  protected runtimeProductionNow(): string {
    return new Date().toISOString();
  }

  protected runtimeProductionSessionExpiresAt(): string {
    const threadCreatedAt = this.productionThreadCreatedAt;
    if (this.productionAnchorError !== undefined || threadCreatedAt === undefined) {
      throw this.productionAnchorError ?? new Error('RUNTIME_RETENTION_ANCHOR_INVALID');
    }
    return sessionExpiryAt(threadCreatedAt);
  }

  protected runtimeProductionSessionExpired(): boolean {
    const now = Date.parse(this.runtimeProductionNow());
    const expiresAt = Date.parse(this.runtimeProductionSessionExpiresAt());
    if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) {
      throw new Error('RUNTIME_RETENTION_CLOCK_INVALID');
    }
    return now >= expiresAt;
  }

  protected runtimeProductionContextReferenceFor(
    scope: RegistryScope,
  ): RuntimeProductionContextReference | undefined {
    return this.productionContextPersistence.load(scope);
  }

  protected recordRuntimeTurnTrace(
    target: ThreadRuntimeTarget,
    result: ThreadRuntimeTurnResult,
    durationMs?: number,
  ): void {
    if (this.productionTraceSink === undefined) return;
    try {
      emitRuntimeTurnTrace(this.productionTraceSink, {
        ownerScopeRef: target.ownerScopeRef,
        threadId: target.threadId,
        turnId: target.turnId,
        revision: target.revision,
        occurredAt: this.runtimeProductionNow(),
        ...runtimeTurnTraceOutcome({
          savedStatus: result.status,
          responseAvailable: result.status === 'completed' && result.response !== null,
          failureCode: result.code,
          cancelled: result.status === 'cancelled',
        }),
        ...(durationMs === undefined ? {} : { durationMs }),
      });
    } catch {
      // A telemetry clock/sink failure never changes the persisted runtime result.
    }
  }

  override configureSession(session: Session): Session | Promise<Session> {
    if (this.productionAnchorError !== undefined || this.productionThreadCreatedAt === undefined) {
      return session;
    }
    return super.configureSession(session);
  }

  protected runtimeProductionRetentionAlarmDue(_markComplete: () => void): Promise<boolean> {
    return Promise.resolve(false);
  }

  protected async startRuntimeLifecycle(): Promise<void> {
    if (this.productionAnchorError === undefined) this.ensureRuntimeThinkConnection();
    await this.lifecycle.start();
  }

  protected clearRuntimeProductionContext(scope: {
    readonly ownerScopeRef: string;
    readonly threadId: string;
  }): void {
    this.productionContextPersistence.clear(scope);
  }

  protected abstract createRuntimeCommitPort(): CommitPort;

  protected override createRuntimeThinkConnectionOptions():
    RuntimeThinkConnectionOptions<unknown> | undefined {
    if (this.productionAnchorError !== undefined) throw this.productionAnchorError;
    const threadCreatedAt = this.productionThreadCreatedAt;
    if (threadCreatedAt === undefined) throw new Error('RUNTIME_RETENTION_ANCHOR_INVALID');
    const overrides = this.createRuntimeProductionOverrides();
    return createRuntimeProductionConnectionOptions({
      env: this.productionEnv,
      commit: this.createRuntimeCommitPort(),
      overrides: {
        ...overrides,
        threadCreatedAt: overrides.threadCreatedAt ?? threadCreatedAt,
      },
    });
  }
}
