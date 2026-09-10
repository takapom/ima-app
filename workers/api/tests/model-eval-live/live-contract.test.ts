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

  it('retains only exact candidate identity fields in the host trace', () => {
    const recorder = new LiveTraceRecorder();
    recorder.observeCandidateIdentity({
      provider: 'google_places',
      recordRef: 'eval-place-a',
      candidateId: 'runtime-candidate-1',
      displayName: '店舗名は評価キーではない',
    });
    const snapshot = recorder.snapshot();
    expect(snapshot.candidateIdentities).toEqual([
      {
        provider: 'google_places',
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
    const evidence = { evidenceId: 'ev-a-name', attribution: null, retention };
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
          evidenceIds: ['ev-a-name'],
          evidence: [evidence],
          basis: 'grounded' as const,
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
                businessStatus: 'operational' as const,
                sourceUrl: null,
              },
              evidence: [evidence],
            },
          },
          why: {
            text: '候補として提示します。',
            evidenceIds: ['ev-a-name'],
            evidence: [evidence],
            basis: 'grounded' as const,
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
      executedToolCalls: null,
      toolNames: ['search_places', 'submit_cards'],
      upstreamCalls: 1,
      latencyMs: 10,
      inputTokens: 1,
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
          provider: 'google_places',
          recordRef: 'eval-place-a',
          candidateId: 'runtime-candidate-1',
        },
      ],
      [
        {
          provider: 'google_places',
          recordRef: 'eval-place-a',
          evaluationCandidateId: 'candidate-a',
        },
        {
          provider: 'google_places',
          recordRef: 'eval-place-b',
          evaluationCandidateId: 'candidate-b',
        },
        {
          provider: 'google_places',
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
            provider: 'google_places',
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
              provider: 'google_places',
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
