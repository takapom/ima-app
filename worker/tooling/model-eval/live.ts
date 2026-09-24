import { wrapLanguageModel } from 'ai';
import * as v from 'valibot';
import { AssistantResponseSchema, type AssistantResponse } from '@ima/contracts';
import type { RuntimeModelGuardModel } from '@worker/runtime/turn-execution/runtime-model-guard';
import type { RuntimeModelGuardStreamPart } from '@worker/runtime/turn-execution/runtime-model-guard';
import {
  MODEL_EVAL_SCHEMA_VERSION,
  type CandidateSelection,
  type EvaluationCase,
  type EvaluationRun,
  type EvidenceClaim,
  type EvidenceField,
  type ExpectedOutcome,
  type HumanReview,
  type JsonValue,
  type ObservedForbiddenBehavior,
  type RespondKind,
  type ToolCall,
} from './types';
import { aggregateEvaluationRuns } from './aggregate';
import type { CandidateIdentityMapping } from './candidate-mapping';
import type { LiveTraceRecorder } from './live-trace';
import { LIVE_MODEL_VERSION, LIVE_PROMPT_VERSION } from './live-cli';
import type {
  LiveProbeArtifact,
  LiveProbeAttempt,
  LiveProbeFailure,
  LiveProbeProfile,
  LiveTraceSnapshot,
} from './live-types';

export { LiveTraceRecorder } from './live-trace';
export type {
  LiveProbeArtifact,
  LiveProbeAttempt,
  LiveProbeFailure,
  LiveProbeProfile,
  LiveTraceSnapshot,
} from './live-types';

export {
  LIVE_MODEL_VERSION,
  LIVE_PROMPT_VERSION,
  resolveModelEvalLiveOptIn,
  runModelEvalLiveCli,
  type LiveOptIn,
} from './live-cli';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Wraps the actual provider model; Think and the SDK still own the loop and tool execution. */
export const wrapModelForLiveEvaluation = (
  model: RuntimeModelGuardModel,
  trace: LiveTraceRecorder,
): RuntimeModelGuardModel =>
  wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate, params }) => {
        trace.begin(params.prompt);
        try {
          const result = await doGenerate();
          for (const part of result.content) trace.observeGeneratePart(part);
          trace.finish(result.usage);
          return result;
        } catch (error: unknown) {
          trace.fail();
          throw error;
        }
      },
      wrapStream: async ({ doStream, params }) => {
        trace.begin(params.prompt);
        try {
          const result = await doStream();
          const reader = result.stream.getReader();
          let finished = false;
          const stream = new ReadableStream<RuntimeModelGuardStreamPart>({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  if (!finished) trace.fail();
                  reader.releaseLock();
                  controller.close();
                  return;
                }
                trace.observePart(next.value);
                if (next.value.type === 'finish') {
                  finished = true;
                  trace.finish(next.value.usage);
                }
                controller.enqueue(next.value);
              } catch (error: unknown) {
                trace.fail();
                reader.releaseLock();
                controller.error(error);
              }
            },
            cancel(reason) {
              void reader.cancel(reason).catch(() => undefined);
              reader.releaseLock();
            },
          });
          return { ...result, stream };
        } catch (error: unknown) {
          trace.fail();
          throw error;
        }
      },
    },
  });

const isJsonRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Evidence whose value states the same keys as the card; the rubric then checks freshness. */
const evidenceIdsFor = (
  evaluationCase: EvaluationCase,
  subjectId: string,
  field: EvidenceField,
  stated: { readonly [key: string]: JsonValue },
): readonly string[] =>
  evaluationCase.context.evidence.flatMap((evidence) => {
    const observed = evidence.value;
    if (evidence.subjectId !== subjectId || evidence.field !== field) return [];
    if (!isJsonRecord(observed)) return [];
    const matches = Object.entries(stated).every(
      ([key, value]) => JSON.stringify(observed[key]) === JSON.stringify(value),
    );
    return matches ? [evidence.id] : [];
  });

const knownFact = (
  value: unknown,
): value is { readonly status: 'known'; readonly value: Record<string, unknown> } =>
  record(value) && value.status === 'known' && record(value.value);

/** Card facts the dataset can check: the listed name, price band and opening text. */
const statedFacts = (
  facts: Record<string, unknown>,
): readonly { readonly field: EvidenceField; readonly stated: Record<string, JsonValue> }[] => {
  const stated: { field: EvidenceField; stated: Record<string, JsonValue> }[] = [];
  const identity = facts.identity;
  if (knownFact(identity) && typeof identity.value.name === 'string') {
    stated.push({ field: 'identity', stated: { name: identity.value.name } });
  }
  const price = facts.price;
  if (knownFact(price) && typeof price.value.rawLabel === 'string') {
    stated.push({ field: 'price', stated: { rawLabel: price.value.rawLabel } });
  }
  const opening = facts.opening_hours;
  if (
    knownFact(opening) &&
    Array.isArray(opening.value.weeklyText) &&
    opening.value.weeklyText.every((line) => typeof line === 'string')
  ) {
    stated.push({
      field: 'opening_hours',
      stated: { weeklyText: opening.value.weeklyText },
    });
  }
  return stated;
};

const claimsForCard = (
  evaluationCase: EvaluationCase,
  card: Record<string, unknown>,
  candidateId: string,
): EvidenceClaim[] => {
  const facts = card.facts;
  if (!record(facts)) return [];
  return statedFacts(facts).map(({ field, stated }) => ({
    id: `${candidateId}:${field}`,
    subjectId: candidateId,
    field,
    assertedValue: stated,
    evidenceIds: evidenceIdsFor(evaluationCase, candidateId, field, stated),
    text: JSON.stringify(stated),
  }));
};

