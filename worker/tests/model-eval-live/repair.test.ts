import { env } from 'cloudflare:test';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  AssistantResponseSchema,
  type AssistantResponse,
  type ThreadTurnRequest,
} from '@ima/contracts';
import {
  projectModelEvidenceForLlmInput,
  type ModelEvidenceSource,
} from '@worker/application/model-context/model-evidence';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import { executionProfileFor } from '../../tooling/model-eval/execution-profile';
import { liveEvaluationProfileFor } from '../../tooling/model-eval/live-plan';
import {
  buildEvaluationTurnRequest,
  cardContextFromResponse,
  type EvaluationCardContext,
} from '../../tooling/model-eval/scenario-input';
import { createEvaluationTurnSeed } from '../../tooling/model-eval/turn-plan';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import {
  MODEL_EVAL_REPAIR_PRELUDE_NOW,
  MODEL_EVAL_REPAIR_TARGET_NOW,
  MODEL_EVAL_REPAIR_REFRESH_FRESH_UNTIL,
  repairObservationPolicyFor,
  repairTargetFor,
} from './model-eval-repair';
import type { ModelEvalFixtureThreadDO } from './model-eval-context-worker';

type RepairTestEnv = Cloudflare.Env & {
  readonly MODEL_EVAL_CONTEXT_THREADS: DurableObjectNamespace<ModelEvalFixtureThreadDO>;
};

const fixtureEnv = (): RepairTestEnv => {
  if (!('MODEL_EVAL_CONTEXT_THREADS' in env)) throw new Error('M25_REPAIR_BINDING_MISSING');
  return env as RepairTestEnv;
};

const repairCaseFor = (caseId: string): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((item) => item.id === 'repair');
  if (scenario === undefined) throw new Error('repair scenario missing');
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
}): Promise<{ readonly request: ThreadTurnRequest; readonly response: AssistantResponse }> => {
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
    deviceId: 'model-eval-repair-device',
    input: built.request,
  });
  if (result.status !== 'completed') throw new Error(result.code ?? 'M25_REPAIR_RUNTIME_FAILED');
  const parsed = v.safeParse(AssistantResponseSchema, result.response);
  if (!parsed.success) throw new Error('M25_REPAIR_PUBLIC_RESPONSE_INVALID');
  return { request: built.request, response: parsed.output };
};

const prepareCards = async () => {
  const threadId = `model-eval-repair-${crypto.randomUUID()}`;
  const target = {
    ownerScopeRef: 'model-eval-repair-owner',
    threadId,
    turnId: `${threadId}-turn-1`,
    revision: 1,
  } as const;
  const stub = fixtureEnv().MODEL_EVAL_CONTEXT_THREADS.getByName(threadId);
  const base = repairCaseFor(`repair:prelude:${threadId}`);
  await stub.configureModelEvalFixture(
    'cards',
    MODEL_EVAL_REPAIR_PRELUDE_NOW,
    'repair',
    'clarify',
    'normal',
  );
  const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
  if (!initialized.ok) throw new Error(initialized.code);
  const prelude = await runTurn({
    stub,
    target,
    evaluationCase: {
      ...base,
      userTurns: ['候補を準備して。'],
      context: { ...base.context, now: MODEL_EVAL_REPAIR_PRELUDE_NOW },
    },
  });
  if (prelude.response.kind !== 'cards') throw new Error('M25_REPAIR_CARDS_MISSING');
  const context = cardContextFromResponse(prelude.response);
  if (!context.ok) throw new Error(context.code);
  const hero = prelude.response.cards.hero.facts.opening_hours;
  if (hero?.status !== 'known') throw new Error('M25_REPAIR_OLD_OPENING_MISSING');
  const oldEvidenceId = hero.evidence[0]?.evidenceId;
  if (oldEvidenceId === undefined) throw new Error('M25_REPAIR_OLD_EVIDENCE_MISSING');
  return {
    stub,
    target,
    prelude,
    cardContext: context.context,
    oldEvidenceId,
  };
};

