import * as v from 'valibot';
import { AssistantResponseSchema, type AssistantResponse } from '@ima/contracts';
import {
  buildEvaluationRunFromResponse,
  createLiveProbeArtifact,
  type LiveProbeAttempt,
  type LiveProbeFailure,
  type LiveProbeProfile,
  type LiveTraceSnapshot,
} from './live';
import {
  resolveCandidateIdentityMapping,
  type CandidateIdentityMapping,
  type EvaluationCandidateIdentity,
} from './candidate-mapping';
import {
  advanceEvaluationTurn,
  createEvaluationTurnSeed,
  type EvaluationTurnSeed,
  type EvaluationTurnTarget,
} from './turn-plan';
import { cardContextFromResponse, type EvaluationCardContext } from './scenario-input';
import { createLiveEvaluationTurnPlan, type LiveEvaluationTurnPlan } from './live-plan';
import { expandEvaluationDataset } from './dataset';
import type { EvaluationCase, EvaluationRun, EvaluationScenario } from './types';

export type LiveCoordinatorProfile = {
  readonly model: string;
  readonly promptVersion: string;
};

export type LiveTurnExecution = {
  readonly status: string;
  readonly code?: string | null;
  readonly response: unknown;
};

export type LiveCoordinatorPorts = {
  readonly initialize: () => Promise<{ readonly ok: boolean }>;
  readonly runTurn: (
    seed: EvaluationTurnSeed,
    cardContext?: EvaluationCardContext,
  ) => Promise<LiveTurnExecution>;
  readonly readTrace: () => Promise<LiveTraceSnapshot | null>;
  readonly readProfile: () => Promise<LiveCoordinatorProfile | null>;
};

export type LiveCoordinatorCasePorts = {
  readonly target: EvaluationTurnTarget;
  readonly ports: LiveCoordinatorPorts;
};

export type LiveCaseExecution = {
  readonly attempt: LiveProbeAttempt;
  readonly failure?: LiveProbeFailure;
  readonly run?: EvaluationRun;
};

export type PreludeValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' | 'PRELUDE_CARD_SET_UNAVAILABLE';
    };

export type LiveTraceDeltaResult =
  | { readonly ok: true; readonly trace: LiveTraceSnapshot }
  | {
      readonly ok: false;
      readonly code: 'TRACE_DELTA_INVALID' | 'TRACE_DELTA_UNAVAILABLE';
    };

const safeFailureCodes = new Set([
  'CANDIDATE_ID_MAPPING_UNAVAILABLE',
  'INITIALIZE_FAILED',
  'MODEL_STREAM_ABORTED',
  'MODEL_STREAM_TIMEOUT',
  'MULTI_TURN_RESPONSE_INVALID',
  'MULTI_TURN_SEED_UNAVAILABLE',
  'PRELUDE_CARD_SET_UNAVAILABLE',
  'PUBLIC_RESPONSE_INVALID',
  'RUNTIME_FAILED',
  'RUNTIME_EXCEPTION',
  'TRACE_DELTA_INVALID',
  'TRACE_DELTA_UNAVAILABLE',
  'TRACE_UNAVAILABLE',
  'UNSUPPORTED_CARD_PRELUDE',
]);

const safeFailureCode = (value: unknown): string =>
  typeof value === 'string' && safeFailureCodes.has(value) ? value : 'RUNTIME_FAILED';

const versionsFor = (profile: LiveCoordinatorProfile | null) => ({
  modelVersion: profile === null ? 'openai:unknown' : `openai:${profile.model}`,
  promptVersion: profile?.promptVersion ?? 'm25-production-default-v1',
});

const responseFrom = (result: LiveTurnExecution): AssistantResponse => {
  if (result.status !== 'completed' || result.response === null) {
    throw new Error(safeFailureCode(result.code ?? 'RUNTIME_FAILED'));
  }
  const parsed = v.safeParse(AssistantResponseSchema, result.response);
  if (!parsed.success) throw new Error('PUBLIC_RESPONSE_INVALID');
  return parsed.output;
};

const deltaNumber = (
  after: number,
  before: number,
): { readonly ok: true; readonly value: number } | { readonly ok: false } => {
  if (!Number.isFinite(after) || !Number.isFinite(before) || after < before) {
    return { ok: false };
  }
  return { ok: true, value: after - before };
};

