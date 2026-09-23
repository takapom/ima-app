import type { CandidateRecord } from '@worker/domain/candidates/registry';
import type { ModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import { ProductionThreadDO } from '../runtime-native/runtime-production-worker';
import {
  fixedPlacesFetcher,
  MODEL_EVAL_NOW,
  type ModelEvalPlaceDisplayNameMode,
  type ModelEvalPlacePayloadMode,
  type ModelEvalPlacesResponseMode,
} from './model-eval-place-fixture';
import { LiveTraceRecorder } from '../../tooling/model-eval/live';
import { fixtureModel } from './model-eval-context-model';
import {
  type ModelEvalFixtureDisplayNamePolicy,
  type ModelEvalFixtureLocationProbe,
  type ModelEvalFixtureOptions,
  type ModelEvalFixturePhase,
  type ModelEvalFixtureProfile,
  type ModelEvalFixtureStep,
} from './model-eval-context-model';
import type { ModelEvalFixtureEvidenceSnapshot } from './model-eval-context-output';
import type { ProjectedModelLocation } from './model-eval-context-values';
import { repairOverridesFor } from './model-eval-repair';
import type { ModelEvalPromptInjectionAudit } from './model-eval-prompt-injection';

export type {
  ModelEvalFixtureDisplayNamePolicy,
  ModelEvalFixtureLocationProbe,
  ModelEvalFixtureOptions,
  ModelEvalFixturePhase,
  ModelEvalFixtureProfile,
  ModelEvalFixtureStep,
} from './model-eval-context-model';
export type { ModelEvalFixtureEvidenceSnapshot } from './model-eval-context-output';

const FIXTURE_MODEL_CONTEXT_FIELD_POLICY: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    photos: 'deny',
    contact: 'deny',
    facilities: 'deny',
  },
  history: 'allow',
  cardSet: 'allow',
  displayName: 'allow',
};

const modelContextFieldPolicyFor = (
  displayName: ModelContextFieldPolicy['displayName'],
): ModelContextFieldPolicy => ({
  ...FIXTURE_MODEL_CONTEXT_FIELD_POLICY,
  displayName,
});

export class ModelEvalFixtureThreadDO extends ProductionThreadDO {
  private fixturePhase: ModelEvalFixturePhase = 'cards';
  private fixtureProfile: ModelEvalFixtureProfile = 'reason';
  private fixtureNow = MODEL_EVAL_NOW;
  private fixtureLocationProbe: ModelEvalFixtureLocationProbe = 'clarify';
  private fixturePlacesResponseMode: ModelEvalPlacesResponseMode = 'normal';
  private fixturePlaceDisplayNameMode: ModelEvalPlaceDisplayNameMode = 'normal';
  private fixturePlacePayloadMode: ModelEvalPlacePayloadMode = 'normal';
  private fixtureDisplayNamePolicy: ModelEvalFixtureDisplayNamePolicy = 'visible';
  private fixtureThreadCreatedAt: string | undefined;
  private readonly fixtureToolErrorCodes: string[] = [];
  private fixtureModelLocationExposed = false;
  private fixturePrivateUpstreamBodyExposed = false;
  private readonly fixtureTrace = new LiveTraceRecorder();
  private readonly fixtureModelLocations: ProjectedModelLocation[] = [];
  private readonly fixtureSteps: ModelEvalFixtureStep[] = [];
  private readonly fixtureDetailsRequests: string[][] = [];
  private readonly fixtureSearchQueries: string[] = [];
  private readonly fixtureEvidenceSnapshots: ModelEvalFixtureEvidenceSnapshot[] = [];
  private readonly fixturePromptInjectionAudits: ModelEvalPromptInjectionAudit[] = [];

  configureModelEvalFixture(
    phase: ModelEvalFixturePhase,
    now = MODEL_EVAL_NOW,
    profile: ModelEvalFixtureProfile = 'reason',
    locationProbe: ModelEvalFixtureLocationProbe = 'clarify',
    placesResponseMode: ModelEvalPlacesResponseMode = 'normal',
    options: ModelEvalFixtureOptions = {},
  ): void {
    this.fixturePhase = phase;
    this.fixtureNow = now;
    this.fixtureProfile = profile;
    this.fixtureLocationProbe = locationProbe;
    this.fixturePlacesResponseMode = placesResponseMode;
    this.fixturePlaceDisplayNameMode = options.placeDisplayNameMode ?? 'normal';
    this.fixturePlacePayloadMode = options.placePayloadMode ?? 'normal';
    this.fixtureDisplayNamePolicy = options.displayNamePolicy ?? 'visible';
    this.fixtureThreadCreatedAt = options.threadCreatedAt;
    this.fixtureToolErrorCodes.length = 0;
    this.fixtureModelLocationExposed = false;
    this.fixturePrivateUpstreamBodyExposed = false;
    this.fixtureSearchQueries.length = 0;
    this.fixturePromptInjectionAudits.length = 0;
  }