/** The committed kind decides the outcome; the DTO shape is the fallback when it was not seen. */
const outcomeKindFor = (kind: RespondKind | null, response: AssistantResponse): ExpectedOutcome => {
  if (kind === 'ask') return 'clarification';
  if (kind === 'answer') return 'message';
  if (kind === 'propose') return 'cards';
  return response.kind === 'cards' ? 'cards' : 'message';
};

const textFromResponse = (response: AssistantResponse): string =>
  response.message.map((item) => item.text).join('\n');

export type LiveConversion =
  | { readonly ok: true; readonly run: EvaluationRun; readonly response: AssistantResponse }
  | {
      readonly ok: false;
      readonly code: 'PUBLIC_RESPONSE_INVALID' | 'CANDIDATE_ID_MAPPING_UNAVAILABLE';
      readonly response?: AssistantResponse;
    };

export const buildEvaluationRunFromResponse = (
  evaluationCase: EvaluationCase,
  response: unknown,
  trace: LiveTraceSnapshot,
  humanReview?: HumanReview,
  versions: { readonly modelVersion?: string; readonly promptVersion?: string } = {},
  candidateIdentityMap?: CandidateIdentityMapping,
): LiveConversion => {
  const parsed = v.safeParse(AssistantResponseSchema, response);
  if (!parsed.success) return { ok: false, code: 'PUBLIC_RESPONSE_INVALID' };
  const output = parsed.output;
  if (
    output.kind === 'cards' &&
    (!trace.candidateIdentityMapAvailable || candidateIdentityMap === undefined)
  ) {
    return { ok: false, code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE', response: output };
  }
  const claims: EvidenceClaim[] = [];
  const selections: CandidateSelection[] = [];
  const toolCalls: ToolCall[] = trace.toolNames.flatMap((name) =>
    name === 'search_places' || name === 'get_place_details' || name === 'respond'
      ? [{ name, candidateIds: [] }]
      : [],
  );
  if (output.kind === 'cards') {
    for (const card of [output.cards.hero, ...output.cards.alts]) {
      const candidateId = candidateIdentityMap?.byRuntimeCandidateId.get(card.candidateId);
      if (candidateId === undefined) {
        return { ok: false, code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE', response: output };
      }
      const cardClaims = claimsForCard(evaluationCase, card, candidateId);
      claims.push(...cardClaims);
      selections.push({
        candidateId,
        evidenceIds: cardClaims.flatMap((claim) => claim.evidenceIds),
        why: card.why.text,
      });
    }
  }
  const respondKind = trace.respondKinds.at(-1) ?? null;
  // Message text cites nothing, so which candidates it discusses is left to human review.
  const forbiddenBehaviors: ObservedForbiddenBehavior[] = trace.modelLocationExposed
    ? [
        {
          kind: 'gps-disclosure' as const,
          detail: 'host trace observed a restricted location field',
        },
      ]
    : [];
  if (
    evaluationCase.expected.mustNotSearch &&
    toolCalls.some((call) => call.name === 'search_places')
  ) {
    forbiddenBehaviors.push({ kind: 'unnecessary-search', detail: 'search tool was called' });
  }
  return {
    ok: true,
    response: output,
    run: {
      schemaVersion: MODEL_EVAL_SCHEMA_VERSION,
      scenarioId: evaluationCase.id,
      repeat: evaluationCase.repeat,
      modelVersion: versions.modelVersion ?? LIVE_MODEL_VERSION,
      promptVersion: versions.promptVersion ?? LIVE_PROMPT_VERSION,
      response: {
        outcome: {
          kind: outcomeKindFor(respondKind, output),
          text: textFromResponse(output),
        },
        claims,
        selections,
      },
      trace: {
        complete: trace.complete,
        toolCalls,
        forbiddenBehaviors,
        modelLocationExposed: trace.modelLocationExposed,
        selectedCandidateIds: selections.map((selection) => selection.candidateId),
        preservedConditionFields: [...new Set(trace.preservedConditionFields)],
        candidateSetChanges: [],
      },
      metrics: {
        latencyMs: trace.latencyMs,
        turnMs: trace.turnMs,
        modelCalls: trace.modelCalls,
        toolCalls: trace.executedToolCalls,
        executedTools: trace.executedTools,
        respondInvalid: trace.respondInvalid,
        respondKind,
        upstreamCalls: trace.upstreamCalls,
        inputTokens: trace.inputTokens,
        cachedInputTokens: trace.cachedInputTokens,
        outputTokens: trace.outputTokens,
        measuredCostUsd: null,
      },
      ...(humanReview === undefined ? {} : { humanReview }),
    },
  };
};

export const createLiveProbeArtifact = (input: {
  readonly profile: LiveProbeProfile;
  readonly scenarios: Parameters<typeof aggregateEvaluationRuns>[1];
  readonly attempts: readonly LiveProbeAttempt[];
  readonly runs: readonly EvaluationRun[];
  readonly failures: readonly LiveProbeFailure[];
}): LiveProbeArtifact => {
  const report = aggregateEvaluationRuns(input.runs, input.scenarios);
  return {
    schemaVersion: 'm25.live.v2',
    profile: input.profile,
    status: input.attempts.some((attempt) => attempt.status === 'runtime_failed')
      ? 'runtime_failed'
      : input.failures.length === 0 && report.gates.passed
        ? 'evaluated'
        : 'unverified',
    attempts: input.attempts,
    runs: input.runs,
    failures: input.failures,
    report,
  };
};

/** Emits one reviewable JSON record without raw prompts, provider bodies, or provider errors. */
export const writeLiveProbeArtifact = (
  artifact: LiveProbeArtifact,
  write: (line: string) => void,
): void => {
  write(JSON.stringify(artifact));
};
