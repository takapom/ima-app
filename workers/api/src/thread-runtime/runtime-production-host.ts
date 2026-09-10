import type { CommitPort } from '@ima/core';
import {
  createRuntimeProductionConnectionOptions,
  type RuntimeProductionOverrides,
} from '../runtime/runtime-production-factory';
import type { RuntimeThinkConnectionOptions } from '../runtime/runtime-think-connection';
import { RuntimeThinkHost } from './runtime-host';

/**
 * Production Think host: the DO supplies only its durable CommitPort and environment.
 * Model/provider/registry construction stays in the Worker-owned production factory.
 */
export abstract class RuntimeProductionThinkHost<
  Env extends Cloudflare.Env = Cloudflare.Env,
> extends RuntimeThinkHost<Env> {
  private readonly productionEnv: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.productionEnv = env;
  }

  protected createRuntimeProductionOverrides(): RuntimeProductionOverrides {
    return {};
  }

  protected abstract createRuntimeCommitPort(): CommitPort;

  protected override createRuntimeThinkConnectionOptions():
    RuntimeThinkConnectionOptions<unknown> | undefined {
    return createRuntimeProductionConnectionOptions({
      env: this.productionEnv,
      commit: this.createRuntimeCommitPort(),
      overrides: this.createRuntimeProductionOverrides(),
    });
  }
}
