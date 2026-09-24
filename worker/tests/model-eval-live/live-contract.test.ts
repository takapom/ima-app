import { describe, expect, it } from 'vitest';
import {
  expandEvaluationDataset,
  MODEL_EVALUATION_SCENARIOS,
} from '../../tooling/model-eval/dataset';
import {
  buildEvaluationRunFromResponse,
  createLiveProbeArtifact,
  LIVE_PROMPT_VERSION,
  resolveModelEvalLiveOptIn,
  runModelEvalLiveCli,
  type LiveProbeAttempt,
  LiveTraceRecorder,
  type LiveTraceSnapshot,
} from '../../tooling/model-eval/live';
import { resolveCandidateIdentityMapping } from '../../tooling/model-eval/candidate-mapping';
import {
  modelLocationProjectionHasCoordinates,
  modelToolErrorCodeIn,
} from './model-eval-context-values';

describe('model-eval live opt-in boundary', () => {
  it('requires the explicit live flag before inspecting provider credentials', () => {
    expect(resolveModelEvalLiveOptIn({ OPENAI_API_KEY: 'secret' })).toEqual({
      enabled: false,
      code: 'LIVE_FLAG_REQUIRED',
    });
  });

  it('reports a missing key without constructing a provider', () => {
    expect(resolveModelEvalLiveOptIn({ MODEL_EVAL_LIVE: '1' })).toEqual({
      enabled: false,
      code: 'MODEL_PROVIDER_KEY_MISSING',
    });
  });

  it('keeps the CLI at preflight until the dedicated Worker is selected', () => {
    const output: string[] = [];
    const code = runModelEvalLiveCli(['--live'], { OPENAI_API_KEY: 'secret' }, (line) => {
      output.push(line);
    });
    expect(code).toBe(2);
    expect(output.join('\n')).toContain('worker-required');
    expect(output.join('\n')).not.toContain('secret');
  });

  it('detects location fields embedded in model message text without retaining the text', () => {
    const recorder = new LiveTraceRecorder();
    recorder.begin({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '{"lat":35.6595,"lng":139.7005}' }],
        },
      ],
    });
    const snapshot = recorder.snapshot();
    expect(snapshot.modelLocationExposed).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('35.6595');
  });

  it('audits coordinate keys in the formal model projection', () => {
    const prompt = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              kind: 'ima_turn_context',
              context: {
                location: { status: 'available', areaDescription: null, lat: 35.6595 },
              },
            }),
          },
        ],
      },
    ];
    expect(modelLocationProjectionHasCoordinates(prompt)).toBe(true);
  });

  it('reads provider error codes only from structured tool results', () => {
    const valid = [
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'tool-location-required',
            toolName: 'search_places',
            output: {
              type: 'json' as const,
              value: { status: 'error' as const, error: { code: 'LOCATION_REQUIRED' as const } },
            },
          },
        ],
      },
    ];
    expect(modelToolErrorCodeIn(valid, 'LOCATION_REQUIRED')).toBe(true);
    const textOnly = [
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: '{"code":"LOCATION_REQUIRED"}' }],
      },
    ];
    expect(modelToolErrorCodeIn(textOnly, 'LOCATION_REQUIRED')).toBe(false);
  });

  it('records executed tools, refused responds, committed kinds, cached tokens and budget', () => {
    const recorder = new LiveTraceRecorder();
    expect(recorder.snapshot()).toMatchObject({ executedTools: null, executedToolCalls: null });
    recorder.begin([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              kind: 'ima_turn_context',
              context: { preferences: { areaText: '渋谷', budget: 'normal' } },
            }),
          },
        ],
      },
    ]);
    recorder.finish({ inputTokens: { total: 10, cacheRead: 4 }, outputTokens: { total: 2 } });
    recorder.observeRespondRejection();
    recorder.observeTurnOutcome({
      committed: true,
      operations: { search_places: 1, respond: 2 },
      kind: 'ask',
    });
    recorder.observeTurnOutcome({ committed: false, operations: { respond: 1 } });
    expect(recorder.snapshot()).toMatchObject({
      executedTools: { search_places: 1, get_place_details: 0, respond: 3 },
      executedToolCalls: 4,
      respondInvalid: 1,
      respondKinds: ['ask', null],
      inputTokens: 10,
      cachedInputTokens: 4,
      preservedConditionFields: ['budget'],
    });
  });

  it('maps an ask to a clarification even though the public DTO only says message', () => {
    const evaluationCase = expandEvaluationDataset().find(
      (candidate) => candidate.id === 'mood-tired' && candidate.repeat === 1,
    );
    if (evaluationCase === undefined) throw new Error('mood-tired fixture is missing');
    const retention = {
      retentionDecision: 'deny' as const,
      retentionMode: 'session_only' as const,
      sessionExpiresAt: '2026-09-11T00:00:00.000Z',
      freshUntil: null,
      displayUntil: null,
      retentionUntil: null,
      deletionScheduledAt: null,
      attribution: null,
      restoreMode: 'reference_only' as const,
      policyStatus: 'policy_withheld' as const,
      displayPolicyStatus: 'policy_withheld' as const,
    };
    const response = {
      schemaVersion: 'v1',
      threadId: 'thread-ask',
      turnId: 'turn-ask',
      responseId: 'response-ask',
      revision: 2,
      kind: 'message' as const,
      presentation: 'keep' as const,
      cardSetId: null,
      message: [{ text: 'どのあたりで探しますか？', retention }],
    };
    const recorder = new LiveTraceRecorder();
    recorder.begin([]);
    recorder.finish({ inputTokens: { total: 1 }, outputTokens: { total: 1 } });
    recorder.observeTurnOutcome({ committed: true, operations: { respond: 1 }, kind: 'ask' });
    const converted = buildEvaluationRunFromResponse(evaluationCase, response, recorder.snapshot());
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.run.response.outcome.kind).toBe('clarification');
    expect(converted.run.metrics.respondKind).toBe('ask');
  });

  it('retains only exact candidate identity fields in the host trace', () => {
    const recorder = new LiveTraceRecorder();
    recorder.observeCandidateIdentity({
      provider: 'hotpepper',
      recordRef: 'eval-place-a',
      candidateId: 'runtime-candidate-1',
      displayName: '店舗名は評価キーではない',
    });
    const snapshot = recorder.snapshot();
    expect(snapshot.candidateIdentities).toEqual([
      {
        provider: 'hotpepper',
        recordRef: 'eval-place-a',
        candidateId: 'runtime-candidate-1',
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('店舗名は評価キーではない');
    expect(snapshot.candidateIdentityMapAvailable).toBe(true);
  });

  it('does not score cards when the production registry identity map is unavailable', () => {
    const evaluationCase = expandEvaluationDataset().find(
      (candidate) => candidate.id === 'new-search' && candidate.repeat === 1,
    );
    if (evaluationCase === undefined) throw new Error('new-search fixture is missing');
    const retention = {
      retentionDecision: 'allow' as const,
      retentionMode: 'provider_limited' as const,
      sessionExpiresAt: '2026-09-11T00:00:00.000Z',
      freshUntil: '2026-09-10T18:00:00.000Z',
      displayUntil: '2026-09-10T20:00:00.000Z',
      retentionUntil: '2026-09-10T22:00:00.000Z',
      deletionScheduledAt: '2026-09-10T22:00:00.000Z',
      attribution: null,
      restoreMode: 'full' as const,
      policyStatus: 'available' as const,
      displayPolicyStatus: 'available' as const,
    };
    const evidence = { evidenceId: 'observation-identity', attribution: null, retention };
    const response = {
      schemaVersion: 'v1',
      threadId: 'thread-live-contract',
      turnId: 'turn-live-contract',
      responseId: 'response-live-contract',
      revision: 2,
      kind: 'cards' as const,
      presentation: 'replace' as const,
      cardSetId: 'cardset-live-contract',
      message: [
        {
          text: '青葉カフェを候補にしました。',
          retention,
        },
      ],
      cards: {
        hero: {
          candidateId: 'runtime-candidate-1',
          facts: {
            identity: {
              status: 'known' as const,
              value: {
                name: '青葉カフェ',
                area: '渋谷',
                address: null,
                category: 'cafe',
                stationName: null,
                accessText: null,
                businessStatus: 'operational' as const,
                sourceUrl: null,
              },
              evidence: [evidence],
            },
          },
          why: {
            text: '候補として提示します。',
            retention,
          },
        },
        alts: [],
      },
    };
    const trace: LiveTraceSnapshot = {
      complete: true,
      modelCalls: 1,
      proposedToolCalls: 2,
      executedToolCalls: 2,
      executedTools: { search_places: 1, get_place_details: 0, respond: 1 },
      respondInvalid: 0,
      respondKinds: ['propose'],
      toolNames: ['search_places', 'respond'],
      upstreamCalls: 1,
      latencyMs: 10,
      turnMs: 25,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      measuredCostUsd: null,
      modelLocationExposed: false,
      preservedConditionFields: [],
      candidateIdentities: [],
      candidateIdentityMapAvailable: false,
    };
    const converted = buildEvaluationRunFromResponse(evaluationCase, response, trace);
    expect(converted).toMatchObject({
      ok: false,
      code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE',
    });
    if (converted.ok) throw new Error('expected mapping to remain unverified');
    expect(converted.response).toBeDefined();

    const mapping = resolveCandidateIdentityMapping(
      [
        {
          provider: 'hotpepper',
          recordRef: 'eval-place-a',
          candidateId: 'runtime-candidate-1',
        },
      ],
      [
        {
          provider: 'hotpepper',
          recordRef: 'eval-place-a',
          evaluationCandidateId: 'candidate-a',
        },
        {
          provider: 'hotpepper',
          recordRef: 'eval-place-b',
          evaluationCandidateId: 'candidate-b',
        },
        {
          provider: 'hotpepper',
          recordRef: 'eval-place-c',
          evaluationCandidateId: 'candidate-c',
        },
      ],
    );
    if (!mapping.ok) throw new Error('expected fixture identity mapping');
    const evaluated = buildEvaluationRunFromResponse(
      evaluationCase,
      response,
      {
        ...trace,
        candidateIdentities: [
          {
            provider: 'hotpepper',
            recordRef: 'eval-place-a',
            candidateId: 'runtime-candidate-1',
          },
        ],
        candidateIdentityMapAvailable: true,
      },
      undefined,
      {},
      mapping,
    );
    expect(evaluated.ok).toBe(true);
    if (evaluated.ok) {
      expect(evaluated.run.response.selections[0]?.candidateId).toBe('candidate-a');
      // The listed name on the card is checked against the dataset's identity evidence.
      expect(evaluated.run.response.claims).toEqual([
        expect.objectContaining({
          field: 'identity',
          assertedValue: { name: '青葉カフェ' },
          evidenceIds: ['ev-a-identity'],
        }),
      ]);
      expect(evaluated.run.response.outcome.kind).toBe('cards');
      expect(evaluated.run.metrics).toMatchObject({
        turnMs: 25,
        toolCalls: 2,
        respondKind: 'propose',
        executedTools: { search_places: 1, get_place_details: 0, respond: 1 },
      });
    }

    const unmappedCard = {
      ...response,
      cards: {
        ...response.cards,
        hero: { ...response.cards.hero, candidateId: 'runtime-candidate-unknown' },
      },
    };
    expect(
      buildEvaluationRunFromResponse(
        evaluationCase,
        unmappedCard,
        {
          ...trace,
          candidateIdentities: [
            {
              provider: 'hotpepper',
              recordRef: 'eval-place-a',
              candidateId: 'runtime-candidate-1',
            },
          ],
          candidateIdentityMapAvailable: true,
        },
        undefined,
        {},
        mapping,
      ),
    ).toMatchObject({ ok: false, code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' });
  });

  it('marks a probe artifact unverified when every case is unresolved', () => {
    const scenarios = MODEL_EVALUATION_SCENARIOS.filter(
      (candidate) => candidate.id === 'new-search',
    );
    const cases = expandEvaluationDataset(scenarios);
    const attempts: LiveProbeAttempt[] = cases.map((evaluationCase) => ({
      caseId: evaluationCase.caseId,
      status: 'unverified_mapping',
      code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE',
      modelVersion: 'openai:unknown',
      promptVersion: LIVE_PROMPT_VERSION,
      trace: null,
      publicResponse: null,
    }));
    const artifact = createLiveProbeArtifact({
      profile: 'new-search',
      scenarios,
      attempts,
      runs: [],
      failures: cases.map((evaluationCase) => ({
        caseId: evaluationCase.caseId,
        code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE',
        status: 'unverified_mapping' as const,
      })),
    });
    expect(artifact.status).toBe('unverified');
    expect(artifact.report.coverage.actual).toBe(0);
    expect(artifact.report.coverage.expected).toBe(3);
    expect(artifact.failures).toHaveLength(3);
    expect(artifact.attempts).toHaveLength(3);
  });

  it('keeps runtime failure distinct from unresolved mapping', () => {
    const scenarios = MODEL_EVALUATION_SCENARIOS.filter(
      (candidate) => candidate.id === 'new-search',
    );
    const cases = expandEvaluationDataset(scenarios);
    const artifact = createLiveProbeArtifact({
      profile: 'new-search',
      scenarios,
      attempts: [
        {
          caseId: cases[0]?.caseId ?? 'new-search-r1',
          status: 'runtime_failed',
          code: 'PUBLIC_RESPONSE_INVALID',
          modelVersion: 'openai:unknown',
          promptVersion: LIVE_PROMPT_VERSION,
          trace: null,
          publicResponse: null,
        },
      ],
      runs: [],
      failures: [
        {
          caseId: cases[0]?.caseId ?? 'new-search-r1',
          code: 'PUBLIC_RESPONSE_INVALID',
          status: 'runtime_failed',
        },
      ],
    });
    expect(artifact.status).toBe('runtime_failed');
  });
});
