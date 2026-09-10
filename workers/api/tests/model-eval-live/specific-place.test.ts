import { env } from 'cloudflare:test';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  AssistantResponseSchema,
  type AssistantResponse,
  type ThreadTurnRequest,
} from '@ima/contracts';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import { executionProfileFor } from '../../tooling/model-eval/execution-profile';
import { liveEvaluationProfileFor } from '../../tooling/model-eval/live-plan';
import {
  buildEvaluationTurnRequest,
  cardContextFromResponse,
  type EvaluationCardContext,
} from '../../tooling/model-eval/scenario-input';
import { resolveCandidateIdentityMapping } from '../../tooling/model-eval/candidate-mapping';
import { createEvaluationTurnSeed } from '../../tooling/model-eval/turn-plan';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import {
  MODEL_EVAL_CONTEXT_NOW,
  MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  MODEL_EVAL_NOW,
  type ModelEvalPlaceDisplayNameMode,
} from './model-eval-place-fixture';
import type {
  ModelEvalFixtureDisplayNamePolicy,
  ModelEvalFixtureThreadDO,
} from './model-eval-context-worker';

type SpecificPlaceTestEnv = Cloudflare.Env & {
  readonly MODEL_EVAL_CONTEXT_THREADS: DurableObjectNamespace<ModelEvalFixtureThreadDO>;
};

const fixtureEnv = (): SpecificPlaceTestEnv => {
  if (!('MODEL_EVAL_CONTEXT_THREADS' in env)) throw new Error('MODEL_EVAL_CONTEXT_BINDING_MISSING');
  return env as SpecificPlaceTestEnv;
};

const evaluationCaseFor = (caseId: string): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((item) => item.id === 'specific-place');
  if (scenario === undefined) throw new Error('specific-place scenario missing');
  return { ...scenario, caseId, repeat: 1 };
};

const runTurn = async (input: {
  readonly stub: DurableObjectStub<ModelEvalFixtureThreadDO>;
  readonly evaluationCase: EvaluationCase;
  readonly target: {
    readonly ownerScopeRef: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly revision: number;
  };
  readonly cardContext?: EvaluationCardContext;
}): Promise<{
  readonly request: ThreadTurnRequest;
  readonly response: AssistantResponse;
}> => {
  const seed = createEvaluationTurnSeed({
    caseId: input.evaluationCase.caseId,
    userTurns: input.evaluationCase.userTurns,
    target: input.target,
  });
  if (!seed.ok) throw new Error(seed.code);
  const built = buildEvaluationTurnRequest({
    evaluationCase: input.evaluationCase,
    seed: seed.seed,
    ...(input.cardContext === undefined ? {} : { cardContext: input.cardContext }),
  });
  if (!built.ok) throw new Error(built.code);
  const result = await input.stub.runRuntimeTurn({
    ...input.target,
    idempotencyKey: built.request.idempotencyKey,
    deviceId: 'model-eval-specific-place-device',
    input: built.request,
  });
  if (result.status !== 'completed') throw new Error(result.code ?? 'FIXTURE_RUNTIME_FAILED');
  const parsed = v.safeParse(AssistantResponseSchema, result.response);
  if (!parsed.success) throw new Error('FIXTURE_PUBLIC_RESPONSE_INVALID');
  return { request: built.request, response: parsed.output };
};

const prepareCards = async (input: {
  readonly mode: ModelEvalPlaceDisplayNameMode;
  readonly displayNamePolicy: ModelEvalFixtureDisplayNamePolicy;
}) => {
  const threadId = `model-eval-specific-place-${crypto.randomUUID()}`;
  const target = {
    ownerScopeRef: 'model-eval-specific-place-owner',
    threadId,
    turnId: `${threadId}-turn-1`,
    revision: 1,
  } as const;
  const stub = fixtureEnv().MODEL_EVAL_CONTEXT_THREADS.getByName(threadId);
  const preludeBase = evaluationCaseFor(`specific-place:prelude:${input.mode}`);
  await stub.configureModelEvalFixture(
    'cards',
    MODEL_EVAL_CONTEXT_NOW,
    'specific-place',
    'clarify',
    'normal',
    { placeDisplayNameMode: input.mode, displayNamePolicy: input.displayNamePolicy },
  );
  const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
  if (!initialized.ok) throw new Error(initialized.code);
  const prelude = {
    ...preludeBase,
    userTurns: ['候補を準備して。'],
    context: {
      ...preludeBase.context,
      now: MODEL_EVAL_CONTEXT_NOW,
    },
  };
  const first = await runTurn({ stub, evaluationCase: prelude, target });
  if (first.response.kind !== 'cards') throw new Error('M25_SPECIFIC_PLACE_CARDS_MISSING');
  const contextResult = cardContextFromResponse(first.response);
  if (!contextResult.ok) throw new Error(contextResult.code);
  const mapping = resolveCandidateIdentityMapping(
    await stub.getModelEvalFixtureCandidateIdentities(),
    MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  );
  if (!mapping.ok) throw new Error(mapping.code);
  return {
    stub,
    target,
    first: first.response,
    preludeRequest: first.request,
    cardContext: contextResult.context,
    mapping,
  };
};

