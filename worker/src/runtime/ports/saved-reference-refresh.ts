import type { RetentionMetadata } from '@ima/contracts';
import type { SourceRef } from '@worker/domain/evidence/evidence';

export type SavedReferenceRefreshRetentionInput = {
  readonly ownerScopeRef: string;
  readonly savedPlaceRef: string;
  readonly provider: string;
  readonly recordRef: string;
  readonly now: string;
  readonly sources: readonly SourceRef[];
};

/** The host supplies the field-use policy; provider payload is deliberately absent from this input. */
export type SavedReferenceRefreshRetentionPolicy = (
  input: SavedReferenceRefreshRetentionInput,
) => RetentionMetadata | undefined;

export type SavedReferenceRefreshIdInput = {
  readonly requestId: string;
  readonly savedPlaceRef: string;
  readonly recordRef: string;
};

export type SavedReferenceRefreshProjectionDependencies = {
  readonly retentionFor: SavedReferenceRefreshRetentionPolicy;
  readonly candidateIdFactory?: (input: SavedReferenceRefreshIdInput) => string;
  readonly evidenceIdFactory?: (
    input: SavedReferenceRefreshIdInput & { readonly index: number },
  ) => string;
};
