import type { AssistantResponse } from '@ima/contracts';
import type { RuntimeCandidateIdentity, RuntimeEvidenceReference } from './candidate-mapping';
import type { LiveEvaluationProfile } from './live-plan';
import type { EvaluationReport, EvaluationRun } from './types';

export type LiveTraceSnapshot = {
  readonly complete: boolean;
  readonly modelCalls: number;
  /** Tool calls proposed by the model; execution count is intentionally separate. */
  readonly proposedToolCalls: number;
  readonly executedToolCalls: number | null;
  readonly toolNames: readonly string[];
  readonly upstreamCalls: number;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly measuredCostUsd: null;
  readonly modelLocationExposed: boolean;
  readonly preservedConditionFields: readonly string[];
  /** Registry records observed by the host for this attempt; no display-name join is allowed. */
  readonly candidateIdentities: readonly RuntimeCandidateIdentity[];
  /** True only when this attempt captured at least one non-conflicting identity. */
  readonly candidateIdentityMapAvailable: boolean;
  /** Registry/model evidence identity only; values and provider payloads are omitted. */
  readonly evidenceReferences?: readonly RuntimeEvidenceReference[];
  /** False/absent means message evidence cannot be joined for automatic evaluation. */
  readonly evidenceReferenceMapAvailable?: boolean;
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
  readonly schemaVersion: 'm25.live.v1';
  readonly profile: LiveProbeProfile;
  readonly status: 'evaluated' | 'unverified' | 'runtime_failed';
  readonly attempts: readonly LiveProbeAttempt[];
  readonly runs: readonly EvaluationRun[];
  readonly failures: readonly LiveProbeFailure[];
  readonly report: EvaluationReport;
};