  protected override runtimeProductionNow(): string {
    return this.fixtureNow;
  }

  getModelEvalFixtureTrace() {
    return this.fixtureTrace.snapshot();
  }

  getModelEvalFixtureSteps(): readonly ModelEvalFixtureStep[] {
    return [...this.fixtureSteps];
  }

  getModelEvalFixtureCandidateIdentities() {
    return this.fixtureTrace.snapshot().candidateIdentities;
  }

  getModelEvalFixtureRecorderTrace() {
    return this.fixtureTrace.snapshot();
  }

  getModelEvalFixtureDetailsRequests(): readonly (readonly string[])[] {
    return this.fixtureDetailsRequests.map((candidateIds) => [...candidateIds]);
  }

  getModelEvalFixtureSearchQueries(): readonly string[] {
    return [...this.fixtureSearchQueries];
  }

  getModelEvalFixtureModelLocations(): readonly ProjectedModelLocation[] {
    return this.fixtureModelLocations.map((location) => ({ ...location }));
  }

  getModelEvalFixtureToolErrorCodes(): readonly string[] {
    return [...this.fixtureToolErrorCodes];
  }

  getModelEvalFixtureModelLocationExposed(): boolean {
    return this.fixtureModelLocationExposed;
  }

  getModelEvalFixturePrivateUpstreamBodyExposed(): boolean {
    return this.fixturePrivateUpstreamBodyExposed;
  }

  getModelEvalFixturePromptInjectionAudits(): readonly ModelEvalPromptInjectionAudit[] {
    return this.fixturePromptInjectionAudits.map((audit) => ({ ...audit }));
  }

  getModelEvalFixtureEvidenceSnapshots(): readonly ModelEvalFixtureEvidenceSnapshot[] {
    return this.fixtureEvidenceSnapshots.map((snapshot) => ({
      candidateId: snapshot.candidateId,
      evidenceIds: [...snapshot.evidenceIds],
      modelBudget: snapshot.modelBudget,
      observations: snapshot.observations.map((observation) => ({ ...observation })),
    }));
  }

  protected override createRuntimeProductionOverrides(): ReturnType<
    ProductionThreadDO['createRuntimeProductionOverrides']
  > {
    const base = super.createRuntimeProductionOverrides();
    return {
      ...base,
      ...(this.fixtureThreadCreatedAt === undefined
        ? {}
        : { threadCreatedAt: this.fixtureThreadCreatedAt }),
      modelForTurn: fixtureModel(
        () => this.fixturePhase,
        () => this.fixtureProfile,
        this.fixtureTrace,
        (step) => this.fixtureSteps.push(step),
        (candidateIds) => this.fixtureDetailsRequests.push([...candidateIds]),
        (snapshot) => this.fixtureEvidenceSnapshots.push(snapshot),
        () => {
          this.fixtureModelLocationExposed = true;
        },
        (location) => this.fixtureModelLocations.push({ ...location }),
        (codes) => {
          this.fixtureToolErrorCodes.push(...codes);
        },
        () => this.fixtureLocationProbe,
        () => {
          this.fixturePrivateUpstreamBodyExposed = true;
        },
        (audit) => this.fixturePromptInjectionAudits.push(audit),
      ),
      modelContextFieldPolicy: modelContextFieldPolicyFor(
        this.fixtureDisplayNamePolicy === 'withheld' ? 'deny' : 'allow',
      ),
      candidateIdentityObserver: (
        record: Pick<CandidateRecord, 'provider' | 'recordRef' | 'candidateId'>,
      ) => this.fixtureTrace.observeCandidateIdentity(record),
      fetcher: (input: RequestInfo | URL, init?: RequestInit) =>
        fixedPlacesFetcher(
          this.fixtureTrace,
          this.fixtureNow,
          (query) => this.fixtureSearchQueries.push(query),
          this.fixturePlacesResponseMode,
          this.fixturePlaceDisplayNameMode,
          this.fixturePlacePayloadMode,
        )(input, init),
      ...repairOverridesFor(this.fixtureProfile, () => this.fixturePhase),
      hotPepperApiKey: 'model-eval-fixed-provider-key',
      placesCursorSecret: 'model-eval-fixed-cursor-secret',
      placesEnabled: true,
      clock: () => this.fixtureNow,
      epochNow: () => Date.parse(this.fixtureNow),
    };
  }
}

export default {
  fetch(): Response {
    return new Response('model-eval-context worker', { status: 404 });
  },
};