const formalRepairPrompt = (status: 'known' | 'stale') => [
  {
    role: 'user' as const,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          kind: 'ima_turn_context',
          context: {
            cardSet: {
              entries: [{ candidateId: 'runtime-a' }],
              candidates: [{ candidateId: 'runtime-a', displayName: '候補A' }],
            },
            evidence: [
              {
                candidateId: 'runtime-a',
                field: 'opening_hours',
                observationId: `opening-${status}`,
                status,
              },
            ],
          },
        }),
      },
    ],
  },
];

const oldOpeningSource = (): ModelEvidenceSource => ({
  ownerScopeRef: 'repair-owner',
  threadId: 'repair-thread',
  observationId: 'opening-old',
  candidateId: 'candidate-a',
  field: 'opening_hours',
  value: {
    timeZone: 'Asia/Tokyo',
    intervals: [
      {
        startAt: '2026-09-10T00:00:00.000Z',
        endAt: '2026-09-10T13:00:00.000Z',
      },
    ],
    weeklyText: ['毎日 9:00–22:00'],
    evaluatedAt: MODEL_EVAL_REPAIR_PRELUDE_NOW,
    listedOpenAtEvaluation: true,
    nextBoundaryAt: '2026-09-10T13:00:00.000Z',
    lastOrderAt: null,
    lastOrderRaw: null,
  },
  fetchedAt: MODEL_EVAL_REPAIR_PRELUDE_NOW,
  freshUntil: MODEL_EVAL_REPAIR_TARGET_NOW,
  expiresAt: '2026-09-10T16:00:00.000Z',
  sources: [{ provider: 'fixture', recordRef: 'eval-place-a', attribution: null, publicUrl: null }],
  retention: repairObservationPolicyFor('cards').retention,
});

describe('repair profile freshness and formal projection', () => {
  it('keeps the 21:00 freshness boundary separate from policy windows', () => {
    const preludePolicy = repairObservationPolicyFor('cards');
    const refreshPolicy = repairObservationPolicyFor('message');
    expect(preludePolicy.freshUntil).toBe(MODEL_EVAL_REPAIR_TARGET_NOW);
    expect(refreshPolicy.freshUntil).toBe(MODEL_EVAL_REPAIR_REFRESH_FRESH_UNTIL);
    expect(preludePolicy.retention.freshUntil).toBe('2026-09-10T18:00:00.000Z');
    expect(preludePolicy.retention.displayUntil).toBe('2026-09-10T20:00:00.000Z');
    expect(preludePolicy.retention.sessionExpiresAt).toBe('2026-09-10T23:00:00.000Z');
  });

  it('projects the old observation as stale exactly at the target time', () => {
    const projected = projectModelEvidenceForLlmInput(
      oldOpeningSource(),
      MODEL_EVAL_REPAIR_TARGET_NOW,
    );
    expect(projected).toMatchObject({
      status: 'stale',
      observationId: 'opening-old',
      candidateId: 'candidate-a',
      field: 'opening_hours',
      freshUntil: MODEL_EVAL_REPAIR_TARGET_NOW,
    });
  });

  it('selects only a formal card target and refuses a missing stale observation', () => {
    expect(repairTargetFor(formalRepairPrompt('stale'))).toEqual({
      ok: true,
      candidateId: 'runtime-a',
      staleEvidenceIds: ['opening-stale'],
    });
    expect(repairTargetFor(formalRepairPrompt('known'))).toEqual({
      ok: false,
      code: 'REPAIR_STALE_EVIDENCE_MISSING',
    });
  });
});

