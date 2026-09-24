import type { RuntimeModelGuardStreamPart } from '@worker/runtime/turn-execution/runtime-model-guard';
import type { RuntimeTurnOutcome } from '@worker/runtime/turn-execution/runtime-submit-diagnostic';
import { createCandidateIdentityCapture } from './candidate-mapping';
import type { LiveTraceSnapshot } from './live-types';
import type { PublicToolName, RespondKind } from './types';

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

/** True when the model's turn envelope carried the harness budget preference. */
const promptCarriesBudget = (prompt: unknown): boolean => {
  if (!Array.isArray(prompt)) return false;
  return prompt.some((message) => {
    if (!record(message) || message.role !== 'user') return false;
    const parts: readonly unknown[] =
      typeof message.content === 'string'
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.map((part) => (record(part) ? part.text : undefined))
          : [];
    return parts.some((text) => {
      if (typeof text !== 'string' || !text.includes('"ima_turn_context"')) return false;
      try {
        const envelope: unknown = JSON.parse(text);
        if (!record(envelope) || !record(envelope.context)) return false;
        const preferences = envelope.context.preferences;
        return record(preferences) && typeof preferences.budget === 'string';
      } catch {
        return false;
      }
    });
  });
};

const PUBLIC_TOOLS: readonly PublicToolName[] = ['search_places', 'get_place_details', 'respond'];

/** Host-only counters deliberately retain no prompt, response body, URL, or provider error. */
export class LiveTraceRecorder {
  private startedCalls = 0;
  private completedCalls = 0;
  private failed = false;
  private startedAt = 0;
  private elapsedMs = 0;
  private inputTokenTotal = 0;
  private cachedInputTokenTotal = 0;
  private outputTokenTotal = 0;
  private inputTokenSamples = 0;
  private cachedInputTokenSamples = 0;
  private outputTokenSamples = 0;
  private readonly names: string[] = [];
  private readonly candidateIdentityCapture = createCandidateIdentityCapture();
  private locationExposed = false;
  private upstream = 0;
  private readonly conditionFields: string[] = [];
  private executed: Record<PublicToolName, number> | null = null;
  private invalidResponds = 0;
  private readonly kinds: (RespondKind | null)[] = [];

  begin(prompt: unknown): void {
    this.startedCalls += 1;
    this.startedAt = performance.now();
    this.locationExposed ||= containsRestrictedLocation(prompt);
    if (promptCarriesBudget(prompt)) this.conditionFields.push('budget');
  }

  finish(usage: unknown): void {
    this.elapsedMs += Math.max(0, performance.now() - this.startedAt);
    this.completedCalls += 1;
    const input = nestedNumber(usage, 'inputTokens', 'total');
    const cached = nestedNumber(usage, 'inputTokens', 'cacheRead');
    const output = nestedNumber(usage, 'outputTokens', 'total');
    if (input !== null) {
      this.inputTokenTotal += input;
      this.inputTokenSamples += 1;
    }
    if (cached !== null) {
      this.cachedInputTokenTotal += cached;
      this.cachedInputTokenSamples += 1;
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

  /** Records what the runtime executed in one turn and the kind it committed, if any. */
  observeTurnOutcome(outcome: RuntimeTurnOutcome): void {
    const executed = this.executed ?? { search_places: 0, get_place_details: 0, respond: 0 };
    for (const name of PUBLIC_TOOLS) executed[name] += outcome.operations[name] ?? 0;
    this.executed = executed;
    this.kinds.push(outcome.committed ? (outcome.kind ?? null) : null);
  }

  observeRespondRejection(): void {
    this.invalidResponds += 1;
  }

  snapshot(): LiveTraceSnapshot {
    const allSamples = (samples: number, total: number): number | null =>
      samples === this.startedCalls && this.startedCalls > 0 ? total : null;
    const executed = this.executed === null ? null : { ...this.executed };
    return {
      complete: !this.failed && this.startedCalls > 0 && this.completedCalls === this.startedCalls,
      modelCalls: this.startedCalls,
      proposedToolCalls: this.names.length,
      executedToolCalls:
        executed === null ? null : PUBLIC_TOOLS.reduce((sum, name) => sum + executed[name], 0),
      executedTools: executed,
      respondInvalid: this.invalidResponds,
      respondKinds: [...this.kinds],
      toolNames: [...this.names],
      upstreamCalls: this.upstream,
      latencyMs: this.startedCalls === 0 ? null : this.elapsedMs,
      turnMs: null,
      inputTokens: allSamples(this.inputTokenSamples, this.inputTokenTotal),
      cachedInputTokens: allSamples(this.cachedInputTokenSamples, this.cachedInputTokenTotal),
      outputTokens: allSamples(this.outputTokenSamples, this.outputTokenTotal),
      measuredCostUsd: null,
      modelLocationExposed: this.locationExposed,
      preservedConditionFields: [...this.conditionFields],
      candidateIdentities: this.candidateIdentityCapture.snapshot(),
      candidateIdentityMapAvailable: this.candidateIdentityCapture.isUsable(),
    };
  }
}

export type LiveTraceDeltaResult =
  | { readonly ok: true; readonly trace: LiveTraceSnapshot }
  | {
      readonly ok: false;
      readonly code: 'TRACE_DELTA_INVALID' | 'TRACE_DELTA_UNAVAILABLE';
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

type ExecutedTools = LiveTraceSnapshot['executedTools'];

/** Tool counts are cumulative per DO; a count that shrinks means the trace is not this DO's. */
const executedToolsDelta = (
  after: ExecutedTools,
  before: ExecutedTools,
): { readonly ok: true; readonly value: ExecutedTools } | { readonly ok: false } => {
  if (after === null) return before === null ? { ok: true, value: null } : { ok: false };
  if (before === null) return { ok: true, value: after };
  const search = deltaNumber(after.search_places, before.search_places);
  const details = deltaNumber(after.get_place_details, before.get_place_details);
  const respond = deltaNumber(after.respond, before.respond);
  if (!search.ok || !details.ok || !respond.ok) return { ok: false };
  return {
    ok: true,
    value: {
      search_places: search.value,
      get_place_details: details.value,
      respond: respond.value,
    },
  };
};

const suffixFor = <T>(after: readonly T[], before: readonly T[]): readonly T[] | null => {
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
  const cachedInputTokens = deltaNullableNumber(
    after.cachedInputTokens,
    before.cachedInputTokens,
    before.modelCalls,
  );
  const executedTools = executedToolsDelta(after.executedTools, before.executedTools);
  const respondInvalid = deltaNumber(after.respondInvalid, before.respondInvalid);
  const respondKinds = suffixFor(after.respondKinds, before.respondKinds);
  const toolNames = suffixFor(after.toolNames, before.toolNames);
  if (
    !modelCalls.ok ||
    !proposedToolCalls.ok ||
    !upstreamCalls.ok ||
    !latencyMs.ok ||
    !inputTokens.ok ||
    !cachedInputTokens.ok ||
    !outputTokens.ok ||
    !executedTools.ok ||
    !respondInvalid.ok ||
    respondKinds === null ||
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
      cachedInputTokens: cachedInputTokens.value,
      outputTokens: outputTokens.value,
      executedTools: executedTools.value,
      executedToolCalls:
        executedTools.value === null
          ? null
          : Object.values(executedTools.value).reduce((sum, count) => sum + count, 0),
      respondInvalid: respondInvalid.value,
      respondKinds,
      turnMs: null,
      modelLocationExposed: after.modelLocationExposed,
      preservedConditionFields,
    },
  };
};
