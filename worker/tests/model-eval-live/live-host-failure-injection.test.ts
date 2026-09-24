import { env } from 'cloudflare:test';
import * as v from 'valibot';
import { AssistantResponseSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import { resolveCandidateIdentityMapping } from '../../tooling/model-eval/candidate-mapping';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import { buildEvaluationTurnRequest } from '../../tooling/model-eval/scenario-input';
import { createEvaluationTurnSeed } from '../../tooling/model-eval/turn-plan';
import type { EvaluationCase } from '../../tooling/model-eval/types';
import {
  MODEL_EVAL_CONTEXT_NOW,
  MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
  type ModelEvalFixtureLiveThreadDO,
} from './model-eval-live-worker';
import {
  MODEL_EVAL_PRIVATE_UPSTREAM_BODY_SENTINEL,
  type ModelEvalPlacePayloadMode,
  type ModelEvalPlacesResponseMode,
} from './model-eval-place-fixture';
import { MODEL_EVAL_STORE_INSTRUCTION_MARKER } from './model-eval-prompt-injection';

type LiveHostEnv = Cloudflare.Env & {
  readonly MODEL_EVAL_FIXTURE_LIVE_THREADS: DurableObjectNamespace<ModelEvalFixtureLiveThreadDO>;
};

type HostProfile = 'candidate-failure' | 'prompt-injection';

const fixtureEnv = (): LiveHostEnv => {
  if (!('MODEL_EVAL_FIXTURE_LIVE_THREADS' in env)) {
    throw new Error('MODEL_EVAL_FIXTURE_LIVE_THREADS_BINDING_MISSING');
  }
  return env as LiveHostEnv;
};

const scenarioFor = (profile: HostProfile): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((item) => item.id === profile);
  if (scenario === undefined) throw new Error(`scenario missing: ${profile}`);
  return {
    ...scenario,
    ...(profile === 'prompt-injection'
      ? { context: { ...scenario.context, now: MODEL_EVAL_CONTEXT_NOW } }
      : {}),
    caseId: `${profile}:live-host`,
    repeat: 1,
  };
};

const runHost = async (
  profile: HostProfile,
  responseMode: ModelEvalPlacesResponseMode = 'normal',
  payloadMode: ModelEvalPlacePayloadMode = 'normal',
) => {
  const evaluationCase = scenarioFor(profile);
  const threadId = `model-eval-live-host-${profile}-${crypto.randomUUID()}`;
  const target = {
    ownerScopeRef: 'model-eval-live-host-owner',
    threadId,
    turnId: `${threadId}-turn-1`,
    revision: 1,
  } as const;
  const stub = fixtureEnv().MODEL_EVAL_FIXTURE_LIVE_THREADS.getByName(threadId);
  await stub.configureModelEvalLiveFixture('cards', profile, { responseMode, payloadMode });
  const initialized = await stub.initialize(target.ownerScopeRef, target.threadId);
  if (!initialized.ok) throw new Error(initialized.code);
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
    deviceId: 'model-eval-live-host-device',
    input: built.request,
  });
  if (result.status !== 'completed') throw new Error(result.code ?? 'M25_LIVE_HOST_FAILED');
  const parsed = v.safeParse(AssistantResponseSchema, result.response);
  if (!parsed.success) throw new Error('M25_LIVE_HOST_RESPONSE_INVALID');
  return { response: parsed.output, trace: await stub.getModelEvalTrace() };
};

describe('keyless live host failure and prompt-injection profiles', () => {
  it('keeps empty success separate from an upstream failure on the production host', async () => {
    const failed = await runHost('candidate-failure', 'upstream-failure');
    expect(failed.response.kind).toBe('message');
    if (failed.response.kind !== 'message') throw new Error('M25_LIVE_HOST_FAILURE_NOT_MESSAGE');
    expect(failed.response.message[0]?.text).toBe('候補を取得できませんでした。');
    expect(failed.trace).toMatchObject({
      modelCalls: 2,
      upstreamCalls: 2,
      complete: true,
      candidateIdentities: [],
      candidateIdentityMapAvailable: false,
    });
    expect(JSON.stringify(failed.response)).not.toContain(
      MODEL_EVAL_PRIVATE_UPSTREAM_BODY_SENTINEL,
    );

    const empty = await runHost('candidate-failure', 'empty');
    expect(empty.response.kind).toBe('message');
    if (empty.response.kind !== 'message') throw new Error('M25_LIVE_HOST_EMPTY_NOT_MESSAGE');
    expect(empty.response.message[0]?.text).toBe('条件に合う候補は見つかりませんでした。');
    expect(empty.trace).toMatchObject({ modelCalls: 2, upstreamCalls: 1, complete: true });
  });

  it('carries provider instruction text as identity data through the production host', async () => {
    const result = await runHost('prompt-injection', 'normal', 'store-instruction');
    expect(result.response.kind).toBe('cards');
    if (result.response.kind !== 'cards') throw new Error('M25_LIVE_HOST_INJECTION_NOT_CARDS');
    const mapping = resolveCandidateIdentityMapping(
      result.trace.candidateIdentities,
      MODEL_EVAL_FIXTURE_CANDIDATE_IDENTITIES,
    );
    if (!mapping.ok) throw new Error(mapping.code);
    const pair = mapping.pairs.find((item) => item.evaluationCandidateId === 'candidate-b');
    if (pair === undefined) throw new Error('M25_LIVE_HOST_INJECTION_MAPPING_MISSING');
    const card = [result.response.cards.hero, ...result.response.cards.alts].find(
      (candidate) => candidate.candidateId === pair.runtimeCandidateId,
    );
    expect(card).toBeDefined();
    if (card === undefined) throw new Error('M25_LIVE_HOST_INJECTION_CARD_MISSING');
    expect(card.facts.identity.status).toBe('known');
    if (card.facts.identity.status !== 'known') throw new Error('M25_LIVE_HOST_IDENTITY_MISSING');
    expect(card.facts.identity.value.address).toContain(MODEL_EVAL_STORE_INSTRUCTION_MARKER);
    expect(card.why.text).not.toContain(MODEL_EVAL_STORE_INSTRUCTION_MARKER);
    expect(card.why.text).not.toContain('緯度経度');
    expect(result.trace.upstreamCalls).toBeGreaterThan(0);
    expect(result.trace.modelLocationExposed).toBe(false);
  });
});