describe('specific-place formal card resolution through one fixture DO', () => {
  it('refreshes only the uniquely named candidate from the second card at 21:00', async () => {
    const prepared = await prepareCards({ mode: 'normal', displayNamePolicy: 'visible' });
    const runtimeA = prepared.mapping.pairs.find(
      (pair) => pair.evaluationCandidateId === 'candidate-a',
    )?.runtimeCandidateId;
    const runtimeB = prepared.mapping.pairs.find(
      (pair) => pair.evaluationCandidateId === 'candidate-b',
    )?.runtimeCandidateId;
    if (runtimeA === undefined || runtimeB === undefined)
      throw new Error('M25_SPECIFIC_PLACE_MAPPING_MISSING');
    expect(prepared.cardContext.candidateOrder[0]).toBe(runtimeB);
    expect(prepared.cardContext.candidateOrder[1]).toBe(runtimeA);
    expect(prepared.preludeRequest.clientNow).toBe(MODEL_EVAL_CONTEXT_NOW);
    expect(prepared.preludeRequest.location.capturedAt).toBe(MODEL_EVAL_CONTEXT_NOW);
    const before = await prepared.stub.getModelEvalFixtureTrace();
    const detailsBefore = await prepared.stub.getModelEvalFixtureDetailsRequests();
    const searchStepsBefore = (await prepared.stub.getModelEvalFixtureSteps()).filter(
      (step) => step === 'search_places',
    );
    await prepared.stub.configureModelEvalFixture(
      'message',
      MODEL_EVAL_NOW,
      'specific-place',
      'clarify',
      'normal',
      { placeDisplayNameMode: 'normal', displayNamePolicy: 'visible' },
    );
    const target = {
      ...prepared.target,
      turnId: `${prepared.target.threadId}-turn-2`,
      revision: prepared.first.revision,
    };
    const targetTurn = await runTurn({
      stub: prepared.stub,
      evaluationCase: evaluationCaseFor('specific-place:target:normal'),
      target,
      cardContext: prepared.cardContext,
    });
    expect(targetTurn.request.clientNow).toBe(MODEL_EVAL_NOW);
    expect(targetTurn.request.location.capturedAt).toBe(MODEL_EVAL_NOW);
    expect(targetTurn.request.cardSetId).toBe(prepared.cardContext.cardSetId);
    expect(targetTurn.response.kind).toBe('message');
    if (targetTurn.response.kind !== 'message') return;
    expect(targetTurn.response.message[0]?.text).toBe('営業時間を確認しました。');
    const detailsAfter = await prepared.stub.getModelEvalFixtureDetailsRequests();
    expect(detailsAfter).toHaveLength(detailsBefore.length + 1);
    expect(detailsAfter.at(-1)).toEqual([runtimeA]);
    const stepsAfter = await prepared.stub.getModelEvalFixtureSteps();
    expect(stepsAfter.filter((step) => step === 'search_places')).toHaveLength(
      searchStepsBefore.length,
    );
    const after = await prepared.stub.getModelEvalFixtureTrace();
    expect(after.upstreamCalls).toBe(before.upstreamCalls + 1);
    expect(after.modelCalls).toBe(before.modelCalls + 2);
    const evidence = await prepared.stub.getModelEvalFixtureEvidenceSnapshots();
    const aOpeningIds = evidence
      .filter((snapshot) => snapshot.candidateId === runtimeA)
      .flatMap((snapshot) =>
        snapshot.observations
          .filter((observation) => observation.field === 'opening_hours')
          .map((observation) => observation.observationId),
      );
    expect(new Set(aOpeningIds).size).toBeGreaterThanOrEqual(2);
    const refreshedOpeningId = aOpeningIds.at(-1);
    if (refreshedOpeningId === undefined) throw new Error('M25_SPECIFIC_PLACE_OPENING_MISSING');
    expect(targetTurn.response.message[0]?.evidenceIds).toContain(refreshedOpeningId);
    const evidenceRef = targetTurn.response.message[0]?.evidence.find(
      (item) => item.evidenceId === refreshedOpeningId,
    );
    expect(evidenceRef).toBeDefined();
    expect(Date.parse(evidenceRef?.retention.freshUntil ?? '')).toBeGreaterThan(
      Date.parse(MODEL_EVAL_NOW),
    );
  });

  it.each([
    ['duplicate', 'visible'],
    ['normal', 'withheld'],
  ] as const)('clarifies when the card name is %s', async (mode, displayNamePolicy) => {
    const prepared = await prepareCards({ mode, displayNamePolicy });
    const before = await prepared.stub.getModelEvalFixtureTrace();
    const detailsBefore = await prepared.stub.getModelEvalFixtureDetailsRequests();
    await prepared.stub.configureModelEvalFixture(
      'message',
      MODEL_EVAL_NOW,
      'specific-place',
      'clarify',
      'normal',
      { placeDisplayNameMode: mode, displayNamePolicy },
    );
    const target = {
      ...prepared.target,
      turnId: `${prepared.target.threadId}-turn-2`,
      revision: prepared.first.revision,
    };
    const targetTurn = await runTurn({
      stub: prepared.stub,
      evaluationCase: evaluationCaseFor(`specific-place:target:${mode}`),
      target,
      cardContext: prepared.cardContext,
    });
    expect(targetTurn.response.kind).toBe('message');
    if (targetTurn.response.kind !== 'message') return;
    expect(targetTurn.response.message[0]?.text).toContain('特定できない');
    expect(targetTurn.response.message[0]?.basis).toBe('conversational');
    expect(targetTurn.response.message[0]?.evidenceIds).toEqual([]);
    expect(await prepared.stub.getModelEvalFixtureDetailsRequests()).toEqual(detailsBefore);
    expect((await prepared.stub.getModelEvalFixtureTrace()).upstreamCalls).toBe(
      before.upstreamCalls,
    );
  });

  it('clarifies when the user text matches two visible card names', async () => {
    const prepared = await prepareCards({ mode: 'normal', displayNamePolicy: 'visible' });
    const before = await prepared.stub.getModelEvalFixtureTrace();
    const detailsBefore = await prepared.stub.getModelEvalFixtureDetailsRequests();
    await prepared.stub.configureModelEvalFixture(
      'message',
      MODEL_EVAL_NOW,
      'specific-place',
      'clarify',
      'normal',
      { placeDisplayNameMode: 'normal', displayNamePolicy: 'visible' },
    );
    const target = {
      ...prepared.target,
      turnId: `${prepared.target.threadId}-turn-2`,
      revision: prepared.first.revision,
    };
    const evaluationCase = {
      ...evaluationCaseFor('specific-place:target:multiple'),
      userTurns: ['青葉カフェと川辺食堂は何時まで？'],
    };
    const targetTurn = await runTurn({
      stub: prepared.stub,
      evaluationCase,
      target,
      cardContext: prepared.cardContext,
    });
    expect(targetTurn.response.kind).toBe('message');
    if (targetTurn.response.kind !== 'message') return;
    expect(targetTurn.response.message[0]?.text).toContain('特定できない');
    expect(targetTurn.response.message[0]?.evidenceIds).toEqual([]);
    expect(await prepared.stub.getModelEvalFixtureDetailsRequests()).toEqual(detailsBefore);
    expect((await prepared.stub.getModelEvalFixtureTrace()).upstreamCalls).toBe(
      before.upstreamCalls,
    );
  });

  it('marks specific-place as keyless fixture-ready while live remains opt-in only', () => {
    const evaluationCase = evaluationCaseFor('specific-place:profile');
    expect(executionProfileFor(evaluationCase)).toEqual({
      status: 'fixture_ready',
      kind: 'card_context',
      requiresApiKey: false,
    });
    expect(liveEvaluationProfileFor(evaluationCase)).toBeNull();
  });
});
