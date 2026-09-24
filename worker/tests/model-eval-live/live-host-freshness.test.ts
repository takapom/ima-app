import { env } from 'cloudflare:test';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { AssistantResponseSchema, type ThreadTurnRequest } from '@ima/contracts';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import {
  executeLiveEvaluationCase,
  type LiveCoordinatorPorts,
} from '../../tooling/model-eval/live-coordinator';
import { createLiveEvaluationTurnPlan } from '../../tooling/model-eval/live-plan';
import { buildEvaluationTurnRequest } from '../../tooling/model-eval/scenario-input';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import {
  MODEL_EVAL_CONTEXT_NOW,
  MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  MODEL_EVAL_NOW,
  type ModelEvalFixtureLiveThreadDO,
} from './model-eval-live-worker';

type LiveHostFreshnessEnv = Cloudflare.Env & {
  readonly MODEL_EVAL_FIXTURE_LIVE_THREADS: DurableObjectNamespace<ModelEvalFixtureLiveThreadDO>;
};

type LiveHostTurn = {
  readonly status: string;
  readonly response: unknown;
  readonly code?: string;
};

const fixtureEnv = (): LiveHostFreshnessEnv => {
  if (!('MODEL_EVAL_FIXTURE_LIVE_THREADS' in env)) {
    throw new Error('MODEL_EVAL_FIXTURE_LIVE_THREADS_BINDING_MISSING');
  }
  return env as LiveHostFreshnessEnv;
};

const evaluationCaseFor = (
  profile: 'specific-place' | 'repair',
  caseId: string,
): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((candidate) => candidate.id === profile);
  if (scenario === undefined) throw new Error(`missing scenario: ${profile}`);
  return { ...scenario, caseId, repeat: 1 };
};

const runProfile = async (profile: 'specific-place' | 'repair') => {
  const evaluationCase = evaluationCaseFor(profile, `${profile}:live-host`);
  const threadId = `model-eval-live-host-${profile}-${crypto.randomUUID()}`;
  const target = {
    ownerScopeRef: 'model-eval-live-host-owner',
    threadId,
    turnId: `${threadId}-turn-1`,
    revision: 1,
  } as const;
  const stub = fixtureEnv().MODEL_EVAL_FIXTURE_LIVE_THREADS.getByName(threadId);
  await stub.configureModelEvalLiveFixture('cards', profile);
  const requests: ThreadTurnRequest[] = [];
  const turns: LiveHostTurn[] = [];
  const ports: LiveCoordinatorPorts = {
    initialize: async () => {
      const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
      return { ok: initialized.ok === true };
    },
    runTurn: async (seed, cardContext) => {
      await stub.configureModelEvalLivePhase(seed.index === 0 ? 'cards' : 'message');
      const built = buildEvaluationTurnRequest({
        evaluationCase,
        seed,
        ...(cardContext === undefined ? {} : { cardContext }),
      });
      if (!built.ok) throw new Error(built.code);
      requests.push(built.request);
      const result = await stub.runRuntimeTurn({
        ...seed.target,
        idempotencyKey: built.request.idempotencyKey,
        deviceId: 'model-eval-live-host-device',
        input: built.request,
      });
      turns.push(result);
      return {
        status: result.status,
        ...(result.code === undefined ? {} : { code: result.code }),
        response: result.response,
      };
    },
    readTrace: () => stub.getModelEvalTrace(),
    readProfile: () => stub.getModelEvalProfile(),
  };
  const plan = createLiveEvaluationTurnPlan(evaluationCase, {
    preludeClientNow: MODEL_EVAL_CONTEXT_NOW,
    targetClientNow: MODEL_EVAL_NOW,
  });
  if (!plan.ok) throw new Error(plan.code);
  const execution = await executeLiveEvaluationCase({
    evaluationCase,
    plan: plan.plan,
    target,
    ports,
    expectedIdentities: MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  });
  return { execution, requests, stub, turns };
};

describe('keyless live host timing and freshness boundary', () => {
  it.each(['specific-place', 'repair'] as const)(
    'runs %s prelude and target through one production host DO',
    async (profile) => {
      const result = await runProfile(profile);
      expect(result.requests.map((request) => request.clientNow)).toEqual([
        MODEL_EVAL_CONTEXT_NOW,
        MODEL_EVAL_NOW,
      ]);
      expect(result.requests[1]?.cardSetId).toBeTruthy();
      expect(result.execution.attempt.trace).toMatchObject({
        modelCalls: 2,
        upstreamCalls: 1,
        complete: true,
      });
      expect(result.execution.failure).toBeUndefined();
      expect(result.execution.attempt.status).toBe('evaluated');
      // The answer cites no candidates; which one it discusses is left to human review.
      expect(result.execution.run?.response.selections).toEqual([]);
      expect(result.execution.run?.metrics.respondKind).toBe('answer');
      const prelude = v.safeParse(AssistantResponseSchema, result.turns[0]?.response);
      expect(prelude.success).toBe(true);
      if (!prelude.success) throw new Error('M25_LIVE_HOST_PRELUDE_INVALID');
      expect(prelude.output.kind).toBe('cards');
      if (prelude.output.kind !== 'cards') throw new Error('M25_LIVE_HOST_PRELUDE_NOT_CARDS');
      const heroOpening = prelude.output.cards.hero.facts.opening_hours;
      const heroCandidateId = prelude.output.cards.hero.candidateId;
      expect(heroOpening?.status).toBe('known');
      if (heroOpening?.status !== 'known') throw new Error('M25_LIVE_HOST_OPENING_MISSING');
      const oldEvidenceIds = heroOpening.evidence.map((evidence) => evidence.evidenceId);
      expect(oldEvidenceIds.length).toBeGreaterThan(0);
      if (profile === 'repair') {
        expect(heroOpening.evidence[0]?.retention.freshUntil).toBe(MODEL_EVAL_NOW);
      }
      const response = result.execution.attempt.publicResponse;
      const parsed = v.safeParse(AssistantResponseSchema, response);
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error('M25_LIVE_HOST_TARGET_INVALID');
      expect(parsed.output.kind).toBe('message');
      if (parsed.output.kind !== 'message') throw new Error('M25_LIVE_HOST_TARGET_NOT_MESSAGE');
      if (profile === 'repair') {
        const snapshots = await result.stub.getModelEvalFixtureEvidenceSnapshots();
        // The target answer rests on a refreshed opening-hours summary from this turn's read.
        expect(
          snapshots
            .filter((snapshot) => snapshot.candidateId === heroCandidateId)
            .some((snapshot) =>
              snapshot.observations.some(
                (observation) =>
                  observation.field === 'opening_hours' &&
                  observation.source === 'details' &&
                  observation.status === 'known',
              ),
            ),
        ).toBe(true);
        const published = JSON.stringify(parsed.output);
        oldEvidenceIds.forEach((evidenceId) => expect(published).not.toContain(evidenceId));
      } else {
        expect(result.execution.attempt.publicResponse).toMatchObject({ kind: 'message' });
      }
    },
  );
});
