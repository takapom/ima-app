import { env } from 'cloudflare:test';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { AssistantResponseSchema } from '@ima/contracts';
import type { AssistantResponse } from '@ima/contracts';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import {
  buildEvaluationTurnRequest,
  cardContextFromResponse,
} from '../../tooling/model-eval/scenario-input';
import { resolveCandidateIdentityMapping } from '../../tooling/model-eval/candidate-mapping';
import {
  advanceEvaluationTurn,
  createEvaluationTurnSeed,
  type EvaluationTurnSeed,
} from '../../tooling/model-eval/turn-plan';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import type { ThreadRuntimeTurnResult } from '@worker/infrastructure/runtime/threads/admission';
import {
  MODEL_EVAL_CONTEXT_NOW,
  MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
} from './model-eval-place-fixture';
import type {
  ModelEvalFixtureLocationProbe,
  ModelEvalFixturePhase,
  ModelEvalFixtureProfile,
  ModelEvalFixtureThreadDO,
} from './model-eval-context-worker';

type ContextTestEnv = Cloudflare.Env & {
  readonly MODEL_EVAL_CONTEXT_THREADS: DurableObjectNamespace<ModelEvalFixtureThreadDO>;
};

const contextEnv = (): ContextTestEnv => {
  if (!('MODEL_EVAL_CONTEXT_THREADS' in env)) throw new Error('MODEL_EVAL_CONTEXT_BINDING_MISSING');
  return env as ContextTestEnv;
};

const scenarioFor = (id: EvaluationCase['id']): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((item) => item.id === id);
  if (scenario === undefined) throw new Error(`scenario missing: ${id}`);
  return {
    ...scenario,
    caseId: `${id}:fixture`,
    repeat: 1,
    context: { ...scenario.context, now: MODEL_EVAL_CONTEXT_NOW },
  };
};

const seedFor = (
  evaluationCase: EvaluationCase,
  target: EvaluationTurnSeed['target'],
): EvaluationTurnSeed => {
  const result = createEvaluationTurnSeed({
    caseId: evaluationCase.caseId,
    userTurns: evaluationCase.userTurns,
    target,
  });
  if (!result.ok) throw new Error(result.code);
  return result.seed;
};

const runSeedResult = async (
  stub: DurableObjectStub<ModelEvalFixtureThreadDO>,
  evaluationCase: EvaluationCase,
  seed: EvaluationTurnSeed,
  cardContext?: Parameters<typeof buildEvaluationTurnRequest>[0]['cardContext'],
): Promise<ThreadRuntimeTurnResult> => {
  const built = buildEvaluationTurnRequest({
    evaluationCase,
    seed,
    ...(cardContext === undefined ? {} : { cardContext }),
  });
  if (!built.ok) throw new Error(built.code);
  return stub.runRuntimeTurn({
    ...seed.target,
    idempotencyKey: built.request.idempotencyKey,
    deviceId: 'model-eval-device',
    input: built.request,
  });
};

const runSeed = async (
  stub: DurableObjectStub<ModelEvalFixtureThreadDO>,
  evaluationCase: EvaluationCase,
  seed: EvaluationTurnSeed,
  cardContext?: Parameters<typeof buildEvaluationTurnRequest>[0]['cardContext'],
): Promise<AssistantResponse> => {
  const result = await runSeedResult(stub, evaluationCase, seed, cardContext);
  if (result.status !== 'completed') {
    throw new Error(
      JSON.stringify({
        result,
        code: result.code ?? 'FIXTURE_RUNTIME_FAILED',
      }),
    );
  }
  const parsed = v.safeParse(AssistantResponseSchema, result.response);
  if (!parsed.success) throw new Error('FIXTURE_PUBLIC_RESPONSE_INVALID');
  return parsed.output;
};

