import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  expandEvaluationDataset,
  MODEL_EVALUATION_SCENARIOS,
} from '../../tooling/model-eval/dataset';
import {
  buildEvaluationRunFromResponse,
  createLiveProbeArtifact,
  LIVE_PROMPT_VERSION,
  resolveModelEvalLiveOptIn,
  writeLiveProbeArtifact,
  type LiveProbeAttempt,
  type LiveProbeFailure,
  type LiveTraceSnapshot,
} from '../../tooling/model-eval/live';
import type { EvaluationCase, EvaluationRun } from '../../tooling/model-eval/types';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '../../src/thread-runtime/admission';
import type { ModelEvalThreadDO } from './model-eval-live-worker';

type LiveTestEnv = Cloudflare.Env & {
  readonly MODEL_EVAL_LIVE?: string;
  readonly OPENAI_API_KEY?: string;
  readonly MODEL_EVAL_THREADS: DurableObjectNamespace<ModelEvalThreadDO>;
};

const liveEnv = (): LiveTestEnv => {
  if (!('MODEL_EVAL_THREADS' in env)) throw new Error('MODEL_EVAL_THREAD_BINDING_MISSING');
  return env as LiveTestEnv;
};

const safeId = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/gu, '_');

const requestFor = (
  evaluationCase: EvaluationCase,
  target: ThreadRuntimeTarget,
): ThreadRuntimeTurnInput => {
  const idempotencyKey = `model-eval-${safeId(evaluationCase.caseId)}`;
  const input = {
    schemaVersion: 'v1' as const,
    requestId: `request-${safeId(evaluationCase.caseId)}`,
    turnId: target.turnId,
    revision: target.revision,
    text: evaluationCase.userTurns[0] ?? '条件に合う場所を探して。',
    clientNow: evaluationCase.context.now,
    location: {
      status: evaluationCase.context.locationStatus,
      lat: evaluationCase.context.locationStatus === 'available' ? 35.6595 : null,
      lng: evaluationCase.context.locationStatus === 'available' ? 139.7005 : null,
      accuracyMeters: evaluationCase.context.locationStatus === 'available' ? 40 : null,
      precise: false,
      capturedAt:
        evaluationCase.context.locationStatus === 'available' ? evaluationCase.context.now : null,
    },
    prefs: {
      homeStationRef: null,
      maxWalkMinutes: null,
      minimumStayMinutes: 20,
      areaText: '渋谷',
      budget: 'normal' as const,
    },
    savedPlaceRefs: [...evaluationCase.context.savedPlaceRefs],
    excludeCandidateIds: [],
    mode: 'search' as const,
    idempotencyKey,
  };
  return {
    ...target,
    idempotencyKey,
    deviceId: 'model-eval-device',
    input,
  };
};

type LiveProfile = { readonly model: string; readonly promptVersion: string };

const readTrace = async (
  read: () => Promise<LiveTraceSnapshot>,
): Promise<LiveTraceSnapshot | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

const readProfile = async (read: () => Promise<LiveProfile>): Promise<LiveProfile | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

const versionsFor = (profile: LiveProfile | null) => ({
  modelVersion: profile === null ? 'openai:unknown' : `openai:${profile.model}`,
  promptVersion: profile?.promptVersion ?? LIVE_PROMPT_VERSION,
});

