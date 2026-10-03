import type { PhotoAsset } from '@mobile/platform/http/photo-asset';

/** Bounded, credential-scoped memory only. Neither data URIs nor expired assets reach SQLite. */
export class PhotoMemoryCache {
  private scope: string | null = null;
  private readonly entries = new Map<
    string,
    { asset: PhotoAsset; timer: ReturnType<typeof setTimeout> }
  >();
  selectScope(scope: string): void {
    if (this.scope === scope) return;
    for (const key of this.entries.keys()) this.remove(key);
    this.scope = scope;
  }
  clear(): void {
    for (const key of this.entries.keys()) this.remove(key);
    this.scope = null;
  }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry !== undefined) clearTimeout(entry.timer);
    this.entries.delete(key);
  }
  read(key: string, now: number, refresh = false): PhotoAsset | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (refresh || Date.parse(entry.asset.expiresAt) <= now) {
      this.remove(key);
      return undefined;
    }
    return entry.asset;
  }
  write(scope: string, key: string, asset: PhotoAsset, now: number): void {
    if (scope !== this.scope) return; // Old credential requests may finish after an account switch.
    this.remove(key);
    const lifetime = Date.parse(asset.expiresAt) - now;
    if (!Number.isFinite(lifetime) || lifetime <= 0) return;
    while (this.entries.size >= 12) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.remove(first);
    }
    this.entries.set(key, { asset, timer: setTimeout(() => this.remove(key), lifetime) });
  }
}
