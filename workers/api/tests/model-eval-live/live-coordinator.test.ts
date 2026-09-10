import { describe, expect, it } from 'vitest';
import {
  MODEL_EVALUATION_SCENARIOS,
  expandEvaluationDataset,
} from '../../tooling/model-eval/dataset';
import {
  executeLiveEvaluationCase,
  liveTraceDelta,
  runLiveEvaluationProfiles,
  validateLivePreludeContext,
} from '../../tooling/model-eval/live-coordinator';
import type { CandidateIdentityMapping } from '../../tooling/model-eval/candidate-mapping';
import { LiveTraceRecorder, type LiveTraceSnapshot } from '../../tooling/model-eval/live';
import type { EvaluationCase } from '../../tooling/model-eval/types';

const trace = (changes: Partial<LiveTraceSnapshot> = {}): LiveTraceSnapshot => ({
  complete: false,
  modelCalls: 0,
  proposedToolCalls: 0,
  executedToolCalls: null,
  toolNames: [],
  upstreamCalls: 0,
  latencyMs: null,
  inputTokens: null,
  outputTokens: null,
  measuredCostUsd: null,
  modelLocationExposed: false,
  preservedConditionFields: [],
  candidateIdentities: [],
  candidateIdentityMapAvailable: false,
  ...changes,
});

const caseFor = (id: EvaluationCase['id']): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`missing evaluation scenario: ${id}`);
  const evaluationCase = expandEvaluationDataset([scenario])[0];
  if (evaluationCase === undefined) throw new Error(`missing evaluation case: ${id}`);
  return evaluationCase;
};

const candidateMapping: CandidateIdentityMapping = {
  ok: true,
  pairs: [
    {
      provider: 'google_places',
      recordRef: 'eval-place-a',
      runtimeCandidateId: 'runtime-a',
      evaluationCandidateId: 'candidate-a',
    },
    {
      provider: 'google_places',
      recordRef: 'eval-place-b',
      runtimeCandidateId: 'runtime-b',
      evaluationCandidateId: 'candidate-b',
    },
  ],
  byRuntimeCandidateId: new Map([
    ['runtime-a', 'candidate-a'],
    ['runtime-b', 'candidate-b'],
  ]),
};

