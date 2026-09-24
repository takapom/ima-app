import type { AssistantResponse } from '@ima/contracts';
import type { RuntimeCandidateIdentity } from './candidate-mapping';
import type { LiveEvaluationProfile } from './live-plan';
import type { EvaluationReport, EvaluationRun, PublicToolName, RespondKind } from './types';

export type LiveTraceSnapshot = {
  readonly complete: boolean;
  readonly modelCalls: number;
  /** Tool calls proposed by the model; execution count is intentionally separate. */
  readonly proposedToolCalls: number;
  /** Operations the runtime reported executing; null until a turn outcome is observed. */
  readonly executedToolCalls: number | null;
  readonly executedTools: Readonly<Record<PublicToolName, number>> | null;
  /** Responds the Core refused as invalid input. */
  readonly respondInvalid: number;
  /** One entry per finished turn: the committed kind, or null when nothing was committed. */
  readonly respondKinds: readonly (RespondKind | null)[];
  readonly toolNames: readonly string[];
  readonly upstreamCalls: number;
  /** Model time summed over calls. */
  readonly latencyMs: number | null;
  /** Whole-turn time including tools, measured by the coordinator around one turn. */
  readonly turnMs: number | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly measuredCostUsd: null;
  readonly modelLocationExposed: boolean;
  readonly preservedConditionFields: readonly string[];
  /** Registry records observed by the host for this attempt; no display-name join is allowed. */
  readonly candidateIdentities: readonly RuntimeCandidateIdentity[];
  /** True only when this attempt captured at least one non-conflicting identity. */
  readonly candidateIdentityMapAvailable: boolean;
};

export type ModelEvalLiveCliCode = 0 | 1 | 2;

export type LiveProbeProfile = LiveEvaluationProfile;

export type LiveProbeAttemptStatus = 'evaluated' | 'unverified_mapping' | 'runtime_failed';

export type LiveProbeAttempt = {
  readonly caseId: string;
  readonly status: LiveProbeAttemptStatus;
  readonly code: string | null;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly trace: LiveTraceSnapshot | null;
  /** Only schema-validated public DTOs are retained; malformed bodies are omitted. */
  readonly publicResponse: AssistantResponse | null;
};

export type LiveProbeFailure = {
  readonly caseId: string;
  readonly code: string;
  readonly status: Exclude<LiveProbeAttemptStatus, 'evaluated'>;
};

export type LiveProbeArtifact = {
  readonly schemaVersion: 'm25.live.v2';
  readonly profile: LiveProbeProfile;
  readonly status: 'evaluated' | 'unverified' | 'runtime_failed';
  readonly attempts: readonly LiveProbeAttempt[];
  readonly runs: readonly EvaluationRun[];
  readonly failures: readonly LiveProbeFailure[];
  readonly report: EvaluationReport;
};
