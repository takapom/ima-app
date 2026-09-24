import * as v from 'valibot';
import { env } from 'cloudflare:test';
import { HotPepperShopWireSchema } from '@worker/adapters/out/providers/hot-pepper/wire';
import { describe, expect, it } from 'vitest';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import {
  LiveTraceRecorder,
  resolveModelEvalLiveOptIn,
  writeLiveProbeArtifact,
} from '../../tooling/model-eval/live';
import { buildEvaluationTurnRequest } from '../../tooling/model-eval/scenario-input';
import {
  liveEvaluationProfileFor,
  type LiveEvaluationTiming,
} from '../../tooling/model-eval/live-plan';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import type { EvaluationTurnSeed } from '../../tooling/model-eval/turn-plan';
import {
  runLiveEvaluationProfiles,
  type LiveCoordinatorCasePorts,
} from '../../tooling/model-eval/live-coordinator';
import type {
  ThreadRuntimeTarget,
  ThreadRuntimeTurnInput,
} from '@worker/runtime/threads/admission';
import {
  MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  MODEL_EVAL_CONTEXT_NOW,
  MODEL_EVAL_NOW,
  fixedPlacesFetcher,
  type ModelEvalThreadDO,
} from './model-eval-live-worker';

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
  seed: EvaluationTurnSeed,
  cardContext?: Parameters<typeof buildEvaluationTurnRequest>[0]['cardContext'],
): ThreadRuntimeTurnInput => {
  const built = buildEvaluationTurnRequest({
    evaluationCase,
    seed,
    ...(cardContext === undefined ? {} : { cardContext }),
  });
  if (!built.ok) throw new Error(built.code);
  return {
    ...seed.target,
    idempotencyKey: built.request.idempotencyKey,
    deviceId: 'model-eval-device',
    input: built.request,
  };
};

const portsForCase = (
  workerEnv: LiveTestEnv,
  evaluationCase: EvaluationCase,
): LiveCoordinatorCasePorts => {
  const threadId = `model-eval-${safeId(evaluationCase.caseId)}-${crypto.randomUUID()}`;
  const target: ThreadRuntimeTarget = {
    ownerScopeRef: 'model-eval-owner',
    threadId,
    turnId: `turn-${safeId(evaluationCase.caseId)}`,
    revision: 1,
  };
  const stub = workerEnv.MODEL_EVAL_THREADS.getByName(threadId);
  const profile = liveEvaluationProfileFor(evaluationCase);
  const temporalProfile = profile === 'specific-place' || profile === 'repair' ? profile : null;
  const providerConfig =
    profile === 'candidate-failure'
      ? { responseMode: 'upstream-failure' as const }
      : profile === 'prompt-injection'
        ? { payloadMode: 'store-instruction' as const }
        : {};
  return {
    target,
    ports: {
      initialize: async () => {
        await stub.configureModelEvalLiveProfile(temporalProfile);
        await stub.configureModelEvalLiveProvider(providerConfig);
        const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
        return { ok: initialized.ok === true };
      },
      runTurn: (seed, cardContext) =>
        stub.runRuntimeTurn(requestFor(evaluationCase, seed, cardContext)),
      readTrace: () => stub.getModelEvalTrace(),
      readProfile: () => stub.getModelEvalProfile(),
    },
  };
};

const timingForCase = (evaluationCase: EvaluationCase): LiveEvaluationTiming => {
  const profile = liveEvaluationProfileFor(evaluationCase);
  return profile === 'specific-place' || profile === 'repair'
    ? { preludeClientNow: MODEL_EVAL_CONTEXT_NOW, targetClientNow: MODEL_EVAL_NOW }
    : {};
};

describe('opt-in live model evaluation runner', () => {
  it('serves the catalogue in the Hot Pepper wire shape and honors the requested page', async () => {
    const shopsFrom = async (query: string): Promise<readonly unknown[]> => {
      const response = await fixedPlacesFetcher(new LiveTraceRecorder())(
        new Request(`https://webservice.recruit.co.jp/hotpepper/gourmet/v1/?${query}`),
      );
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || !('results' in body)) {
        throw new Error('fixture response malformed');
      }
      const results = body.results;
      if (typeof results !== 'object' || results === null || !('shop' in results)) {
        throw new Error('fixture results malformed');
      }
      return Array.isArray(results.shop) ? (results.shop as readonly unknown[]) : [];
    };
    const firstPage = await shopsFrom('keyword=cafe&count=3');
    const everyShop = await shopsFrom('keyword=cafe&count=10');
    const detail = await shopsFrom('id=eval-place-d');

    expect(firstPage).toHaveLength(3);
    expect(everyShop).toHaveLength(10);
    expect(detail).toHaveLength(1);
    for (const shop of everyShop) {
      expect(v.safeParse(HotPepperShopWireSchema, shop).success).toBe(true);
    }
    expect(JSON.stringify(everyShop)).not.toMatch(/PRICE_LEVEL|priceLevel|openUntil/u);
  });

  it('runs the explicitly wired live profiles through Think and same-DO context', async ({
    skip,
  }) => {
    const optIn = resolveModelEvalLiveOptIn(env);
    if (!optIn.enabled) {
      skip(`live model evaluation skipped: ${optIn.code}`);
      return;
    }
    const scenarios = MODEL_EVALUATION_SCENARIOS.filter(
      (scenario) => liveEvaluationProfileFor({ id: scenario.id }) !== null,
    );
    const workerEnv = liveEnv();
    const artifacts = await runLiveEvaluationProfiles({
      scenarios,
      expectedIdentities: MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
      timingForCase,
      portsForCase: (evaluationCase) => portsForCase(workerEnv, evaluationCase),
    });
    let hasRuntimeFailure = false;
    for (const artifact of artifacts) {
      const artifactLines: string[] = [];
      writeLiveProbeArtifact(artifact, (line) => {
        artifactLines.push(line);
        console.log('[M25_LIVE_ARTIFACT]', line);
      });
      const serializedArtifact = artifactLines.join('\n');
      if (workerEnv.OPENAI_API_KEY !== undefined && workerEnv.OPENAI_API_KEY.length > 0) {
        expect(serializedArtifact).not.toContain(workerEnv.OPENAI_API_KEY);
      }
      expect(artifact.schemaVersion).toBe('m25.live.v2');
      expect(artifact.attempts).toHaveLength(3);
      expect(artifact.report.coverage.actual + artifact.failures.length).toBe(3);
      expect(artifact.report.coverage.expected).toBe(3);
      expect(artifact.runs.every((run) => run.metrics.measuredCostUsd === null)).toBe(true);
      expect(
        artifact.attempts.every(
          (attempt) => attempt.trace === null || attempt.trace.modelLocationExposed === false,
        ),
      ).toBe(true);
      hasRuntimeFailure ||= artifact.status === 'runtime_failed';
    }
    expect(artifacts.map((artifact) => artifact.profile)).toEqual([
      'new-search',
      'condition-change',
      'reason',
      'compare',
      'specific-place',
      'decide-action',
      'clarify-ambiguity',
      'candidate-failure',
      'mixed-intent',
      'prompt-injection',
      'continuity',
      'repair',
      'gps-refusal',
      'mood',
      'mood',
      'mood',
      'many-candidates',
    ]);
    if (hasRuntimeFailure) throw new Error('M25_LIVE_RUNTIME_FAILED');
    expect(artifacts.every((artifact) => artifact.status === 'unverified')).toBe(true);
  });
});