describe('opt-in live model evaluation runner', () => {
  it('runs the honest new-search profile through Think and converts its public response', async ({
    skip,
  }) => {
    const optIn = resolveModelEvalLiveOptIn(env);
    if (!optIn.enabled) {
      skip(`live model evaluation skipped: ${optIn.code}`);
      return;
    }
    const scenarios = MODEL_EVALUATION_SCENARIOS.filter(
      (evaluationScenario) => evaluationScenario.id === 'new-search',
    );
    const cases = expandEvaluationDataset(scenarios);
    const runs: EvaluationRun[] = [];
    const attempts: LiveProbeAttempt[] = [];
    const failures: LiveProbeFailure[] = [];
    const workerEnv = liveEnv();
    for (const evaluationCase of cases) {
      const threadId = `model-eval-${safeId(evaluationCase.caseId)}-${crypto.randomUUID()}`;
      const target: ThreadRuntimeTarget = {
        ownerScopeRef: 'model-eval-owner',
        threadId,
        turnId: `turn-${safeId(evaluationCase.caseId)}`,
        revision: 1,
      };
      const stub = workerEnv.MODEL_EVAL_THREADS.getByName(threadId);
      const fallbackVersions = versionsFor(null);
      try {
        const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
        if (initialized.ok !== true) {
          failures.push({
            caseId: evaluationCase.caseId,
            code: 'INITIALIZE_FAILED',
            status: 'runtime_failed',
          });
          attempts.push({
            caseId: evaluationCase.caseId,
            status: 'runtime_failed',
            code: 'INITIALIZE_FAILED',
            ...fallbackVersions,
            trace: await readTrace(() => stub.getModelEvalTrace()),
            publicResponse: null,
          });
          continue;
        }

        const result = await stub.runRuntimeTurn(requestFor(evaluationCase, target));
        const trace = await readTrace(() => stub.getModelEvalTrace());
        const profile = await readProfile(() => stub.getModelEvalProfile());
        const versions = versionsFor(profile);
        if (result.status !== 'completed' || result.response === null) {
          const code = result.code ?? 'RUNTIME_FAILED';
          failures.push({ caseId: evaluationCase.caseId, code, status: 'runtime_failed' });
          attempts.push({
            caseId: evaluationCase.caseId,
            status: 'runtime_failed',
            code,
            ...versions,
            trace,
            publicResponse: null,
          });
          continue;
        }
        if (trace === null) {
          failures.push({
            caseId: evaluationCase.caseId,
            code: 'TRACE_UNAVAILABLE',
            status: 'runtime_failed',
          });
          attempts.push({
            caseId: evaluationCase.caseId,
            status: 'runtime_failed',
            code: 'TRACE_UNAVAILABLE',
            ...versions,
            trace: null,
            publicResponse: null,
          });
          continue;
        }
        const converted = buildEvaluationRunFromResponse(
          evaluationCase,
          result.response,
          trace,
          undefined,
          versions,
        );
        if (!converted.ok) {
          const status =
            converted.code === 'CANDIDATE_ID_MAPPING_UNAVAILABLE'
              ? 'unverified_mapping'
              : 'runtime_failed';
          failures.push({ caseId: evaluationCase.caseId, code: converted.code, status });
          attempts.push({
            caseId: evaluationCase.caseId,
            status,
            code: converted.code,
            ...versions,
            trace,
            publicResponse: converted.response ?? null,
          });
          continue;
        }
        runs.push(converted.run);
        attempts.push({
          caseId: evaluationCase.caseId,
          status: 'evaluated',
          code: null,
          ...versions,
          trace,
          publicResponse: converted.response,
        });
      } catch {
        failures.push({
          caseId: evaluationCase.caseId,
          code: 'RUNTIME_EXCEPTION',
          status: 'runtime_failed',
        });
        attempts.push({
          caseId: evaluationCase.caseId,
          status: 'runtime_failed',
          code: 'RUNTIME_EXCEPTION',
          ...fallbackVersions,
          trace: await readTrace(() => stub.getModelEvalTrace()),
          publicResponse: null,
        });
      }
    }
    const artifact = createLiveProbeArtifact({
      profile: 'new-search',
      scenarios,
      attempts,
      runs,
      failures,
    });
    const artifactLines: string[] = [];
    writeLiveProbeArtifact(artifact, (line) => {
      artifactLines.push(line);
      console.log('[M25_LIVE_ARTIFACT]', line);
    });
    const serializedArtifact = artifactLines.join('\n');
    if (workerEnv.OPENAI_API_KEY !== undefined && workerEnv.OPENAI_API_KEY.length > 0) {
      expect(serializedArtifact).not.toContain(workerEnv.OPENAI_API_KEY);
    }
    expect(artifact.schemaVersion).toBe('m25.live.v1');
    expect(artifact.attempts).toHaveLength(cases.length);
    expect(artifact.report.coverage.actual + artifact.failures.length).toBe(cases.length);
    expect(artifact.report.coverage.expected).toBe(cases.length);
    expect(artifact.runs.every((run) => run.metrics.measuredCostUsd === null)).toBe(true);
    expect(artifact.runs.every((run) => run.trace.modelLocationExposed === false)).toBe(true);
    expect(
      artifact.attempts.every(
        (attempt) => attempt.trace === null || attempt.trace.modelLocationExposed === false,
      ),
    ).toBe(true);
    if (artifact.status === 'runtime_failed') throw new Error('M25_LIVE_RUNTIME_FAILED');
    expect(artifact.status).toBe('unverified');
  });
});
