import { env } from 'cloudflare:test';
import * as v from 'valibot';
import { AssistantResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import { executionProfileFor } from '../../tooling/model-eval/execution-profile';
import { liveEvaluationProfileFor } from '../../tooling/model-eval/live-plan';
import { buildEvaluationTurnRequest } from '../../tooling/model-eval/scenario-input';
import { createEvaluationTurnSeed } from '../../tooling/model-eval/turn-plan';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import { MODEL_EVAL_NOW, type ModelEvalPlacesResponseMode } from './model-eval-place-fixture';
import type { ModelEvalFixtureThreadDO } from './model-eval-context-worker';

type FailureFixtureEnv = Cloudflare.Env & {
  readonly MODEL_EVAL_CONTEXT_THREADS: DurableObjectNamespace<ModelEvalFixtureThreadDO>;
};

const fixtureEnv = (): FailureFixtureEnv => {
  if (!('MODEL_EVAL_CONTEXT_THREADS' in env)) throw new Error('MODEL_EVAL_CONTEXT_BINDING_MISSING');
  return env as FailureFixtureEnv;
};

const scenarioFor = (id: EvaluationCase['id']): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((item) => item.id === id);
  if (scenario === undefined) throw new Error(`scenario missing: ${id}`);
  return { ...scenario, caseId: `${id}:failure-fixture`, repeat: 1 };
};

const runFixture = async (responseMode: ModelEvalPlacesResponseMode) => {
  const evaluationCase = scenarioFor('candidate-failure');
  const threadId = `model-eval-candidate-failure-${responseMode}-${crypto.randomUUID()}`;
  const target = {
    ownerScopeRef: 'model-eval-failure-owner',
    threadId,
    turnId: `${threadId}-turn-1`,
    revision: 1,
  } as const;
  const stub = fixtureEnv().MODEL_EVAL_CONTEXT_THREADS.getByName(threadId);
  const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
  if (!initialized.ok) throw new Error(initialized.code);
  await stub.configureModelEvalFixture(
    'cards',
    MODEL_EVAL_NOW,
    'candidate-failure',
    'clarify',
    responseMode,
  );
  const seed = createEvaluationTurnSeed({
    caseId: evaluationCase.caseId,
    userTurns: evaluationCase.userTurns,
    target,
  });
  if (!seed.ok) throw new Error(seed.code);
  const built = buildEvaluationTurnRequest({ evaluationCase, seed: seed.seed });
  if (!built.ok) throw new Error(built.code);
  const result = await stub.runRuntimeTurn({
    ...target,
    idempotencyKey: built.request.idempotencyKey,
    deviceId: 'model-eval-failure-device',
    input: built.request,
  });
  if (result.status !== 'completed')
    throw new Error(`M25_FAILURE_FIXTURE_${result.code ?? 'FAILED'}`);
  const parsed = v.safeParse(AssistantResponseSchema, result.response);
  if (!parsed.success) throw new Error('M25_FAILURE_FIXTURE_RESPONSE_INVALID');
  return { evaluationCase, response: parsed.output, result, stub };
};

describe('candidate-failure fixture profile through the production adapter and one DO', () => {
  it('declares a fixture-only profile without changing the canonical scenario', () => {
    const evaluationCase = scenarioFor('candidate-failure');
    expect(evaluationCase.userTurns).toEqual(['条件に合う店がないなら、分かる範囲で教えて。']);
    expect(evaluationCase.context.now).toBe(MODEL_EVAL_NOW);
    expect(executionProfileFor(evaluationCase)).toEqual({
      status: 'fixture_ready',
      kind: 'failure_response',
      requiresApiKey: false,
    });
    expect(liveEvaluationProfileFor(evaluationCase)).toBeNull();
  });

  it('keeps an upstream failure distinct from an empty successful search', async () => {
    const failed = await runFixture('upstream-failure');
    const failedText = failed.response.kind === 'message' ? failed.response.message[0]?.text : '';
    expect(failed.response.kind).toBe('message');
    expect(failedText).toBe('候補を取得できませんでした。');
    expect(failed.response.kind === 'message' && failed.response.message[0]?.evidenceIds).toEqual(
      [],
    );
    expect(await failed.stub.getModelEvalFixtureSteps()).toEqual([
      'search_places',
      'final_message',
    ]);
    expect(await failed.stub.getModelEvalFixtureCandidateIdentities()).toEqual([]);
    expect(await failed.stub.getModelEvalFixtureDetailsRequests()).toEqual([]);
    expect(await failed.stub.getModelEvalFixtureToolErrorCodes()).toEqual(['UPSTREAM_UNAVAILABLE']);
    expect(await failed.stub.getModelEvalFixturePrivateUpstreamBodyExposed()).toBe(false);
    const failedTrace = await failed.stub.getModelEvalFixtureTrace();
    expect(failedTrace.upstreamCalls).toBe(2);
    expect(failedTrace.modelCalls).toBe(2);
    expect(failedTrace.complete).toBe(true);

    const empty = await runFixture('empty');
    const emptyText = empty.response.kind === 'message' ? empty.response.message[0]?.text : '';
    expect(empty.response.kind).toBe('message');
    expect(emptyText).toBe('条件に合う候補は見つかりませんでした。');
    expect(emptyText).not.toContain('取得できませんでした');
    expect(empty.response.kind === 'message' && empty.response.message[0]?.evidenceIds).toEqual([]);
    expect(await empty.stub.getModelEvalFixtureSteps()).toEqual(['search_places', 'final_message']);
    expect(await empty.stub.getModelEvalFixtureCandidateIdentities()).toEqual([]);
    expect(await empty.stub.getModelEvalFixtureToolErrorCodes()).toEqual([]);
    const emptyTrace = await empty.stub.getModelEvalFixtureTrace();
    expect(emptyTrace.upstreamCalls).toBe(1);
    expect(emptyTrace.modelCalls).toBe(2);
    expect(emptyTrace.complete).toBe(true);

    const malformed = await runFixture('schema-failure');
    const malformedText =
      malformed.response.kind === 'message' ? malformed.response.message[0]?.text : '';
    expect(malformed.response.kind).toBe('message');
    expect(malformedText).toBe('候補を確認できませんでした。');
    expect(await malformed.stub.getModelEvalFixtureToolErrorCodes()).toEqual(['SCHEMA_MISMATCH']);
    expect(await malformed.stub.getModelEvalFixtureCandidateIdentities()).toEqual([]);
    expect(await malformed.stub.getModelEvalFixtureDetailsRequests()).toEqual([]);
    const malformedTrace = await malformed.stub.getModelEvalFixtureTrace();
    expect(malformedTrace.upstreamCalls).toBe(1);
    expect(malformedTrace.modelCalls).toBe(2);
    expect(malformedTrace.complete).toBe(true);

    const serialized = JSON.stringify(failed.response);
    expect(serialized).not.toContain('M25_FIXTURE_PRIVATE_UPSTREAM_BODY');
    expect(serialized).not.toContain('UPSTREAM_UNAVAILABLE');
  });
});
