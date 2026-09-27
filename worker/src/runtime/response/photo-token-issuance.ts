import { PhotoTokenError } from '@worker/runtime/ports/photo';
import type { PhotoTokenIssuer } from '@worker/application/ports/photo-token-issuer';
import { collectPhotoTokenObservations as collectEligiblePhotos } from '@worker/application/use-cases/photos/photo-token-observations';
import {
  preparePhotoTokens,
  PhotoTokenPreparationError,
} from '@worker/application/use-cases/photos/prepare-photo-tokens';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { CommittedResponse } from '@worker/application/use-cases/submit-response/submit-application';
import type { ReadonlyStoredObservation } from '@worker/domain/candidates/registry';
import type { RegistryScope } from '@worker/domain/evidence/freshness';
import type { RuntimePhotoTokenPreparer } from '@worker/runtime/response/runtime-response';
import {
  runtimePolicyAllows,
  type RuntimeFieldUsePolicy,
  type RuntimePolicyMode,
} from '@worker/runtime/context/runtime-field-policy';
export type PhotoTokenObservationSource = {
  readonly registry: Pick<CandidateObservationRegistryPort, 'readObservation'>;
  readonly scope: RegistryScope;
  readonly now: string;
  /** Capability is explicit; an omitted/false gate must never issue photo handles. */
  readonly photosEnabled: boolean;
  /** Display policy is resolved per observation and is independent from model/persistence policy. */
  readonly displayPolicyFor: (
    source: ReadonlyStoredObservation,
  ) => PhotoDisplayPolicySnapshot | undefined;
};

export type PhotoDisplayPolicySnapshot = {
  readonly policy: RuntimeFieldUsePolicy;
  readonly mode: RuntimePolicyMode;
};

export type PhotoTokenPreparerDependencies = Omit<PhotoTokenObservationSource, 'now'> & {
  readonly issuer: PhotoTokenIssuer;
  readonly deviceId: string;
  /** Identity of the request turn that owns the committed response and its photo references. */
  readonly sourceTurnId: string;
  readonly sourceRevision: number;
};

/** Maps a runtime provider-policy snapshot to the application's display decision. */
export const collectPhotoTokenObservations = (
  response: CommittedResponse,
  input: PhotoTokenObservationSource,
) =>
  collectEligiblePhotos(response, {
    registry: input.registry,
    scope: input.scope,
    now: input.now,
    photosEnabled: input.photosEnabled,
    persistenceAllowedFor: (source) => {
      const snapshot = input.displayPolicyFor(source);
      return (
        snapshot !== undefined && runtimePolicyAllows(snapshot.policy, 'persistence', snapshot.mode)
      );
    },
    displayAllowedFor: (source) => {
      const snapshot = input.displayPolicyFor(source);
      return (
        snapshot !== undefined && runtimePolicyAllows(snapshot.policy, 'display', snapshot.mode)
      );
    },
  });
/** Binds one thread's registry and device scope to the runtime's pre-commit preparation. */
export const createPhotoTokenPreparer =
  (dependencies: PhotoTokenPreparerDependencies): RuntimePhotoTokenPreparer =>
  async ({ response, metadata, now }) => {
    if (
      metadata.threadId !== dependencies.scope.threadId ||
      metadata.turnId !== dependencies.sourceTurnId
    ) {
      throw new PhotoTokenError('INVALID_INPUT');
    }
    const observations = collectPhotoTokenObservations(response, {
      registry: dependencies.registry,
      scope: dependencies.scope,
      now,
      photosEnabled: dependencies.photosEnabled,
      displayPolicyFor: dependencies.displayPolicyFor,
    });
    try {
      const prepared = await preparePhotoTokens(dependencies.issuer, observations, {
        ownerScopeRef: dependencies.scope.ownerScopeRef,
        threadId: dependencies.scope.threadId,
        sourceTurnId: dependencies.sourceTurnId,
        sourceRevision: dependencies.sourceRevision,
        deviceId: dependencies.deviceId,
        now,
      });
      return { resolve: prepared.resolve, resolvePersistent: prepared.resolvePersistent };
    } catch (error: unknown) {
      if (error instanceof PhotoTokenPreparationError) throw new PhotoTokenError('INVALID_INPUT');
      throw error;
    }
  };
