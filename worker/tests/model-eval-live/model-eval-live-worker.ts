import type { CandidateRecord } from '@worker/domain/candidates/registry';
import { hotPepperModelContextPolicy } from '@worker/composition/runtime-hot-pepper-policy';
import type { RuntimeTurnOutcome } from '@worker/runtime/turn-execution/runtime-submit-diagnostic';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import { ThreadDO as ProductionThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import { createLiveOpenAIProvider } from '@worker/adapters/out/providers/openai/model-provider';
import type { RuntimeModelGuardModel } from '@worker/runtime/turn-execution/runtime-model-guard';
import { sessionExpiryAt } from '@worker/composition/runtime-production-support';
import {
  isThreadRuntimeTurnInput,
  runtimeFailure,
  type ThreadRuntimeTurnInput,
  type ThreadRuntimeTurnResult,
} from '@worker/runtime/threads/admission';
import {
  LiveTraceRecorder,
  LIVE_PROMPT_VERSION,
  wrapModelForLiveEvaluation,
  type LiveTraceSnapshot,
} from '../../tooling/model-eval/live';
import {
  fixtureModel,
  type ModelEvalFixturePhase,
  type ModelEvalFixtureProfile,
  type ModelEvalFixtureStep,
} from './model-eval-context-model';
import type { ModelEvalFixtureEvidenceSnapshot } from './model-eval-context-output';
import {
  fixedPlacesFetcher,
  MODEL_EVAL_NOW,
  type ModelEvalPlacePayloadMode,
  type ModelEvalPlacesResponseMode,
} from './model-eval-place-fixture';

export {
  fixedPlacesFetcher,
  MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  MODEL_EVAL_CONTEXT_NOW,
  MODEL_EVAL_NOW,
} from './model-eval-place-fixture';
export { ModelEvalFixtureThreadDO } from './model-eval-context-worker';
export { SavedReferenceDO } from '@worker/adapters/out/persistence/saved-references/saved-reference-do';

type ModelEvalEnv = Cloudflare.Env & {
  readonly OPENAI_API_KEY?: string;
  readonly MODEL_EVAL_LIVE?: string;
};

type ModelEvalTemporalProfile = 'specific-place' | 'repair';

type ModelEvalLiveProviderConfig = {
  readonly responseMode?: ModelEvalPlacesResponseMode;
  readonly payloadMode?: ModelEvalPlacePayloadMode;
};

const retentionFor = (sessionExpiresAt: string): RetentionMetadata => ({
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt,
  freshUntil: '2026-09-10T18:00:00.000Z',
  displayUntil: '2026-09-10T20:00:00.000Z',
  retentionUntil: '2026-09-10T22:00:00.000Z',
  deletionScheduledAt: '2026-09-10T22:00:00.000Z',
  attribution: {
    label: 'Powered by ホットペッパーグルメ Webサービス',
    sourceLink: 'https://webservice.recruit.co.jp/',
  },
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
});

export class ModelEvalThreadDO extends ProductionThreadDO {
  override maxSteps = 6;
  private readonly liveEnv: ModelEvalEnv;
  private readonly liveTrace = new LiveTraceRecorder();
  private liveModel = 'unknown';
  private liveNow = MODEL_EVAL_NOW;
  private liveTemporalProfile: ModelEvalTemporalProfile | null = null;
  private livePlacesResponseMode: ModelEvalPlacesResponseMode = 'normal';
  private livePlacePayloadMode: ModelEvalPlacePayloadMode = 'normal';
  private captureRuntimeInput = false;
  private capturedRuntimeInput: ThreadRuntimeTurnInput | null = null;

  constructor(ctx: DurableObjectState, env: ModelEvalEnv) {
    super(ctx, env);
    this.liveEnv = env;
  }

  getModelEvalTrace(): LiveTraceSnapshot {
    return this.liveTrace.snapshot();
  }

  getModelEvalProfile(): { readonly model: string; readonly promptVersion: string } {
    return { model: this.liveModel, promptVersion: LIVE_PROMPT_VERSION };
  }

  configureModelEvalRequestCapture(enabled: boolean): void {
    this.captureRuntimeInput = enabled;
    this.capturedRuntimeInput = null;
  }

  getModelEvalRequestCapture(): ThreadRuntimeTurnInput | null {
    return this.capturedRuntimeInput === null ? null : structuredClone(this.capturedRuntimeInput);
  }

  configureModelEvalLiveProfile(profile: ModelEvalTemporalProfile | null): void {
    this.liveTemporalProfile = profile;
    this.liveNow = MODEL_EVAL_NOW;
  }

  configureModelEvalLiveProvider(config: ModelEvalLiveProviderConfig = {}): void {
    this.livePlacesResponseMode = config.responseMode ?? 'normal';
    this.livePlacePayloadMode = config.payloadMode ?? 'normal';
  }

  override async runRuntimeTurn(value: unknown): Promise<ThreadRuntimeTurnResult> {
    if (isThreadRuntimeTurnInput(value)) {
      this.liveNow = value.input.clientNow ?? MODEL_EVAL_NOW;
    }
    if (this.captureRuntimeInput) {
      if (isThreadRuntimeTurnInput(value)) {
        this.capturedRuntimeInput = structuredClone(value);
      }
      return runtimeFailure('RUNTIME_UNCONFIGURED');
    }
    return super.runRuntimeTurn(value);
  }

  protected override async startRuntimeLifecycle(): Promise<void> {
    if (this.captureRuntimeInput) return;
    await super.startRuntimeLifecycle();
  }

  protected createLiveModel(): {
    readonly model: RuntimeModelGuardModel;
    readonly modelName: string;
  } {
    const provider = createLiveOpenAIProvider(this.liveEnv);
    return { model: provider.model, modelName: provider.profile.model };
  }

  protected override createRuntimeProductionOverrides() {
    const base = super.createRuntimeProductionOverrides();
    const liveModel = this.createLiveModel();
    this.liveModel = liveModel.modelName;
    const sessionExpiresAt = sessionExpiryAt(base.threadCreatedAt ?? MODEL_EVAL_NOW);
    const retention = () => {
      const baseRetention = retentionFor(sessionExpiresAt);
      if (this.liveTemporalProfile === null) return baseRetention;
      const freshUntil =
        this.liveTemporalProfile === 'repair'
          ? Date.parse(this.liveNow) < Date.parse(MODEL_EVAL_NOW)
            ? MODEL_EVAL_NOW
            : '2026-09-10T14:00:00.000Z'
          : '2026-09-10T14:00:00.000Z';
      return { ...baseRetention, freshUntil };
    };
    const policy = () => {
      const currentRetention = retention();
      return {
        freshUntil: currentRetention.freshUntil ?? sessionExpiresAt,
        expiresAt: currentRetention.retentionUntil ?? sessionExpiresAt,
        retention: currentRetention,
      };
    };
    return {
      ...base,
      modelForTurn: wrapModelForLiveEvaluation(liveModel.model, this.liveTrace),
      candidateIdentityObserver: (
        record: Pick<CandidateRecord, 'provider' | 'recordRef' | 'candidateId'>,
      ) => this.liveTrace.observeCandidateIdentity(record),
      turnObserver: {
        outcome: (outcome: RuntimeTurnOutcome) => this.liveTrace.observeTurnOutcome(outcome),
        respondRejected: () => this.liveTrace.observeRespondRejection(),
      },
      fetcher: (...args: Parameters<typeof fetch>) =>
        fixedPlacesFetcher(
          this.liveTrace,
          undefined,
          this.livePlacesResponseMode,
          'normal',
          this.livePlacePayloadMode,
        )(...args),
      hotPepperApiKey: 'model-eval-fixed-provider-key',
      placesCursorSecret: 'model-eval-fixed-cursor-secret',
      observationPolicy: policy,
      detailsObservationPolicy: policy,
      modelContextFieldPolicy: hotPepperModelContextPolicy,
      placesEnabled: true,
      retention,
      clock: () => this.liveNow,
      monotonicNow: () => performance.now(),
      epochNow: () => Date.parse(this.liveNow),
    };
  }
}

/** Uses the production host/factory with the existing fixed model for keyless timing tests. */
export class ModelEvalFixtureLiveThreadDO extends ModelEvalThreadDO {
  private fixturePhase: ModelEvalFixturePhase = 'cards';
  private fixtureProfile: Extract<
    ModelEvalFixtureProfile,
    'specific-place' | 'repair' | 'candidate-failure' | 'prompt-injection'
  > = 'specific-place';
  private readonly fixtureTrace = new LiveTraceRecorder();
  private readonly fixtureSteps: ModelEvalFixtureStep[] = [];
  private readonly fixtureDetailsRequests: string[][] = [];
  private readonly fixtureEvidenceSnapshots: ModelEvalFixtureEvidenceSnapshot[] = [];

  configureModelEvalLiveFixture(
    phase: ModelEvalFixturePhase,
    profile: Extract<
      ModelEvalFixtureProfile,
      'specific-place' | 'repair' | 'candidate-failure' | 'prompt-injection'
    >,
    providerConfig: ModelEvalLiveProviderConfig = {},
  ): void {
    this.fixturePhase = phase;
    this.fixtureProfile = profile;
    this.fixtureSteps.length = 0;
    this.fixtureDetailsRequests.length = 0;
    this.fixtureEvidenceSnapshots.length = 0;
    this.configureModelEvalLiveProfile(
      profile === 'specific-place' || profile === 'repair' ? profile : null,
    );
    this.configureModelEvalLiveProvider(providerConfig);
  }

  configureModelEvalLivePhase(phase: ModelEvalFixturePhase): void {
    this.fixturePhase = phase;
  }

  getModelEvalFixtureSteps(): readonly ModelEvalFixtureStep[] {
    return [...this.fixtureSteps];
  }

  getModelEvalFixtureDetailsRequests(): readonly (readonly string[])[] {
    return this.fixtureDetailsRequests.map((candidateIds) => [...candidateIds]);
  }

  getModelEvalFixtureEvidenceSnapshots(): readonly ModelEvalFixtureEvidenceSnapshot[] {
    return this.fixtureEvidenceSnapshots.map((snapshot) => ({
      candidateId: snapshot.candidateId,
      knownFields: [...snapshot.knownFields],
      modelBudget: snapshot.modelBudget,
      observations: snapshot.observations.map((observation) => ({ ...observation })),
    }));
  }

  protected override createLiveModel(): {
    readonly model: RuntimeModelGuardModel;
    readonly modelName: string;
  } {
    return {
      model: fixtureModel(
        () => this.fixturePhase,
        () => this.fixtureProfile,
        this.fixtureTrace,
        (step) => this.fixtureSteps.push(step),
        (candidateIds) => this.fixtureDetailsRequests.push([...candidateIds]),
        (snapshot) => this.fixtureEvidenceSnapshots.push(snapshot),
        () => undefined,
        () => undefined,
        () => undefined,
        () => 'clarify',
        () => undefined,
        () => undefined,
      ),
      modelName: 'm25-model-eval-fixture-v1',
    };
  }
}

export default {
  fetch(): Response {
    return new Response('model-eval-live worker', { status: 404 });
  },
};
