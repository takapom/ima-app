import { env } from 'cloudflare:test';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { AssistantResponseSchema } from '@ima/contracts';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import { buildEvaluationTurnRequest } from '../../tooling/model-eval/scenario-input';
import { resolveCandidateIdentityMapping } from '../../tooling/model-eval/candidate-mapping';
import { createEvaluationTurnSeed } from '../../tooling/model-eval/turn-plan';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import {
  MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  MODEL_EVAL_NOW,
} from './model-eval-place-fixture';
import type { ModelEvalConditionFixtureProfile } from './condition-context-fixture';
import type { ModelEvalFixtureThreadDO } from './model-eval-context-worker';

type ConditionContextTestEnv = Cloudflare.Env & {
  readonly MODEL_EVAL_CONTEXT_THREADS: DurableObjectNamespace<ModelEvalFixtureThreadDO>;
};

const contextEnv = (): ConditionContextTestEnv => {
  if (!('MODEL_EVAL_CONTEXT_THREADS' in env)) throw new Error('MODEL_EVAL_CONTEXT_BINDING_MISSING');
  return env as ConditionContextTestEnv;
};

const scenarioFor = (id: ModelEvalConditionFixtureProfile): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((item) => item.id === id);
  if (scenario === undefined) throw new Error(`scenario missing: ${id}`);
  return { ...scenario, caseId: `${id}:condition-fixture`, repeat: 1 };
};

const runConditionFixture = async (profile: ModelEvalConditionFixtureProfile) => {
  const evaluationCase = scenarioFor(profile);
  const threadId = `model-eval-${profile}-${crypto.randomUUID()}`;
  const target = {
    ownerScopeRef: 'model-eval-condition-owner',
    threadId,
    turnId: `${threadId}-turn-1`,
    revision: 1,
  } as const;
  const stub = contextEnv().MODEL_EVAL_CONTEXT_THREADS.getByName(threadId);
  const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
  if (!initialized.ok) throw new Error(initialized.code);
  await stub.configureModelEvalFixture('cards', MODEL_EVAL_NOW, profile);
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
    deviceId: 'model-eval-condition-device',
    input: built.request,
  });
  if (result.status !== 'completed') {
    throw new Error(`M25_CONDITION_FIXTURE_RUNTIME_FAILED:${result.code ?? 'unknown'}`);
  }
  const response = v.safeParse(AssistantResponseSchema, result.response);
  if (!response.success) throw new Error('M25_CONDITION_FIXTURE_RESPONSE_INVALID');
  return { evaluationCase, built: built.request, response: response.output, stub };
};

describe('condition and mixed-intent fixture profiles through one DO', () => {
  it.each(['condition-change', 'mixed-intent'] as const)(
    'projects normal budget, soft intent, and observed price for %s',
    async (profile) => {
      const result = await runConditionFixture(profile);
      expect(result.built.clientNow).toBe(MODEL_EVAL_NOW);
      expect(result.built.prefs.budget).toBe('normal');
      expect(result.built.cardSetId).toBeUndefined();
      expect(result.response.kind).toBe('cards');
      if (result.response.kind !== 'cards') return;

      const hero = result.response.cards.hero;
      const price = hero.facts.price;
      expect(price?.status).toBe('known');
      if (price?.status !== 'known') return;
      expect(price.value.level).toBe(2);
      expect(Object.hasOwn(result.response.cards.hero.facts, 'quietness')).toBe(false);

      const mapping = resolveCandidateIdentityMapping(
        await result.stub.getModelEvalFixtureCandidateIdentities(),
        MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
      );
      expect(mapping.ok).toBe(true);
      if (!mapping.ok) return;
      const identity = mapping.pairs.find((pair) => pair.evaluationCandidateId === 'candidate-a');
      const runtimeA = identity?.runtimeCandidateId;
      expect(runtimeA).toBe(hero.candidateId);
      expect(identity?.recordRef).toBe('eval-place-a');

      const snapshot = (await result.stub.getModelEvalFixtureEvidenceSnapshots()).find(
        (item) => item.candidateId === hero.candidateId,
      );
      expect(snapshot?.modelBudget).toBe('normal');
      const priceObservation = snapshot?.observations.find((item) => item.field === 'price');
      expect(priceObservation).toBeDefined();
      expect(price.evidence.map((item) => item.evidenceId)).toContain(
        priceObservation?.observationId,
      );
      expect(price.evidence[0]?.retention.freshUntil).not.toBeNull();
      expect(Date.parse(price.evidence[0]?.retention.freshUntil ?? '')).toBeGreaterThan(
        Date.parse(MODEL_EVAL_NOW),
      );

      const expectedQuery =
        profile === 'condition-change' ? '静かな店 渋谷' : '静かで予算内の店 渋谷';
      expect(await result.stub.getModelEvalFixtureSearchQueries()).toEqual([expectedQuery]);
      expect(await result.stub.getModelEvalFixtureSteps()).toEqual([
        'search_places',
        'get_place_details',
        'submit_cards',
      ]);
    },
  );
});
