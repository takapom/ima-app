/**
 * セッション失効後の後始末を一度だけ走らせる関門。
 * 期限切れなら true。時計やアンカーの例外も期限切れとして扱い、残った実行状態を残さない。
 */
export type SessionExpiryGate = (onCleanupComplete?: () => void) => Promise<boolean>;

/**
 * 失効判定と後始末を組み立てる。
 * 後始末の失敗は完了にせず、次の呼び出しで同じ経路を残す。写真の消去は文脈の消去が失敗しても試みる。
 */
export const createSessionExpiryGate = (input: {
  readonly isExpired: () => boolean;
  readonly readScope: () =>
    { readonly ownerScopeRef: string; readonly threadId: string } | undefined;
  readonly cleanupRuntime: () => Promise<void>;
  readonly clearContext: (scope: {
    readonly ownerScopeRef: string;
    readonly threadId: string;
  }) => void;
  readonly clearPhotos: () => Promise<void>;
}): SessionExpiryGate => {
  let cleanupDone = false;
  return async (onCleanupComplete) => {
    let expired = false;
    try {
      expired = input.isExpired();
    } catch {
      /** 時計異常は fail-closed。無効 anchor でも掃除経路は走らせる。 */
      expired = true;
    }
    if (!expired) return false;
    if (cleanupDone) {
      try {
        onCleanupComplete?.();
      } catch {
        /** 完了マーカー書き込み失敗時は再試行させる。 */
        return true;
      }
      return true;
    }
    let cleanupSucceeded = true;
    let scope: { readonly ownerScopeRef: string; readonly threadId: string } | undefined;
    try {
      scope = input.readScope();
    } catch {
      cleanupSucceeded = false;
    }
    try {
      await input.cleanupRuntime();
    } catch {
      /** SDK 掃除が要リトライなら期限処理も fail-closed のまま。 */
      cleanupSucceeded = false;
    }
    try {
      if (scope !== undefined) input.clearContext(scope);
    } catch {
      cleanupSucceeded = false;
    } finally {
      try {
        await input.clearPhotos();
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (cleanupSucceeded) {
      try {
        onCleanupComplete?.();
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (cleanupSucceeded) cleanupDone = true;
    return true;
  };
};
