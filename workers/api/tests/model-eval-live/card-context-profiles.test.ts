import { env } from 'cloudflare:test';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  AssistantResponseSchema,
  type AssistantResponse,
  type ThreadTurnRequest,
} from '@ima/contracts';
import {
  executeLiveEvaluationCase,
  type LiveCoordinatorPorts,
} from '../../tooling/model-eval/live-coordinator';
import { buildEvaluationTurnRequest } from '../../tooling/model-eval/scenario-input';
import { createLiveEvaluationTurnPlan } from '../../tooling/model-eval/live-plan';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import type { EvaluationTurnSeed } from '../../tooling/model-eval/turn-plan';
import { resolveCandidateIdentityMapping } from '../../tooling/model-eval/candidate-mapping';
import {
  MODEL_EVAL_CONTEXT_NOW,
  MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  MODEL_EVAL_NOW,
} from './model-eval-place-fixture';
import type {
  ModelEvalFixtureProfile,
  ModelEvalFixtureThreadDO,
} from './model-eval-context-worker';

type CardContextTestEnv = Cloudflare.Env & {
  readonly MODEL_EVAL_CONTEXT_THREADS: DurableObjectNamespace<ModelEvalFixtureThreadDO>;
};

const contextEnv = (): CardContextTestEnv => {
  if (!('MODEL_EVAL_CONTEXT_THREADS' in env)) throw new Error('MODEL_EVAL_CONTEXT_BINDING_MISSING');
  return env as CardContextTestEnv;
};

const caseFor = (id: EvaluationCase['id']): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`missing scenario: ${id}`);
  return {
    ...scenario,
    caseId: `${id}:clock-control`,
    repeat: 1,
    context: { ...scenario.context, now: MODEL_EVAL_NOW },
  };
};

const targetFor = (threadId: string) => ({
  ownerScopeRef: 'model-eval-card-context-owner',
  threadId,
  turnId: `${threadId}-turn-1`,
  revision: 1,
});

const retentionBoundaries = (response: Extract<AssistantResponse, { kind: 'cards' }>): void => {
  const targetMs = Date.parse(MODEL_EVAL_NOW);
  for (const card of [response.cards.hero, ...response.cards.alts]) {
    const textRetention = card.why.retention;
    expect(textRetention.retentionDecision).toBe('allow');
    expect(textRetention.displayPolicyStatus).toBe('available');
    expect(Date.parse(textRetention.sessionExpiresAt)).toBeGreaterThan(targetMs);
    expect(textRetention.freshUntil).not.toBeNull();
    expect(Date.parse(textRetention.freshUntil ?? '')).toBeGreaterThan(targetMs);
    expect(textRetention.displayUntil).not.toBeNull();
    expect(Date.parse(textRetention.displayUntil ?? '')).toBeGreaterThan(targetMs);
    for (const fact of Object.values(card.facts)) {
      if (fact === undefined || fact.status !== 'known') continue;
      for (const evidence of fact.evidence) {
        expect(evidence.retention.sessionExpiresAt).toBe(textRetention.sessionExpiresAt);
        expect(evidence.retention.displayUntil).toBe(textRetention.displayUntil);
      }
    }
  }
};

