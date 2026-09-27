import * as v from 'valibot';
import { PhotoInfoSchema } from '@worker/domain/places/place-values';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { CommittedResponse } from '@worker/application/use-cases/submit-response/submit-application';
import type { ReadonlyStoredObservation } from '@worker/domain/candidates/registry';
import type { RegistryScope } from '@worker/domain/evidence/freshness';
import type { PhotoTokenObservation } from '@worker/application/use-cases/photos/prepare-photo-tokens';
export type PhotoTokenEvidenceSource = {
  readonly registry: Pick<CandidateObservationRegistryPort, 'readObservation'>;
  readonly scope: RegistryScope;
  readonly now: string;
  /** Capability is explicit; an omitted/false gate must never issue photo handles. */
  readonly photosEnabled: boolean;
  /** Display policy is resolved per observation and is independent from model/persistence policy. */
  readonly persistenceAllowedFor: (source: ReadonlyStoredObservation) => boolean;
  readonly displayAllowedFor: (source: ReadonlyStoredObservation) => boolean;
};

const isPhotoDisplayWindowOpen = (source: ReadonlyStoredObservation, now: string): boolean => {
  if (source.retention.displayPolicyStatus !== 'available') return false;
  if (source.retention.displayUntil === null) return false;
  const nowMilliseconds = Date.parse(now);
  const fetchedAtMilliseconds = Date.parse(source.fetchedAt);
  const freshUntilMilliseconds = Date.parse(source.freshUntil);
  const providerExpiresAtMilliseconds = Date.parse(source.expiresAt);
  const sessionExpiresAtMilliseconds = Date.parse(source.retention.sessionExpiresAt);
  const displayUntilMilliseconds = Date.parse(source.retention.displayUntil);
  if (
    !Number.isFinite(nowMilliseconds) ||
    !Number.isFinite(fetchedAtMilliseconds) ||
    !Number.isFinite(freshUntilMilliseconds) ||
    !Number.isFinite(providerExpiresAtMilliseconds) ||
    !Number.isFinite(sessionExpiresAtMilliseconds) ||
    !Number.isFinite(displayUntilMilliseconds)
  ) {
    return false;
  }
  return (
    fetchedAtMilliseconds <= nowMilliseconds &&
    nowMilliseconds < freshUntilMilliseconds &&
    nowMilliseconds < providerExpiresAtMilliseconds &&
    nowMilliseconds < sessionExpiresAtMilliseconds &&
    nowMilliseconds < displayUntilMilliseconds
  );
};

/** Reads only the committed cards' photo evidence; provider references stay inside this boundary. */
export const collectPhotoTokenObservations = (
  response: CommittedResponse,
  input: PhotoTokenEvidenceSource,
): PhotoTokenObservation[] => {
  if (!input.photosEnabled || response.presentation === 'keep') return [];
  const observations: PhotoTokenObservation[] = [];
  for (const card of [response.hero, ...response.alts]) {
    if (card.photos === null) continue;
    for (const evidenceId of card.evidenceIds) {
      const source = input.registry.readObservation(input.scope, evidenceId);
      if (
        source === undefined ||
        source.candidateId !== card.candidateId ||
        source.field !== 'photos'
      ) {
        continue;
      }
      const parsed = v.safeParse(PhotoInfoSchema, source.value);
      if (!parsed.success) continue;
      const observedRefs = new Set(parsed.output.photos.map((photo) => photo.photoRef));
      const displayAllowed =
        input.displayAllowedFor(source) && isPhotoDisplayWindowOpen(source, input.now);
      for (const photo of card.photos.photos) {
        if (!observedRefs.has(photo.photoRef)) continue;
        observations.push({
          candidateId: card.candidateId,
          photoRef: photo.photoRef,
          displayAllowed,
          persistUntil:
            input.persistenceAllowedFor(source) &&
            source.retention.retentionDecision === 'allow' &&
            source.retention.restoreMode === 'full' &&
            source.retention.policyStatus === 'available' &&
            source.retention.retentionUntil !== null &&
            source.retention.deletionScheduledAt !== null
              ? new Date(
                  Math.min(
                    Date.parse(source.retention.retentionUntil),
                    Date.parse(source.retention.deletionScheduledAt),
                  ),
                ).toISOString()
              : null,
          sessionExpiresAt: source.retention.sessionExpiresAt,
          displayUntil: source.retention.displayUntil,
          providerExpiresAt: source.expiresAt,
        });
      }
    }
  }
  return observations;
};
