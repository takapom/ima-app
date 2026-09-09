import { DurableObject } from 'cloudflare:workers';

export type RateLimitConfig = {
  readonly windowMs: number;
  readonly devicePerWindow: number;
  readonly ownerPerWindow: number;
};

export type RateLimitCheckInput = {
  readonly ownerScopeRef: string;
  readonly deviceId: string;
  readonly route: string;
  readonly config: RateLimitConfig;
};

export type RateLimitCheckResult =
  | { readonly allowed: true; readonly retryAfterSeconds: null }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

type RateWindowRow = {
  readonly key: string;
  readonly started_at: number;
  readonly count: number;
};

const validRateConfig = (config: RateLimitConfig): boolean =>
  Number.isSafeInteger(config.windowMs) &&
  config.windowMs > 0 &&
  Number.isSafeInteger(config.devicePerWindow) &&
  config.devicePerWindow > 0 &&
  Number.isSafeInteger(config.ownerPerWindow) &&
  config.ownerPerWindow > 0;

export class RateLimitDO extends DurableObject {
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(() =>
      Promise.resolve().then(() => {
        ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS rate_window (
            key TEXT PRIMARY KEY,
            started_at INTEGER NOT NULL,
            count INTEGER NOT NULL
          )
        `);
      }),
    );
  }

  private window(key: string): RateWindowRow | undefined {
    return this.ctx.storage.sql
      .exec<RateWindowRow>('SELECT key, started_at, count FROM rate_window WHERE key = ?', key)
      .toArray()[0];
  }

  private writeWindow(key: string, startedAt: number, count: number): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO rate_window (key, started_at, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET started_at = excluded.started_at, count = excluded.count',
      key,
      startedAt,
      count,
    );
  }

  async check(input: RateLimitCheckInput): Promise<RateLimitCheckResult> {
    await this.ready;
    if (!validRateConfig(input.config)) throw new Error('RATE_LIMIT_CONFIGURATION');
    void input.route;
    const now = Date.now();
    const ownerKey = `owner:${input.ownerScopeRef}`;
    const deviceKey = `device:${input.deviceId}`;
    const owner = this.window(ownerKey);
    const device = this.window(deviceKey);
    const ownerActive = owner !== undefined && now - owner.started_at < input.config.windowMs;
    const deviceActive = device !== undefined && now - device.started_at < input.config.windowMs;
    const ownerCount = ownerActive ? owner.count : 0;
    const deviceCount = deviceActive ? device.count : 0;
    const ownerLimited = ownerCount >= input.config.ownerPerWindow;
    const deviceLimited = deviceCount >= input.config.devicePerWindow;
    if (ownerLimited || deviceLimited) {
      const startedAt = ownerLimited ? owner?.started_at : device?.started_at;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(((startedAt ?? now) + input.config.windowMs - now) / 1_000),
      );
      return { allowed: false, retryAfterSeconds };
    }
    this.writeWindow(ownerKey, ownerActive ? (owner?.started_at ?? now) : now, ownerCount + 1);
    this.writeWindow(deviceKey, deviceActive ? (device?.started_at ?? now) : now, deviceCount + 1);
    return { allowed: true, retryAfterSeconds: null };
  }
}