describe('model-eval live coordinator boundaries', () => {
  it('keeps first-call samples, rejects unknown or reverse deltas, and fails closed on location ambiguity', () => {
    const recorder = new LiveTraceRecorder();
    const recorderBaseline = recorder.snapshot();
    recorder.begin({ type: 'fixture-prompt' });
    recorder.finish({
      inputTokens: { total: 4 },
      outputTokens: { total: 5 },
    });
    const recorderSample = recorder.snapshot();
    expect(recorderSample).toMatchObject({
      modelCalls: 1,
      inputTokens: 4,
      outputTokens: 5,
    });
    expect(liveTraceDelta(recorderSample, recorderBaseline)).toMatchObject({ ok: true });

    const baseline = trace();
    const first = liveTraceDelta(
      trace({
        complete: true,
        modelCalls: 1,
        proposedToolCalls: 1,
        executedToolCalls: 1,
        toolNames: ['search_places'],
        upstreamCalls: 2,
        latencyMs: 20,
        inputTokens: 4,
        outputTokens: 5,
      }),
      baseline,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.trace).toMatchObject({
      complete: true,
      modelCalls: 1,
      latencyMs: 20,
      inputTokens: 4,
      outputTokens: 5,
      executedToolCalls: 1,
    });

    const unknown = liveTraceDelta(
      trace({ complete: true, modelCalls: 2, latencyMs: 30, inputTokens: 10, outputTokens: 11 }),
      trace({ modelCalls: 1 }),
    );
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(unknown.trace).toMatchObject({
      modelCalls: 1,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      executedToolCalls: null,
    });

    expect(liveTraceDelta(trace({ modelCalls: 1 }), trace({ modelCalls: 2 }))).toEqual({
      ok: false,
      code: 'TRACE_DELTA_INVALID',
    });
    expect(
      liveTraceDelta(trace({ toolNames: [] }), trace({ toolNames: ['search_places'] })),
    ).toEqual({ ok: false, code: 'TRACE_DELTA_INVALID' });
    expect(
      liveTraceDelta(trace({ modelLocationExposed: true }), trace({ modelLocationExposed: true })),
    ).toEqual({ ok: false, code: 'TRACE_DELTA_UNAVAILABLE' });
  });

  it('requires continuity target candidate-b at the second public card position', () => {
    const evaluationCase = caseFor('continuity');
    const cardContext = {
      cardSetId: 'card-set',
      candidateOrder: ['runtime-a', 'runtime-b'],
      selectedCandidateId: null,
    } as const;
    expect(
      validateLivePreludeContext({
        profile: 'continuity',
        evaluationCase,
        cardContext,
        mapping: candidateMapping,
      }),
    ).toEqual({ ok: true });
    expect(
      validateLivePreludeContext({
        profile: 'continuity',
        evaluationCase,
        cardContext: { ...cardContext, candidateOrder: ['runtime-b', 'runtime-a'] },
        mapping: candidateMapping,
      }),
    ).toEqual({ ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' });
  });

  it('runs a validated two-turn response and records only the target trace', async () => {
    const evaluationCase = caseFor('reason');
    const targetText = evaluationCase.userTurns[0] ?? '';
    const target = {
      ownerScopeRef: 'model-eval-test-owner',
      threadId: 'model-eval-reason-thread',
      turnId: 'model-eval-reason-turn-1',
      revision: 1,
    } as const;
    const plan = {
      profile: 'reason' as const,
      prelude: { text: '候補を準備して。', source: 'synthetic' as const },
      targetTexts: [targetText] as const,
    };
    const retention = {
      retentionDecision: 'deny' as const,
      retentionMode: 'none' as const,
      sessionExpiresAt: '2026-09-10T18:00:00.000Z',
      freshUntil: null,
      displayUntil: null,
      retentionUntil: null,
      deletionScheduledAt: null,
      attribution: null,
      restoreMode: 'unavailable' as const,
      policyStatus: 'expired' as const,
      displayPolicyStatus: 'expired' as const,
    };
    const publicText = {
      text: 'fixture response',
      evidenceIds: [],
      evidence: [],
      basis: 'conversational' as const,
      retention,
    };
    const cardsResponse = (turnId: string, revision: number, responseId: string) => ({
      schemaVersion: 'v1',
      threadId: target.threadId,
      turnId,
      responseId,
      revision,
      kind: 'cards' as const,
      presentation: 'replace' as const,
      cardSetId: 'model-eval-card-set',
      message: [publicText],
      cards: {
        hero: {
          candidateId: 'runtime-a',
          facts: { identity: { status: 'unknown' as const, reason: 'fixture' } },
          why: publicText,
        },
        alts: [],
      },
    });
    let traceReads = 0;
    const turnInputs: { index: number; revision: number; cardSetId: string | null }[] = [];
    const result = await executeLiveEvaluationCase({
      evaluationCase,
      plan,
      target,
      expectedIdentities: [
        {
          provider: 'google_places',
          recordRef: 'eval-place-a',
          evaluationCandidateId: 'candidate-a',
        },
      ],
      ports: {
        initialize: () => Promise.resolve({ ok: true }),
        runTurn: (seed, cardContext) => {
          turnInputs.push({
            index: seed.index,
            revision: seed.target.revision,
            cardSetId: cardContext?.cardSetId ?? null,
          });
          return Promise.resolve({
            status: 'completed',
            response:
              seed.index === 0
                ? cardsResponse(seed.target.turnId, 2, 'model-eval-prelude-response')
                : cardsResponse(seed.target.turnId, 3, 'model-eval-target-response'),
          });
        },
        readTrace: () => {
          traceReads += 1;
          if (traceReads === 1) return Promise.resolve(trace());
          if (traceReads === 2) {
            return Promise.resolve(
              trace({
                complete: true,
                modelCalls: 1,
                proposedToolCalls: 1,
                toolNames: ['search_places'],
                upstreamCalls: 1,
                latencyMs: 10,
                inputTokens: 2,
                outputTokens: 3,
                candidateIdentities: [
                  {
                    provider: 'google_places',
                    recordRef: 'eval-place-a',
                    candidateId: 'runtime-a',
                  },
                ],
                candidateIdentityMapAvailable: true,
              }),
            );
          }
          return Promise.resolve(
            trace({
              complete: true,
              modelCalls: 2,
              proposedToolCalls: 2,
              toolNames: ['search_places', 'get_place_details'],
              upstreamCalls: 2,
              latencyMs: 30,
              inputTokens: 5,
              outputTokens: 7,
              candidateIdentities: [
                {
                  provider: 'google_places',
                  recordRef: 'eval-place-a',
                  candidateId: 'runtime-a',
                },
              ],
              candidateIdentityMapAvailable: true,
            }),
          );
        },
        readProfile: () => Promise.resolve({ model: 'fixture', promptVersion: 'test' }),
      },
    });

    expect(turnInputs).toEqual([
      { index: 0, revision: 1, cardSetId: null },
      { index: 1, revision: 2, cardSetId: 'model-eval-card-set' },
    ]);
    expect(result.failure).toBeUndefined();
    expect(result.attempt.trace).toMatchObject({
      modelCalls: 1,
      latencyMs: 20,
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(result.run?.trace.toolCalls.map((call) => call.name)).toEqual(['get_place_details']);
    expect(result.run?.metrics).toMatchObject({
      modelCalls: 1,
      upstreamCalls: 1,
      latencyMs: 20,
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(result.run?.trace.complete).toBe(true);
  });

  it('executes every profile with injected ports and preserves later artifacts after failure', async () => {
    const scenarios = MODEL_EVALUATION_SCENARIOS.filter((scenario) =>
      ['new-search', 'reason', 'continuity'].includes(scenario.id),
    );
    let runCalls = 0;
    const artifacts = await runLiveEvaluationProfiles({
      scenarios,
      expectedIdentities: [],
      portsForCase: (evaluationCase) => ({
        target: {
          ownerScopeRef: 'model-eval-test-owner',
          threadId: `thread-${evaluationCase.caseId}`,
          turnId: `turn-${evaluationCase.caseId}`,
          revision: 1,
        },
        ports: {
          initialize: () => Promise.resolve({ ok: true }),
          runTurn: () => {
            runCalls += 1;
            return Promise.resolve({ status: 'failed', code: 'RUNTIME_FAILED', response: null });
          },
          readTrace: () => Promise.resolve(trace()),
          readProfile: () => Promise.resolve({ model: 'fixture', promptVersion: 'test' }),
        },
      }),
    });

    expect(runCalls).toBe(9);
    expect(artifacts.map((artifact) => artifact.profile)).toEqual([
      'new-search',
      'reason',
      'continuity',
    ]);
    for (const artifact of artifacts) {
      expect(artifact.status).toBe('runtime_failed');
      expect(artifact.attempts).toHaveLength(3);
      expect(artifact.failures).toHaveLength(3);
      expect(artifact.report.coverage).toMatchObject({ expected: 3, actual: 0 });
    }
  });
});
