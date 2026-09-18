import type { ModelContextFieldPolicy, RetentionMetadata } from '@ima/core';
import type { RuntimeProductionOverrides } from '@worker/composition/runtime-production-types';
import type {
  PhotoDisplayPolicySnapshot,
  PhotoTokenObservationSource,
} from '@worker/infrastructure/runtime/response/photo-token-issuance';
import {
  sessionExpiryAt,
  type ProductionObservationPolicyInput,
} from '@worker/composition/runtime-production-support';

/** Application usage policy for the selected provider; not a claim of provider-side verification. */
export const hotPepperModelContextPolicy: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    facilities: 'allow',
    photos: 'allow',
    contact: 'deny',
    walking_route: 'deny',
    last_train: 'deny',
  },
  history: 'allow',
  cardSet: 'allow',
  displayName: 'allow',
};

const photoDisplayPolicy: PhotoDisplayPolicySnapshot = {
  mode: 'live',
  policy: {
    display: {
      decision: 'allow',
      activation: 'app_configured',
      fieldStatus: 'known',
      policyStatus: 'available',
    },
    llm_input: {
      decision: 'deny',
      activation: 'app_configured',
      fieldStatus: 'known',
      policyStatus: 'available',
    },
    persistence: {
      decision: 'deny',
      activation: 'app_configured',
      fieldStatus: 'known',
      policyStatus: 'available',
    },
  },
};

export const hotPepperPhotoDisplayPolicy: PhotoTokenObservationSource['displayPolicyFor'] = (
  source,
) =>
  source.field === 'photos' &&
  source.sources.length > 0 &&
  source.sources.every((item) => item.provider === 'hotpepper')
    ? photoDisplayPolicy
    : undefined;

const retentionAt = (now: string): RetentionMetadata => {
  const expiresAt = sessionExpiryAt(now);
  return {
    retentionDecision: 'allow',
    retentionMode: 'provider_limited',
    sessionExpiresAt: expiresAt,
    freshUntil: new Date(
      Math.min(Date.parse(expiresAt), Date.parse(now) + 30 * 60_000),
    ).toISOString(),
    displayUntil: expiresAt,
    retentionUntil: expiresAt,
    deletionScheduledAt: expiresAt,
    attribution: {
      label: 'Powered by ホットペッパーグルメ Webサービス',
      sourceLink: 'https://webservice.recruit.co.jp/',
    },
    restoreMode: 'full',
    policyStatus: 'available',
    displayPolicyStatus: 'available',
  };
};

export const hotPepperRuntimePolicy = (clock: () => string): RuntimeProductionOverrides => ({
  observationPolicy: ({ now }: ProductionObservationPolicyInput) => {
    const retention = retentionAt(now);
    return {
      freshUntil: retention.freshUntil ?? retention.sessionExpiresAt,
      expiresAt: retention.sessionExpiresAt,
      retention,
    };
  },
  retention: () => retentionAt(clock()),
  modelContextFieldPolicy: hotPepperModelContextPolicy,
});
