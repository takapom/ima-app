import * as v from 'valibot';
import type { CommitPort } from '@ima/core';
import { IsoTimestampSchema } from '@ima/core';
import {
  createRuntimeProductionConnectionOptions,
  type RuntimeProductionOverrides,
} from '../runtime/runtime-production-factory';
import { sessionExpiryAt } from '../runtime/runtime-production-support';
import { createDurableRuntimeContextPersistence } from './runtime-context-persistence';
import type { RuntimeThinkConnectionOptions } from '../runtime/runtime-think-connection';
import { RuntimeThinkHost } from './runtime-host';

type RuntimeRetentionAnchorRow = { readonly thread_created_at: string };

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
  Env extends Cloudflare.Env = Cloudflare.Env,
> extends RuntimeThinkHost<Env> {
  private readonly productionEnv: Env;
  private readonly productionContextPersistence: ReturnType<
    typeof createDurableRuntimeContextPersistence
  >;
  private readonly productionThreadCreatedAt: string | undefined;
  private readonly productionAnchorError: Error | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.productionEnv = env;
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
  }

  protected createRuntimeProductionOverrides(): RuntimeProductionOverrides {
    const threadCreatedAt = this.productionThreadCreatedAt;
    if (this.productionAnchorError !== undefined || threadCreatedAt === undefined) {
      throw this.productionAnchorError ?? new Error('RUNTIME_RETENTION_ANCHOR_INVALID');
    }
    return {
      threadCreatedAt,
      contextPersistence: this.productionContextPersistence,
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