const deltaNullableNumber = (
  after: number | null,
  before: number | null,
  beforeCalls: number,
): { readonly ok: true; readonly value: number | null } | { readonly ok: false } => {
  if (after === null) return { ok: true, value: null };
  if (before === null) {
    return beforeCalls === 0 ? { ok: true, value: after } : { ok: true, value: null };
  }
  return deltaNumber(after, before);
};

const suffixFor = (
  after: readonly string[],
  before: readonly string[],
): readonly string[] | null => {
  if (!before.every((value, index) => after[index] === value)) return null;
  return after.slice(before.length);
};

/**
 * Computes target-turn metrics from cumulative host state. Identity observations
 * stay cumulative because a target card may refer to a prelude candidate.
 */
export const liveTraceDelta = (
  after: LiveTraceSnapshot,
  before: LiveTraceSnapshot,
): LiveTraceDeltaResult => {
  const modelCalls = deltaNumber(after.modelCalls, before.modelCalls);
  const proposedToolCalls = deltaNumber(after.proposedToolCalls, before.proposedToolCalls);
  const upstreamCalls = deltaNumber(after.upstreamCalls, before.upstreamCalls);
  const latencyMs = deltaNullableNumber(after.latencyMs, before.latencyMs, before.modelCalls);
  const inputTokens = deltaNullableNumber(after.inputTokens, before.inputTokens, before.modelCalls);
  const outputTokens = deltaNullableNumber(
    after.outputTokens,
    before.outputTokens,
    before.modelCalls,
  );
  const executedToolCalls = deltaNullableNumber(
    after.executedToolCalls,
    before.executedToolCalls,
    before.modelCalls,
  );
  const toolNames = suffixFor(after.toolNames, before.toolNames);
  if (
    !modelCalls.ok ||
    !proposedToolCalls.ok ||
    !upstreamCalls.ok ||
    !latencyMs.ok ||
    !inputTokens.ok ||
    !outputTokens.ok ||
    !executedToolCalls.ok ||
    toolNames === null
  ) {
    return { ok: false, code: 'TRACE_DELTA_INVALID' };
  }
  if (before.modelLocationExposed && after.modelLocationExposed) {
    return { ok: false, code: 'TRACE_DELTA_UNAVAILABLE' };
  }
  if (before.modelLocationExposed && !after.modelLocationExposed) {
    return { ok: false, code: 'TRACE_DELTA_INVALID' };
  }
  const preservedConditionFields = suffixFor(
    after.preservedConditionFields,
    before.preservedConditionFields,
  );
  if (preservedConditionFields === null) return { ok: false, code: 'TRACE_DELTA_INVALID' };
  return {
    ok: true,
    trace: {
      ...after,
      complete: after.complete && modelCalls.value > 0,
      modelCalls: modelCalls.value,
      proposedToolCalls: proposedToolCalls.value,
      toolNames,
      upstreamCalls: upstreamCalls.value,
      latencyMs: latencyMs.value,
      inputTokens: inputTokens.value,
      outputTokens: outputTokens.value,
      executedToolCalls: executedToolCalls.value,
      modelLocationExposed: after.modelLocationExposed,
      preservedConditionFields,
    },
  };
};

