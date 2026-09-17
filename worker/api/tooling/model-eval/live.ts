import { wrapLanguageModel } from 'ai';
import * as v from 'valibot';
import { AssistantResponseSchema, type AssistantResponse } from '@ima/contracts';
import type { RuntimeModelGuardModel } from '../../src/runtime/turn-execution/runtime-model-guard';
import type { RuntimeModelGuardStreamPart } from '../../src/runtime/turn-execution/runtime-model-guard';
import type {
  CandidateSelection,
  EvaluationCase,
  EvaluationRun,
  EvidenceClaim,
  HumanReview,
  JsonValue,
  ObservedForbiddenBehavior,
  ToolCall,
} from './types';
import { aggregateEvaluationRuns } from './aggregate';
import {
  createCandidateIdentityCapture,
  createEvidenceReferenceCapture,
  type CandidateIdentityMapping,
} from './candidate-mapping';
import {
  messageSelectionsForEvaluation,
  observeStructuredEvidenceReferences,
} from './message-evidence';
import { savedRefsFor } from './saved-reference';
import { LIVE_MODEL_VERSION, LIVE_PROMPT_VERSION } from './live-cli';
import {
  savedReferenceObservationsFromPrompt,
  type LiveSavedReferenceBinding,
} from './saved-reference-live';
import type {
  LiveProbeArtifact,
  LiveProbeAttempt,
  LiveProbeFailure,
  LiveProbeProfile,
  LiveTraceSnapshot,
} from './live-types';

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

const numericProperty = (value: unknown, key: string): number | null => {
  if (!record(value)) return null;
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
};

const nestedNumber = (value: unknown, outer: string, inner: string): number | null => {
  if (!record(value)) return null;
  return numericProperty(value[outer], inner);
};