const runProfile = async (profile: 'compare' | 'decide-action' | 'clarify-ambiguity') => {
  const evaluationCase = caseFor(profile);
  const threadId = `model-eval-${profile}-${crypto.randomUUID()}`;
  const target = targetFor(threadId);
  const stub = contextEnv().MODEL_EVAL_CONTEXT_THREADS.getByName(threadId);
  const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
  if (!initialized.ok) throw new Error(initialized.code);
  const requests: ThreadTurnRequest[] = [];
  const responses: AssistantResponse[] = [];
  const ports: LiveCoordinatorPorts = {
    initialize: () => Promise.resolve({ ok: true }),
    runTurn: async (seed: EvaluationTurnSeed, cardContext) => {
      const isPrelude = seed.index === 0;
      await stub.configureModelEvalFixture(
        isPrelude ? 'cards' : 'message',
        isPrelude ? MODEL_EVAL_CONTEXT_NOW : MODEL_EVAL_NOW,
        profile satisfies ModelEvalFixtureProfile,
      );
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
        deviceId: 'model-eval-device',
        input: built.request,
      });
      if (result.response !== null) {
        const parsed = v.safeParse(AssistantResponseSchema, result.response);
        if (parsed.success) responses.push(parsed.output);
      }
      return {
        status: result.status,
        ...(result.code === undefined ? {} : { code: result.code }),
        response: result.response,
      };
    },
    readTrace: () => stub.getModelEvalFixtureTrace(),
    readProfile: () => Promise.resolve(null),
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
  const first = responses[0];
  if (first === undefined || first.kind !== 'cards') throw new Error('M25_CARD_PRELUDE_MISSING');
  retentionBoundaries(first);
  const mapping = resolveCandidateIdentityMapping(
    await stub.getModelEvalFixtureCandidateIdentities(),
    MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  );
  if (!mapping.ok) throw new Error(mapping.code);
  const runtimeA = mapping.pairs.find(
    (pair) => pair.evaluationCandidateId === 'candidate-a',
  )?.runtimeCandidateId;
  if (runtimeA === undefined) throw new Error('M25_CARD_CANDIDATE_MAPPING_MISSING');
  const cardContext = {
    cardSetId: first.cardSetId,
    candidateOrder: [
      first.cards.hero.candidateId,
      ...first.cards.alts.map((card) => card.candidateId),
    ],
    selectedCandidateId: profile === 'decide-action' ? runtimeA : null,
  };
  expect(requests).toHaveLength(2);
  const targetRequest = requests[1];
  if (targetRequest === undefined) throw new Error('M25_CARD_TARGET_REQUEST_MISSING');
  const targetCandidateOrder = targetRequest.candidateOrder;
  if (targetCandidateOrder === undefined) throw new Error('M25_CARD_TARGET_CARDS_MISSING');
  expect(requests[0]?.clientNow).toBe(MODEL_EVAL_CONTEXT_NOW);
  expect(requests[0]?.location.capturedAt).toBe(MODEL_EVAL_CONTEXT_NOW);
  expect(targetRequest.clientNow).toBe(MODEL_EVAL_NOW);
  expect(targetRequest.location.capturedAt).toBe(MODEL_EVAL_NOW);
  expect(targetRequest.cardSetId).toBe(cardContext.cardSetId);
  expect(targetCandidateOrder).toEqual(cardContext.candidateOrder);
  expect(mapping.byRuntimeCandidateId.get(targetCandidateOrder[0] ?? '')).toBe(
    profile === 'decide-action' ? 'candidate-b' : 'candidate-a',
  );
  expect(mapping.byRuntimeCandidateId.get(targetCandidateOrder[1] ?? '')).toBe(
    profile === 'decide-action' ? 'candidate-a' : 'candidate-b',
  );
  expect(targetRequest.selectedCandidateId).toBe(cardContext.selectedCandidateId);
  expect(targetRequest.text).toBe(evaluationCase.userTurns[0]);
  expect(targetRequest.revision).toBe(2);
  expect(targetRequest.turnId).toContain('-turn-2');

  const steps = await stub.getModelEvalFixtureSteps();
  expect(steps.filter((step) => step === 'search_places')).toHaveLength(1);
  expect(steps.filter((step) => step === 'get_place_details')).toHaveLength(
    profile === 'clarify-ambiguity' ? 1 : 2,
  );
  const details = await stub.getModelEvalFixtureDetailsRequests();
  const runtimeB = mapping.pairs.find(
    (pair) => pair.evaluationCandidateId === 'candidate-b',
  )?.runtimeCandidateId;
  if (runtimeB === undefined) throw new Error('M25_CARD_CANDIDATE_B_MAPPING_MISSING');
  expect(details.at(-1)).toEqual(
    profile === 'compare'
      ? [runtimeA, runtimeB]
      : profile === 'clarify-ambiguity'
        ? details[0]
        : [runtimeA],
  );
  const evidence = await stub.getModelEvalFixtureEvidenceSnapshots();
  const refreshedCandidates = profile === 'compare' ? [runtimeA, runtimeB] : [runtimeA];
  for (const runtimeCandidateId of refreshedCandidates) {
    const snapshots = evidence.filter((snapshot) => snapshot.candidateId === runtimeCandidateId);
    const openingIds = snapshots.flatMap((snapshot) =>
      snapshot.observations
        .filter((observation) => observation.field === 'opening_hours')
        .map((observation) => observation.observationId),
    );
    expect(new Set(openingIds).size).toBeGreaterThanOrEqual(
      profile === 'clarify-ambiguity' ? 1 : 2,
    );
  }
  const targetResponse = responses.at(-1);
  if (profile !== 'clarify-ambiguity') {
    if (targetResponse?.kind !== 'message') throw new Error('M25_CARD_TARGET_MESSAGE_MISSING');
    const targetEvidenceIds = targetResponse.message[0]?.evidenceIds ?? [];
    for (const runtimeCandidateId of refreshedCandidates) {
      const refreshedOpeningId = [...evidence]
        .reverse()
        .find(
          (snapshot) =>
            snapshot.candidateId === runtimeCandidateId &&
            snapshot.observations.some((observation) => observation.field === 'opening_hours'),
        )
        ?.observations.find((observation) => observation.field === 'opening_hours')?.observationId;
      if (refreshedOpeningId === undefined) throw new Error('M25_CARD_OPENING_REFRESH_MISSING');
      expect(targetEvidenceIds).toContain(refreshedOpeningId);
    }
  }
  expect(execution.attempt.trace?.upstreamCalls).toBe(
    profile === 'clarify-ambiguity' ? 0 : profile === 'compare' ? 2 : 1,
  );
  return { execution, requests, responses, cardContext };
};

describe('keyless formal card-context profiles through one fixture DO', () => {
  it.each(['compare', 'decide-action', 'clarify-ambiguity'] as const)(
    'keeps %s formal context while refreshing details at the fixed 21:00 target',
    async (profile) => {
      const result = await runProfile(profile);
      expect(result.requests[1]?.candidateOrder).toHaveLength(3);
      expect(result.responses[0]?.kind).toBe('cards');
      if (profile === 'decide-action') {
        expect(result.cardContext.selectedCandidateId).toMatch(/^runtime-/u);
      } else {
        expect(result.cardContext.selectedCandidateId).toBeNull();
      }
      if (profile === 'clarify-ambiguity') {
        expect(result.execution.attempt.status).toBe('evaluated');
        expect(result.execution.attempt.trace?.toolNames).not.toContain('search_places');
      } else {
        expect(result.execution.failure).toBeUndefined();
        expect(result.execution.attempt.status).toBe('evaluated');
        expect(result.execution.attempt.publicResponse?.kind).toBe('message');
        expect(
          result.execution.run?.response.selections.map((selection) => selection.candidateId),
        ).toEqual(profile === 'compare' ? ['candidate-a', 'candidate-b'] : ['candidate-a']);
      }
      expect(result.execution.attempt.trace?.toolNames).not.toContain('search_places');
    },
  );
});
