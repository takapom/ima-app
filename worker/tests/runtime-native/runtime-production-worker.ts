import type { ModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import { DEFAULT_RUNTIME_BUDGET } from '@worker/runtime/budget/runtime-budget';
import { ThreadDO as ProductionThreadDOBase } from '@worker/entrypoints/cloudflare/thread-do';
import {
  modelForProduction,
  runtimeTurnUsesLlmOnlyPolicy,
  runtimeTurnUsesMultiTurnPolicy,
  type MutableRuntimeProductionReport,
  type RuntimeProductionCandidateIdentity,
  type RuntimeProductionReport,
} from './runtime-production-model';
export type {
  RuntimeProductionCandidateIdentity,
  RuntimeProductionReport,
} from './runtime-production-model';
import {
  fetcherForProduction,
  productionScenarioFor,
  type ProductionScenario,
} from './runtime-production-provider-fixture';

export const RUNTIME_PRODUCTION_NOW = '2026-09-10T12:00:00.000Z';

const ALLOW_RETENTION = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-10T23:00:00.000Z',
  freshUntil: '2026-09-10T18:00:00.000Z',
  displayUntil: '2026-09-10T20:00:00.000Z',
  retentionUntil: '2026-09-10T22:00:00.000Z',
  deletionScheduledAt: '2026-09-10T22:00:00.000Z',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
} satisfies RetentionMetadata;

const LLM_ONLY_RETENTION = {
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-10T23:00:00.000Z',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
} satisfies RetentionMetadata;

// This is an evaluated fixture snapshot for llm_input only. Production omits it
// until a host policy evaluator supplies an explicit, use-scoped decision.
const FIXTURE_MODEL_CONTEXT_FIELD_POLICY: ModelContextFieldPolicy = {
  evidence: {
    identity: 'allow',
    opening_hours: 'allow',
    price: 'allow',
    photos: 'allow',
    contact: 'allow',
    facilities: 'allow',
  },
  history: 'deny',
  cardSet: 'deny',
  displayName: 'deny',
};

const LLM_ONLY_MODEL_CONTEXT_FIELD_POLICY: ModelContextFieldPolicy = {
  ...FIXTURE_MODEL_CONTEXT_FIELD_POLICY,
  evidence: { ...FIXTURE_MODEL_CONTEXT_FIELD_POLICY.evidence, opening_hours: 'deny' },
};

const MULTITURN_MODEL_CONTEXT_FIELD_POLICY: ModelContextFieldPolicy = {
  ...FIXTURE_MODEL_CONTEXT_FIELD_POLICY,
  history: 'allow',
  cardSet: 'allow',
  displayName: 'allow',
};

export class ProductionThreadDO extends ProductionThreadDOBase {
  override maxSteps = 6;
  private productionNow = RUNTIME_PRODUCTION_NOW;
  private productionReport: MutableRuntimeProductionReport | null = null;
  private llmOnlyModel = false;
  private multiTurnModel = false;
  private productionScenario: ProductionScenario = 'default';
  private productionCandidateIdentities: RuntimeProductionCandidateIdentity[] = [];

  protected override runtimeProductionNow(): string {
    return this.productionNow;
  }

  setRuntimeProductionNow(value: string): void {
    this.productionNow = value;
  }

  configureRuntimeScenario(scenario: 'llm-only' | 'multi-turn'): void {
    this.llmOnlyModel = scenario === 'llm-only';
    this.multiTurnModel = scenario === 'multi-turn';
  }

  override async runRuntimeTurn(value: unknown) {
    this.llmOnlyModel = runtimeTurnUsesLlmOnlyPolicy(value);
    this.multiTurnModel = runtimeTurnUsesMultiTurnPolicy(value);
    this.productionScenario = productionScenarioFor(value);
    this.productionCandidateIdentities = [];
    return super.runRuntimeTurn(value);
  }

  getRuntimeProductionReport(): RuntimeProductionReport | null {
    return this.productionReport === null ? null : structuredClone(this.productionReport);
  }

  getRuntimeProductionCandidateIdentities(): readonly RuntimeProductionCandidateIdentity[] {
    return structuredClone(this.productionCandidateIdentities);
  }

  getRuntimeAnchorStatus():
    { readonly status: 'valid' } | { readonly status: 'invalid'; readonly code: string } {
    try {
      this.ensureRuntimeThinkConnection();
      return { status: 'valid' };
    } catch (error: unknown) {
      return {
        status: 'invalid',
        code: error instanceof Error ? error.message : 'UNKNOWN_RUNTIME_ANCHOR_ERROR',
      };
    }
  }

  protected override createRuntimeProductionOverrides() {
    const base = super.createRuntimeProductionOverrides();
    const report: MutableRuntimeProductionReport = {
      calls: 0,
      providerOptionsSeen: [],
      toolNames: [],
      observationIdsSeen: [],
      modelCandidateCounts: [],
      finalResponseFlags: [],
      toolChoices: [],
      offeredTools: [],
      fetchUrls: [],
      searchResultCounts: [],
      llmInputCanarySeen: false,
      deniedFieldCanarySeen: false,
      modelHistorySeen: false,
      modelHistoryTextSeen: false,
      modelCardSetSeen: false,
      modelCardSetSnapshots: [],
    };
    this.productionReport = report;
    const retention = this.llmOnlyModel ? LLM_ONLY_RETENTION : ALLOW_RETENTION;
    const policy = () => ({
      freshUntil: retention.freshUntil ?? retention.sessionExpiresAt,
      expiresAt: retention.retentionUntil ?? retention.sessionExpiresAt,
      retention,
    });
    const budgetStart = performance.now();
    let monotonicCalls = 0;
    return {
      ...base,
      modelForTurn: modelForProduction(report, this.llmOnlyModel, () => this.productionScenario),
      fetcher: fetcherForProduction(report, () => this.productionScenario),
      candidateIdentityObserver: (record: RuntimeProductionCandidateIdentity) => {
        this.productionCandidateIdentities.push({
          provider: record.provider,
          recordRef: record.recordRef,
          candidateId: record.candidateId,
        });
      },
      observationPolicy: policy,
      detailsObservationPolicy: policy,
      modelContextFieldPolicy: this.llmOnlyModel
        ? LLM_ONLY_MODEL_CONTEXT_FIELD_POLICY
        : this.multiTurnModel
          ? MULTITURN_MODEL_CONTEXT_FIELD_POLICY
          : FIXTURE_MODEL_CONTEXT_FIELD_POLICY,
      placesEnabled: true,
      retention,
      clock: () => RUNTIME_PRODUCTION_NOW,
      monotonicNow: () => {
        if (monotonicCalls++ === 0) return budgetStart;
        if (
          this.productionScenario === 'final-reserve' ||
          this.productionScenario === 'late-tool'
        ) {
          return (
            budgetStart +
            DEFAULT_RUNTIME_BUDGET.wholeTurnMs -
            DEFAULT_RUNTIME_BUDGET.finalReserveMs +
            500
          );
        }
        if (this.productionScenario === 'exhausted-budget') {
          return budgetStart + DEFAULT_RUNTIME_BUDGET.wholeTurnMs + 100;
        }
        return performance.now();
      },
      epochNow: () => 1_000,
    };
  }
}
