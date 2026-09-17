import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import { buildEvaluationTurnRequest } from '../../tooling/model-eval/scenario-input';
import { executeLiveEvaluationCase } from '../../tooling/model-eval/live-coordinator';
import { createLiveEvaluationTurnPlan } from '../../tooling/model-eval/live-plan';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import type { EvaluationCardContext } from '../../tooling/model-eval/scenario-input';
import type { EvaluationTurnSeed } from '../../tooling/model-eval/turn-plan';
import { MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES } from './model-eval-live-worker';
import type { ModelEvalThreadDO } from './model-eval-live-worker';

type LiveInputBoundaryEnv = Cloudflare.Env & {
  readonly MODEL_EVAL_THREADS: DurableObjectNamespace<ModelEvalThreadDO>;
};

const workerEnv = (): LiveInputBoundaryEnv => env as LiveInputBoundaryEnv;

const scenarioFor = (id: 'condition-change' | 'mixed-intent'): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`scenario missing: ${id}`);
  return { ...scenario, caseId: `${id}:live-input-boundary`, repeat: 1 };
};

const runInputBoundary = async (evaluationCase: EvaluationCase) => {
  const threadId = `model-eval-live-input-${crypto.randomUUID()}`;
  const target = {
    ownerScopeRef: 'model-eval-live-input-owner',
    threadId,
    turnId: `${threadId}-turn-1`,
    revision: 1,
  } as const;
  const stub = workerEnv().MODEL_EVAL_THREADS.getByName(threadId);
  await stub.configureModelEvalRequestCapture(true);
  await stub.initialize(target.ownerScopeRef, target.threadId);
  const planResult = createLiveEvaluationTurnPlan(evaluationCase);
  if (!planResult.ok) throw new Error(planResult.code);
  const result = await executeLiveEvaluationCase({
    evaluationCase,
    plan: planResult.plan,
    target,
    expectedIdentities: MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
    ports: {
      initialize: async () => {
        const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
        return { ok: initialized.ok === true };
      },
      runTurn: async (seed: EvaluationTurnSeed, cardContext?: EvaluationCardContext) => {
        const built = buildEvaluationTurnRequest({
          evaluationCase,
          seed,
          ...(cardContext === undefined ? {} : { cardContext }),
        });
        if (!built.ok) throw new Error(built.code);
        return stub.runRuntimeTurn({
          ...seed.target,
          idempotencyKey: built.request.idempotencyKey,
          deviceId: 'model-eval-live-input-device',
          input: built.request,
        });
      },
      readTrace: () => stub.getModelEvalTrace(),
      readProfile: () => stub.getModelEvalProfile(),
    },
  });
  return { evaluationCase, result, captured: await stub.getModelEvalRequestCapture(), stub };
};

describe('model-eval live input boundary', () => {
  it.each(['condition-change', 'mixed-intent'] as const)(
    'passes formal %s context into ModelEvalThreadDO without a provider call',
    async (id) => {
      const { evaluationCase, result, captured, stub } = await runInputBoundary(scenarioFor(id));
      expect(result.attempt.status).toBe('runtime_failed');
      expect(captured).not.toBeNull();
      if (captured === null) return;
      expect(captured.input.text).toBe(evaluationCase.userTurns[0]);
      expect(captured.input.prefs).toMatchObject({ budget: 'normal', areaText: '渋谷' });
      expect(captured.input.mode).toBe('search');
      expect(await stub.getModelEvalTrace()).toMatchObject({
        modelCalls: 0,
        upstreamCalls: 0,
      });
    },
  );
});
