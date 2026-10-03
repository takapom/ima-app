export type PhotoAsset = {
  /** An expiring in-memory data URI, never persisted to disk. */
  readonly uri: string;
  readonly contentType: string;
  readonly expiresAt: string;
};