const initializeStub = async (name: string) => {
  const target = {
    ownerScopeRef: 'model-eval-context-owner',
    threadId: name,
    turnId: `${name}-turn-1`,
    revision: 1,
  } as const;
  const stub = contextEnv().MODEL_EVAL_CONTEXT_THREADS.getByName(name);
  const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
  if (!initialized.ok) throw new Error(initialized.code);
  return { stub, target };
};

const configure = async (
  stub: DurableObjectStub<ModelEvalFixtureThreadDO>,
  phase: ModelEvalFixturePhase,
  profile: ModelEvalFixtureProfile = 'reason',
  locationProbe: ModelEvalFixtureLocationProbe = 'clarify',
): Promise<void> => {
  await stub.configureModelEvalFixture(phase, MODEL_EVAL_CONTEXT_NOW, profile, locationProbe);
};

describe('model-eval formal context through one Think Durable Object', () => {
  it('seeds reason from a committed card set, then sends only formal card context', async () => {
    const evaluationCase = scenarioFor('reason');
    const name = `model-eval-reason-${crypto.randomUUID()}`;
    const { stub, target } = await initializeStub(name);
    await configure(stub, 'cards');

    const prelude: EvaluationCase = {
      ...evaluationCase,
      caseId: 'reason:card-prelude',
      userTurns: ['候補を準備して。'],
    };
    const first = seedFor(prelude, target);
    const cards = await runSeed(stub, prelude, first);
    expect(cards.kind).toBe('cards');
    if (cards.kind !== 'cards') return;
    expect(cards.cards.alts.length).toBeGreaterThanOrEqual(1);
    expect(cards.cards.hero.facts.opening_hours?.status).toBe('known');
    expect(cards.cards.alts[0]?.facts.opening_hours?.status).toBe('known');
    const contextResult = cardContextFromResponse(cards);
    expect(contextResult.ok).toBe(true);
    if (!contextResult.ok) return;

    const before = await stub.getModelEvalFixtureTrace();
    const stepsBefore = await stub.getModelEvalFixtureSteps();
    const detailsBefore = await stub.getModelEvalFixtureDetailsRequests();
    await configure(stub, 'message');
    const messageTarget = {
      ...target,
      turnId: `${name}-reason-turn-2`,
      revision: cards.revision,
    };
    const messageSeed = seedFor(evaluationCase, messageTarget);
    const message = await runSeed(stub, evaluationCase, messageSeed, contextResult.context);
    expect(message.kind).toBe('message');
    expect(message.threadId).toBe(target.threadId);
    expect(message.revision).toBe(cards.revision + 1);
    if (message.kind !== 'message') return;
    expect(message.message[0]?.evidenceIds.length).toBeGreaterThan(0);
    const after = await stub.getModelEvalFixtureTrace();
    const stepsAfter = await stub.getModelEvalFixtureSteps();
    expect(after.upstreamCalls).toBe(before.upstreamCalls + 1);
    expect(stepsAfter.filter((step) => step === 'search_places')).toHaveLength(
      stepsBefore.filter((step) => step === 'search_places').length,
    );
    expect(stepsAfter.filter((step) => step === 'get_place_details')).toHaveLength(
      stepsBefore.filter((step) => step === 'get_place_details').length + 1,
    );
    const detailsAfter = await stub.getModelEvalFixtureDetailsRequests();
    expect(detailsAfter).toHaveLength(detailsBefore.length + 1);
    expect(detailsAfter.at(-1)).toEqual([cards.cards.hero.candidateId]);
  });

  it('advances continuity on the same DO from the validated response revision', async () => {
    const evaluationCase = scenarioFor('continuity');
    const name = `model-eval-continuity-${crypto.randomUUID()}`;
    const { stub, target } = await initializeStub(name);
    await configure(stub, 'cards');

    const firstSeed = seedFor(evaluationCase, target);
    const first = await runSeed(stub, evaluationCase, firstSeed);
    expect(first.kind).toBe('cards');
    if (first.kind !== 'cards') return;
    expect(first.cards.alts.length).toBeGreaterThanOrEqual(1);
    const secondCard = first.cards.alts[0];
    expect(secondCard?.facts.opening_hours?.status).toBe('known');
    if (secondCard === undefined) return;
    const contextResult = cardContextFromResponse(first);
    expect(contextResult.ok).toBe(true);
    if (!contextResult.ok) return;

    const secondSeedResult = advanceEvaluationTurn(
      firstSeed,
      first,
      evaluationCase.userTurns[1] ?? '',
    );
    expect(secondSeedResult.ok).toBe(true);
    if (!secondSeedResult.ok) return;
    const before = await stub.getModelEvalFixtureTrace();
    const stepsBefore = await stub.getModelEvalFixtureSteps();
    const detailsBefore = await stub.getModelEvalFixtureDetailsRequests();
    const evidenceBefore = await stub.getModelEvalFixtureEvidenceSnapshots();
    await configure(stub, 'message');
    const second = await runSeed(
      stub,
      evaluationCase,
      secondSeedResult.seed,
      contextResult.context,
    );

    expect(second.kind).toBe('message');
    expect(second.threadId).toBe(first.threadId);
    expect(second.turnId).toBe(secondSeedResult.seed.target.turnId);
    expect(second.revision).toBe(first.revision + 1);
    if (second.kind !== 'message') return;
    expect(second.message[0]?.text).toContain(secondCard.candidateId);
    expect(second.message[0]?.evidenceIds).toHaveLength(3);
    const after = await stub.getModelEvalFixtureTrace();
    const stepsAfter = await stub.getModelEvalFixtureSteps();
    expect(after.upstreamCalls).toBe(before.upstreamCalls + 1);
    expect(stepsAfter.filter((step) => step === 'search_places')).toHaveLength(
      stepsBefore.filter((step) => step === 'search_places').length,
    );
    expect(stepsAfter.filter((step) => step === 'get_place_details')).toHaveLength(
      stepsBefore.filter((step) => step === 'get_place_details').length + 1,
    );
    const detailsAfter = await stub.getModelEvalFixtureDetailsRequests();
    expect(detailsAfter).toHaveLength(detailsBefore.length + 1);
    expect(detailsAfter.at(-1)).toEqual([secondCard.candidateId]);

    const mapping = resolveCandidateIdentityMapping(
      await stub.getModelEvalFixtureCandidateIdentities(),
      MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
    );
    expect(mapping.ok).toBe(true);
    if (!mapping.ok) return;
    expect(mapping.byRuntimeCandidateId.get(secondCard.candidateId)).toBe('candidate-b');

    const evidenceAfter = await stub.getModelEvalFixtureEvidenceSnapshots();
    expect(evidenceAfter.length).toBeGreaterThan(evidenceBefore.length);
    const previousSnapshot = [...evidenceBefore]
      .reverse()
      .find((snapshot) => snapshot.candidateId === secondCard.candidateId);
    const refreshedSnapshot = [...evidenceAfter]
      .reverse()
      .find((snapshot) => snapshot.candidateId === secondCard.candidateId);
    expect(refreshedSnapshot?.candidateId).toBe(secondCard.candidateId);
    const previousOpening = previousSnapshot?.observations.find(
      (observation) =>
        observation.candidateId === secondCard.candidateId && observation.field === 'opening_hours',
    );
    const refreshedOpening = refreshedSnapshot?.observations.find(
      (observation) =>
        observation.candidateId === secondCard.candidateId && observation.field === 'opening_hours',
    );
    if (previousOpening === undefined || refreshedOpening === undefined) {
      throw new Error('M25_FIXTURE_OPENING_HOURS_EVIDENCE_MISSING');
    }
    expect(refreshedOpening.observationId).not.toBe(previousOpening.observationId);
    expect(refreshedSnapshot?.evidenceIds).toContain(refreshedOpening.observationId);
    expect(second.message[0]?.evidenceIds).toContain(refreshedOpening.observationId);
  });

  it('rejects a follow-up whose card set is absent from the committed response', async () => {
    const evaluationCase = scenarioFor('continuity');
    const name = `model-eval-card-set-${crypto.randomUUID()}`;
    const { stub, target } = await initializeStub(name);
    await configure(stub, 'cards');
    const firstSeed = seedFor(evaluationCase, target);
    const first = await runSeed(stub, evaluationCase, firstSeed);
    expect(first.kind).toBe('cards');
    if (first.kind !== 'cards') return;
    const contextResult = cardContextFromResponse(first);
    expect(contextResult.ok).toBe(true);
    if (!contextResult.ok) return;
    const before = await stub.getModelEvalFixtureTrace();
    await configure(stub, 'message');
    const followUpSeedResult = advanceEvaluationTurn(
      firstSeed,
      first,
      evaluationCase.userTurns[1] ?? '',
    );
    expect(followUpSeedResult.ok).toBe(true);
    if (!followUpSeedResult.ok) return;
    const result = await runSeedResult(stub, evaluationCase, followUpSeedResult.seed, {
      ...contextResult.context,
      cardSetId: 'model-eval-unknown-card-set',
    });
    expect(result.status).toBe('failed');
    expect(result.code).toBe('REVISION_CONFLICT');
    expect(result.response).toBeNull();
    const after = await stub.getModelEvalFixtureTrace();
    expect(after.modelCalls).toBe(before.modelCalls);
    expect(after.upstreamCalls).toBe(before.upstreamCalls);
  });

  it('clarifies without a search when an available location is refused for model input', async () => {
    const base = scenarioFor('gps-refusal');
    const evaluationCase: EvaluationCase = {
      ...base,
      context: { ...base.context, locationStatus: 'available', areaText: null },
    };
    const name = `model-eval-gps-refusal-${crypto.randomUUID()}`;
    const { stub, target } = await initializeStub(name);
    await configure(stub, 'message', 'gps-refusal');
    const result = await runSeed(stub, evaluationCase, seedFor(evaluationCase, target));
    expect(result.kind).toBe('message');
    if (result.kind !== 'message') return;
    expect(result.message[0]?.text).toContain('地域');
    expect(await stub.getModelEvalFixtureSteps()).toEqual(['final_message']);
    const trace = await stub.getModelEvalFixtureTrace();
    expect(trace.modelCalls).toBe(1);
    expect(trace.upstreamCalls).toBe(0);
    expect(trace.modelLocationExposed).toBe(false);
    expect(await stub.getModelEvalFixtureToolErrorCodes()).toEqual([]);
    expect(await stub.getModelEvalFixtureModelLocationExposed()).toBe(false);
    expect(await stub.getModelEvalFixtureModelLocations()).toEqual([
      { status: 'denied', areaDescription: null },
    ]);
  });

  it('keeps current-location refusal as LOCATION_REQUIRED before asking for an area', async () => {
    const evaluationCase = scenarioFor('gps-refusal');
    const name = `model-eval-gps-required-${crypto.randomUUID()}`;
    const { stub, target } = await initializeStub(name);
    await configure(stub, 'message', 'gps-refusal', 'current-location');
    const result = await runSeed(stub, evaluationCase, seedFor(evaluationCase, target));
    expect(result.kind).toBe('message');
    if (result.kind !== 'message') return;
    expect(result.message[0]?.text).toContain('地域');
    expect(await stub.getModelEvalFixtureSteps()).toEqual(['search_places', 'final_message']);
    expect(await stub.getModelEvalFixtureToolErrorCodes()).toEqual(['LOCATION_REQUIRED']);
    const trace = await stub.getModelEvalFixtureTrace();
    expect(trace.modelCalls).toBe(2);
    expect(trace.upstreamCalls).toBe(0);
    expect(trace.modelLocationExposed).toBe(false);
    expect(await stub.getModelEvalFixtureModelLocationExposed()).toBe(false);
    expect(await stub.getModelEvalFixtureModelLocations()).toEqual([
      { status: 'denied', areaDescription: null },
      { status: 'denied', areaDescription: null },
    ]);
  });
});