const restrictedLocationKey = /^(?:lat|lng|accuracyMeters|capturedAt|ownerScopeRef)$/u;
const restrictedLocationText = /["'`](?:lat|lng|accuracyMeters|capturedAt|ownerScopeRef)["'`]\s*:/u;

const containsRestrictedLocation = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value === 'string') return restrictedLocationText.test(value);
  if (!record(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(
    ([key, child]) => restrictedLocationKey.test(key) || containsRestrictedLocation(child, seen),
  );
};

/** Host-only counters deliberately retain no prompt, response body, URL, or provider error. */
export class LiveTraceRecorder {
  private startedCalls = 0;
  private completedCalls = 0;
  private failed = false;
  private startedAt = 0;
  private elapsedMs = 0;
  private inputTokenTotal = 0;
  private outputTokenTotal = 0;
  private inputTokenSamples = 0;
  private outputTokenSamples = 0;
  private readonly names: string[] = [];
  private readonly candidateIdentityCapture = createCandidateIdentityCapture();
  private readonly evidenceReferenceCapture = createEvidenceReferenceCapture();
  private savedReferenceBindings: readonly LiveSavedReferenceBinding[] = [];
  private readonly resolvedSavedPlaceRefs = new Set<string>();
  private locationExposed = false;
  private upstream = 0;

  configureSavedReferenceBindings(bindings: readonly LiveSavedReferenceBinding[]): void {
    this.savedReferenceBindings = [...bindings];
    this.resolvedSavedPlaceRefs.clear();
  }

  begin(prompt: unknown): void {
    this.startedCalls += 1;
    this.startedAt = performance.now();
    this.locationExposed ||= containsRestrictedLocation(prompt);
    observeStructuredEvidenceReferences(prompt, this.evidenceReferenceCapture);
    for (const observation of savedReferenceObservationsFromPrompt(
      prompt,
      this.savedReferenceBindings,
    )) {
      this.resolvedSavedPlaceRefs.add(observation.semanticRef);
      this.candidateIdentityCapture.observe({
        provider: observation.provider,
        recordRef: observation.recordRef,
        candidateId: observation.candidateId,
      });
    }
  }

  finish(usage: unknown): void {
    this.elapsedMs += Math.max(0, performance.now() - this.startedAt);
    this.completedCalls += 1;
    const input = nestedNumber(usage, 'inputTokens', 'total');
    const output = nestedNumber(usage, 'outputTokens', 'total');
    if (input !== null) {
      this.inputTokenTotal += input;
      this.inputTokenSamples += 1;
    }
    if (output !== null) {
      this.outputTokenTotal += output;
      this.outputTokenSamples += 1;
    }
  }

  fail(): void {
    this.failed = true;
    this.elapsedMs += Math.max(0, performance.now() - this.startedAt);
  }

  observePart(part: RuntimeModelGuardStreamPart): void {
    if (part.type === 'tool-call') {
      this.names.push(part.toolName);
    }
  }

  observeGeneratePart(part: unknown): void {
    if (record(part) && part.type === 'tool-call' && typeof part.toolName === 'string') {
      this.names.push(part.toolName);
    }
  }

  upstreamCall(): void {
    this.upstream += 1;
  }

  observeCandidateIdentity(value: unknown): void {
    this.candidateIdentityCapture.observe(value);
  }

  snapshot(): LiveTraceSnapshot {
    return {
      complete: !this.failed && this.startedCalls > 0 && this.completedCalls === this.startedCalls,
      modelCalls: this.startedCalls,
      proposedToolCalls: this.names.length,
      executedToolCalls: null,
      toolNames: [...this.names],
      upstreamCalls: this.upstream,
      latencyMs: this.startedCalls === 0 ? null : this.elapsedMs,
      inputTokens:
        this.inputTokenSamples === this.startedCalls && this.startedCalls > 0
          ? this.inputTokenTotal
          : null,
      outputTokens:
        this.outputTokenSamples === this.startedCalls && this.startedCalls > 0
          ? this.outputTokenTotal
          : null,
      measuredCostUsd: null,
      modelLocationExposed: this.locationExposed,
      preservedConditionFields: [],
      candidateIdentities: this.candidateIdentityCapture.snapshot(),
      candidateIdentityMapAvailable: this.candidateIdentityCapture.isUsable(),
      evidenceReferences: this.evidenceReferenceCapture.snapshot(),
      evidenceReferenceMapAvailable: this.evidenceReferenceCapture.isUsable(),
      resolvedSavedPlaceRefs: [...this.resolvedSavedPlaceRefs],
    };
  }
}

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

const equalJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const evidenceIdsFor = (
  evaluationCase: EvaluationCase,
  subjectId: string,
  field: string,
  value: JsonValue,
): readonly string[] =>
  evaluationCase.context.evidence
    .filter(
      (evidence) =>
        evidence.subjectId === subjectId &&
        evidence.field === field &&
        equalJson(evidence.value, value),
    )
    .map((evidence) => evidence.id);

const knownFact = (
  value: unknown,
): value is { readonly status: 'known'; readonly value: Record<string, unknown> } =>
  record(value) && value.status === 'known' && record(value.value);

const claimsForCard = (
  evaluationCase: EvaluationCase,
  card: Record<string, unknown>,
  candidateId: string,
): EvidenceClaim[] => {
  const facts = card.facts;
  if (!record(facts)) return [];
  const claims: EvidenceClaim[] = [];
  const identity = facts.identity;
  if (knownFact(identity) && typeof identity.value.name === 'string') {
    const ids = evidenceIdsFor(evaluationCase, candidateId, 'name', identity.value.name);
    claims.push({
      id: `${candidateId}:name`,
      subjectId: candidateId,
      field: 'name',
      assertedValue: identity.value.name,
      evidenceIds: ids,
      text: identity.value.name,
    });
  }
  const price = facts.price;
  if (knownFact(price) && typeof price.value.level === 'number') {
    const levels = ['unknown', 'inexpensive', 'moderate', 'expensive', 'very_expensive'];
    const level = levels[price.value.level] ?? 'unknown';
    const ids = evidenceIdsFor(evaluationCase, candidateId, 'priceLevel', level);
    claims.push({
      id: `${candidateId}:priceLevel`,
      subjectId: candidateId,
      field: 'priceLevel',
      assertedValue: level,
      evidenceIds: ids,
      text: `price level ${level}`,
    });
  }
  return claims;
};

const textFromResponse = (response: AssistantResponse): string =>
  response.message.map((item) => item.text).join('\n');

export type LiveConversion =
  | { readonly ok: true; readonly run: EvaluationRun; readonly response: AssistantResponse }
  | {
      readonly ok: false;
      readonly code:
        | 'PUBLIC_RESPONSE_INVALID'
        | 'CANDIDATE_ID_MAPPING_UNAVAILABLE'
        | 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE';
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
    name === 'search_places' || name === 'get_place_details' || name === 'submit_cards'
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
  } else {
    const messageSelections = messageSelectionsForEvaluation({
      response: output,
      evaluationCase,
      evidenceReferences: trace.evidenceReferences ?? [],
      evidenceReferenceMapAvailable: trace.evidenceReferenceMapAvailable === true,
      candidateIdentityMap: candidateIdentityMap?.ok === true ? candidateIdentityMap : undefined,
    });
    if (!messageSelections.ok) {
      return { ok: false, code: messageSelections.code, response: output };
    }
    selections.push(...messageSelections.selections);
    if (
      evaluationCase.expected.requiredCandidateIds.length > 0 &&
      messageSelections.selections.length === 0
    ) {
      return { ok: false, code: 'MESSAGE_EVIDENCE_MAPPING_UNAVAILABLE', response: output };
    }
  }
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
      schemaVersion: 'm25.v1',
      scenarioId: evaluationCase.id,
      repeat: evaluationCase.repeat,
      modelVersion: versions.modelVersion ?? LIVE_MODEL_VERSION,
      promptVersion: versions.promptVersion ?? LIVE_PROMPT_VERSION,
      response: {
        outcome: {
          kind: output.kind === 'cards' ? 'cards' : 'message',
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
        resolvedSavedPlaceRefs: savedRefsFor(trace, evaluationCase.expected.requiredSavedPlaceRefs),
        preservedConditionFields: trace.preservedConditionFields,
        candidateSetChanges: [],
      },
      metrics: {
        latencyMs: trace.latencyMs,
        modelCalls: trace.modelCalls,
        toolCalls: trace.executedToolCalls,
        upstreamCalls: trace.upstreamCalls,
        inputTokens: trace.inputTokens,
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
    schemaVersion: 'm25.live.v1',
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