/** Checks prelude card order after exact provider-record to evaluation-ID mapping. */
export const validateLivePreludeContext = (input: {
  readonly profile: LiveProbeProfile;
  readonly evaluationCase: EvaluationCase;
  readonly cardContext: EvaluationCardContext;
  readonly mapping: CandidateIdentityMapping | undefined;
}): PreludeValidationResult => {
  if (input.mapping === undefined) {
    return { ok: false, code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' };
  }
  const { cardContext, evaluationCase, mapping, profile } = input;
  const minimumCandidates = profile === 'continuity' ? 2 : 1;
  if (cardContext.candidateOrder.length < minimumCandidates) {
    return { ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' };
  }
  const mapped = (runtimeCandidateId: string | undefined): string | undefined =>
    runtimeCandidateId === undefined
      ? undefined
      : mapping.byRuntimeCandidateId.get(runtimeCandidateId);
  if (
    evaluationCase.expected.requiredCandidateIds.some(
      (candidateId) =>
        !cardContext.candidateOrder.some((runtimeId) => mapped(runtimeId) === candidateId),
    )
  ) {
    return { ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' };
  }
  if (
    profile === 'continuity' &&
    mapped(cardContext.candidateOrder[1]) !== evaluationCase.expected.requiredCandidateIds[0]
  ) {
    return { ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' };
  }
  return { ok: true };
};

const executionFailure = (input: {
  readonly evaluationCase: EvaluationCase;
  readonly code: string;
  readonly trace: LiveTraceSnapshot | null;
  readonly response?: AssistantResponse;
  readonly profile: LiveCoordinatorProfile | null;
}): LiveCaseExecution => {
  const code = safeFailureCode(input.code);
  const status =
    code === 'CANDIDATE_ID_MAPPING_UNAVAILABLE' ? 'unverified_mapping' : 'runtime_failed';
  const versions = versionsFor(input.profile);
  const attempt: LiveProbeAttempt = {
    caseId: input.evaluationCase.caseId,
    status,
    code,
    ...versions,
    trace: input.trace,
    publicResponse: input.response ?? null,
  };
  return {
    attempt,
    failure: { caseId: input.evaluationCase.caseId, code, status },
  };
};

const evaluationSuccess = (input: {
  readonly evaluationCase: EvaluationCase;
  readonly run: EvaluationRun;
  readonly response: AssistantResponse;
  readonly trace: LiveTraceSnapshot;
  readonly profile: LiveCoordinatorProfile | null;
}): LiveCaseExecution => ({
  attempt: {
    caseId: input.evaluationCase.caseId,
    status: 'evaluated',
    code: null,
    ...versionsFor(input.profile),
    trace: input.trace,
    publicResponse: input.response,
  },
  run: input.run,
});

const readFailureTrace = async (
  ports: LiveCoordinatorPorts,
  base: LiveTraceSnapshot | null,
  targetStarted: boolean,
): Promise<LiveTraceSnapshot | null> => {
  if (!targetStarted || base === null) return null;
  try {
    const current = await ports.readTrace();
    if (current === null) return null;
    const delta = liveTraceDelta(current, base);
    return delta.ok ? delta.trace : null;
  } catch {
    return null;
  }
};

export const executeLiveEvaluationCase = async (input: {
  readonly evaluationCase: EvaluationCase;
  readonly plan: LiveEvaluationTurnPlan;
  readonly target: EvaluationTurnTarget;
  readonly ports: LiveCoordinatorPorts;
  readonly expectedIdentities: readonly EvaluationCandidateIdentity[];
}): Promise<LiveCaseExecution> => {
  let baseTrace: LiveTraceSnapshot | null = null;
  let preludeTrace: LiveTraceSnapshot | null = null;
  let targetStarted = false;
  try {
    const initialized = await input.ports.initialize();
    if (!initialized.ok) throw new Error('INITIALIZE_FAILED');
    baseTrace = await input.ports.readTrace();
    if (baseTrace === null) throw new Error('TRACE_UNAVAILABLE');

    let targetSeed: EvaluationTurnSeed;
    let cardContext: EvaluationCardContext | undefined;
    if (input.plan.prelude === null) {
      const seed = createEvaluationTurnSeed({
        caseId: input.evaluationCase.caseId,
        userTurns: input.plan.targetTexts,
        target: input.target,
      });
      if (!seed.ok) throw new Error(seed.code);
      targetSeed = seed.seed;
    } else {
      const preludeSeed = createEvaluationTurnSeed({
        caseId: input.evaluationCase.caseId,
        userTurns: [input.plan.prelude.text],
        target: input.target,
      });
      if (!preludeSeed.ok) throw new Error(preludeSeed.code);
      const preludeResponse = responseFrom(await input.ports.runTurn(preludeSeed.seed));
      preludeTrace = await input.ports.readTrace();
      if (preludeTrace === null) throw new Error('TRACE_UNAVAILABLE');
      const contextResult = cardContextFromResponse(preludeResponse);
      if (!contextResult.ok) throw new Error('UNSUPPORTED_CARD_PRELUDE');
      const mapping = resolveCandidateIdentityMapping(
        preludeTrace.candidateIdentities,
        input.expectedIdentities,
      );
      const contextValidation = validateLivePreludeContext({
        profile: input.plan.profile,
        evaluationCase: input.evaluationCase,
        cardContext: contextResult.context,
        mapping: mapping.ok ? mapping : undefined,
      });
      if (!contextValidation.ok) throw new Error(contextValidation.code);
      cardContext = contextResult.context;
      const targetText = input.plan.targetTexts[0];
      const next = advanceEvaluationTurn(preludeSeed.seed, preludeResponse, targetText);
      if (!next.ok) throw new Error(next.code);
      targetSeed = next.seed;
    }

    targetStarted = true;
    const targetResult = await input.ports.runTurn(targetSeed, cardContext);
    const targetResponse = responseFrom(targetResult);
    const fullTrace = await input.ports.readTrace();
    if (fullTrace === null) throw new Error('TRACE_UNAVAILABLE');
    const targetTraceResult = liveTraceDelta(fullTrace, preludeTrace ?? baseTrace);
    if (!targetTraceResult.ok) throw new Error(targetTraceResult.code);
    const profile = await input.ports.readProfile();
    const mapping = resolveCandidateIdentityMapping(
      fullTrace.candidateIdentities,
      input.expectedIdentities,
    );
    let converted = buildEvaluationRunFromResponse(
      input.evaluationCase,
      targetResponse,
      targetTraceResult.trace,
      undefined,
      versionsFor(profile),
      mapping.ok ? mapping : undefined,
    );
    if (
      converted.ok &&
      input.evaluationCase.expected.requiredCandidateIds.length > 0 &&
      targetResponse.kind === 'message'
    ) {
      converted = {
        ok: false,
        code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE',
        response: targetResponse,
      };
    }
    if (!converted.ok) {
      return executionFailure({
        evaluationCase: input.evaluationCase,
        code: converted.code,
        trace: targetTraceResult.trace,
        profile,
        ...(converted.response === undefined ? {} : { response: converted.response }),
      });
    }
    return evaluationSuccess({
      evaluationCase: input.evaluationCase,
      run: converted.run,
      response: converted.response,
      trace: targetTraceResult.trace,
      profile,
    });
  } catch (error: unknown) {
    const code = error instanceof Error ? safeFailureCode(error.message) : 'RUNTIME_EXCEPTION';
    const profile = await input.ports.readProfile().catch(() => null);
    return executionFailure({
      evaluationCase: input.evaluationCase,
      code,
      trace: await readFailureTrace(input.ports, preludeTrace ?? baseTrace, targetStarted),
      profile,
    });
  }
};

/** Runs every selected profile and keeps later artifacts after an earlier failure. */
export const runLiveEvaluationProfiles = async (input: {
  readonly scenarios: readonly EvaluationScenario[];
  readonly expectedIdentities: readonly EvaluationCandidateIdentity[];
  readonly portsForCase: (evaluationCase: EvaluationCase) => LiveCoordinatorCasePorts;
}): Promise<readonly ReturnType<typeof createLiveProbeArtifact>[]> => {
  const artifacts: ReturnType<typeof createLiveProbeArtifact>[] = [];
  for (const scenario of input.scenarios) {
    const cases = expandEvaluationDataset([scenario]);
    const runs: EvaluationRun[] = [];
    const attempts: LiveProbeAttempt[] = [];
    const failures: LiveProbeFailure[] = [];
    for (const evaluationCase of cases) {
      const planResult = createLiveEvaluationTurnPlan(evaluationCase);
      if (!planResult.ok) {
        const result = executionFailure({
          evaluationCase,
          code: planResult.code,
          trace: null,
          profile: null,
        });
        attempts.push(result.attempt);
        if (result.failure !== undefined) failures.push(result.failure);
        continue;
      }
      let result: LiveCaseExecution;
      try {
        const ports = input.portsForCase(evaluationCase);
        result = await executeLiveEvaluationCase({
          evaluationCase,
          plan: planResult.plan,
          target: ports.target,
          ports: ports.ports,
          expectedIdentities: input.expectedIdentities,
        });
      } catch (error: unknown) {
        result = executionFailure({
          evaluationCase,
          code: error instanceof Error ? safeFailureCode(error.message) : 'RUNTIME_EXCEPTION',
          trace: null,
          profile: null,
        });
      }
      attempts.push(result.attempt);
      if (result.failure !== undefined) failures.push(result.failure);
      if (result.run !== undefined) runs.push(result.run);
    }
    const profilePlan = createLiveEvaluationTurnPlan({
      ...scenario,
      caseId: 'profile',
      repeat: 1,
    });
    if (!profilePlan.ok) continue;
    artifacts.push(
      createLiveProbeArtifact({
        profile: profilePlan.plan.profile,
        scenarios: [scenario],
        attempts,
        runs,
        failures,
      }),
    );
  }
  return artifacts;
};