describe('repair profile through one fixture DO', () => {
  it('refreshes only the formal hero and publishes the new evidence', async () => {
    const prepared = await prepareCards();
    const targetCase = repairCaseFor(`repair:target:${prepared.target.threadId}`);
    const beforeTrace = await prepared.stub.getModelEvalFixtureTrace();
    const beforeDetails = await prepared.stub.getModelEvalFixtureDetailsRequests();
    await prepared.stub.configureModelEvalFixture(
      'message',
      MODEL_EVAL_REPAIR_TARGET_NOW,
      'repair',
      'clarify',
      'normal',
    );
    const target = await runTurn({
      stub: prepared.stub,
      target: {
        ...prepared.target,
        turnId: `${prepared.target.threadId}-turn-2`,
        revision: prepared.prelude.response.revision,
      },
      evaluationCase: targetCase,
      cardContext: prepared.cardContext,
    });
    expect(target.response.kind).toBe('message');
    if (target.response.kind !== 'message') return;
    expect(target.response.message[0]?.text).toBe('営業時間の根拠を更新しました。');
    expect(target.response.message[0]?.evidenceIds).not.toContain(prepared.oldEvidenceId);
    expect(target.response.message[0]?.evidenceIds.length).toBeGreaterThan(0);
    expect(await prepared.stub.getModelEvalFixtureSearchQueries()).toEqual([]);
    const details = await prepared.stub.getModelEvalFixtureDetailsRequests();
    expect(details).toHaveLength(beforeDetails.length + 1);
    expect(details.at(-1)).toEqual([prepared.cardContext.candidateOrder[0]]);
    const afterTrace = await prepared.stub.getModelEvalFixtureTrace();
    expect(afterTrace.upstreamCalls).toBe(beforeTrace.upstreamCalls + 1);
    const snapshots = await prepared.stub.getModelEvalFixtureEvidenceSnapshots();
    const refreshed = snapshots
      .filter((snapshot) => snapshot.candidateId === prepared.cardContext.candidateOrder[0])
      .flatMap((snapshot) => snapshot.evidenceIds)
      .filter((id) => id !== prepared.oldEvidenceId);
    const responseEvidenceId = target.response.message[0]?.evidenceIds[0];
    expect(responseEvidenceId).toBeDefined();
    expect(refreshed).toContain(responseEvidenceId);
  });

  it('does not revive old evidence when the provider refresh fails', async () => {
    const prepared = await prepareCards();
    const beforeTrace = await prepared.stub.getModelEvalFixtureTrace();
    const beforeDetails = await prepared.stub.getModelEvalFixtureDetailsRequests();
    await prepared.stub.configureModelEvalFixture(
      'message',
      MODEL_EVAL_REPAIR_TARGET_NOW,
      'repair',
      'clarify',
      'upstream-failure',
    );
    const target = await runTurn({
      stub: prepared.stub,
      target: {
        ...prepared.target,
        turnId: `${prepared.target.threadId}-turn-2`,
        revision: prepared.prelude.response.revision,
      },
      evaluationCase: repairCaseFor(`repair:failed:${prepared.target.threadId}`),
      cardContext: prepared.cardContext,
    });
    expect(target.response.kind).toBe('message');
    if (target.response.kind !== 'message') return;
    const message = target.response.message[0];
    expect(message?.text).toBe('営業時間を更新できませんでした。確認できた範囲では不明です。');
    expect(message?.basis).toBe('conversational');
    expect(message?.evidenceIds).toEqual([]);
    expect(JSON.stringify(target.response)).not.toContain(prepared.oldEvidenceId);
    expect(JSON.stringify(target.response)).not.toContain('M25_FIXTURE_PRIVATE_UPSTREAM_BODY');
    expect(await prepared.stub.getModelEvalFixtureSearchQueries()).toEqual([]);
    const details = await prepared.stub.getModelEvalFixtureDetailsRequests();
    expect(details).toHaveLength(beforeDetails.length + 1);
    expect(details.at(-1)).toEqual([prepared.cardContext.candidateOrder[0]]);
    const afterTrace = await prepared.stub.getModelEvalFixtureTrace();
    expect(afterTrace.upstreamCalls).toBe(beforeTrace.upstreamCalls + 1);
    expect(await prepared.stub.getModelEvalFixturePrivateUpstreamBodyExposed()).toBe(false);
  });

  it('keeps repair fixture-ready while exposing an opt-in live profile', () => {
    const evaluationCase = repairCaseFor('repair:profile');
    expect(executionProfileFor(evaluationCase)).toEqual({
      status: 'fixture_ready',
      kind: 'card_context',
      requiresApiKey: false,
    });
    expect(liveEvaluationProfileFor(evaluationCase)).toBe('repair');
  });
});
