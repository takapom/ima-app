import type { CandidateRecord, ModelContextFieldPolicy, RetentionMetadata } from '@ima/core';
import { ThreadDO as ProductionThreadDO } from '../../src/thread-do';
import { createLiveOpenAIProvider } from '../../src/model/provider';
import { sessionExpiryAt } from '../../src/runtime/runtime-production-support';
import {
  LiveTraceRecorder,
  wrapModelForLiveEvaluation,
  type LiveTraceSnapshot,
} from '../../tooling/model-eval/live';
import { fixedPlacesFetcher, MODEL_EVAL_NOW } from './model-eval-place-fixture';

export {
  fixedPlacesFetcher,
  MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  MODEL_EVAL_NOW,
} from './model-eval-place-fixture';
export { ModelEvalFixtureThreadDO } from './model-eval-context-worker';
export { SavedReferenceDO } from '../../src/saved-references/saved-reference-do';

type ModelEvalEnv = Cloudflare.Env & {
  readonly OPENAI_API_KEY?: string;
  readonly MODEL_EVAL_LIVE?: string;
};

const retentionFor = (sessionExpiresAt: string): RetentionMetadata => ({
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt,
  freshUntil: '2026-09-10T18:00:00.000Z',
  displayUntil: '2026-09-10T20:00:00.000Z',
  retentionUntil: '2026-09-10T22:00:00.000Z',
  deletionScheduledAt: '2026-09-10T22:00:00.000Z',
  attribution: { label: 'Google Places', sourceLink: 'https://maps.google.com' },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
});

const modelPolicy: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    photos: 'deny',
    contact: 'deny',
    facilities: 'deny',
    walking_route: 'deny',
    last_train: 'deny',
  },
  history: 'allow',
  cardSet: 'allow',
  displayName: 'allow',
};

export class ModelEvalThreadDO extends ProductionThreadDO {
  override maxSteps = 6;
  private readonly liveEnv: ModelEvalEnv;
  private readonly liveTrace = new LiveTraceRecorder();
  private liveModel = 'unknown';

  constructor(ctx: DurableObjectState, env: ModelEvalEnv) {
    super(ctx, env);
    this.liveEnv = env;
  }

  getModelEvalTrace(): LiveTraceSnapshot {
    return this.liveTrace.snapshot();
  }

  getModelEvalProfile(): { readonly model: string; readonly promptVersion: string } {
    return { model: this.liveModel, promptVersion: 'm25-production-default-v1' };
  }

  protected override createRuntimeProductionOverrides() {
    const base = super.createRuntimeProductionOverrides();
    const provider = createLiveOpenAIProvider(this.liveEnv);
    this.liveModel = provider.profile.model;
    const sessionExpiresAt = sessionExpiryAt(base.threadCreatedAt ?? MODEL_EVAL_NOW);
    const retention = retentionFor(sessionExpiresAt);
    const policy = () => ({
      freshUntil: retention.freshUntil ?? sessionExpiresAt,
      expiresAt: retention.retentionUntil ?? sessionExpiresAt,
      retention,
    });
    return {
      ...base,
      modelForTurn: wrapModelForLiveEvaluation(provider.model, this.liveTrace),
      candidateIdentityObserver: (
        record: Pick<CandidateRecord, 'provider' | 'recordRef' | 'candidateId'>,
      ) => this.liveTrace.observeCandidateIdentity(record),
      fetcher: fixedPlacesFetcher(this.liveTrace),
      googlePlacesApiKey: 'model-eval-fixed-provider-key',
      placesCursorSecret: 'model-eval-fixed-cursor-secret',
      observationPolicy: policy,
      detailsObservationPolicy: policy,
      modelContextFieldPolicy: modelPolicy,
      placesEnabled: true,
      retention,
      clock: () => MODEL_EVAL_NOW,
      monotonicNow: () => performance.now(),
      epochNow: () => Date.parse(MODEL_EVAL_NOW),
    };
  }
}

export default {
  fetch(): Response {
    return new Response('model-eval-live worker', { status: 404 });
  },
};
