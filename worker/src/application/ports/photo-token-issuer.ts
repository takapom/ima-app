export type PhotoTokenIssueInput = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly deviceId: string;
  /** Opaque provider reference; only the adapter interprets its format. */
  readonly photoRef: string;
  readonly expiresAt: string;
  /** Explicit persistence permission; expiresAt is already bounded by the retention deadline. */
  readonly persist?: boolean;
};
export type PhotoTokenIssueResult =
  { readonly status: 'issued'; readonly token: string } | { readonly status: 'withheld' };
export type PhotoTokenIssuer = {
  issue(input: PhotoTokenIssueInput, now: string): Promise<PhotoTokenIssueResult>;
};
