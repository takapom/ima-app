import { describe, expect, it } from 'vitest';
import {
  committed,
  firstSearchUsesCurrentLocation,
  kindIs,
  neverSearchesCurrentLocation,
  noCards,
  searchesNamedArea,
} from '../../tooling/eval/promptfoo/assertions';
import type { EvalRunResult, EvalTurnRecord } from '../../tooling/eval/eval-contract';
import {
  evalCaseFrom,
  evaluationErrorOf,
  PRODUCTION_PROMPT,
  renderEvalRun,
  tokenUsageOf,
} from '../../tooling/eval/promptfoo/provider-support';

const vars = {
  shopSet: 'shibuya-ebisu',
  now: '2026-10-10T11:00:00.000Z',
  location: 'available',
  turns: '近くで甘いもの食べたい\n\n  もう少し静かなところは？  ',
};

const turn = (overrides: Partial<EvalTurnRecord> = {}): EvalTurnRecord => ({
  userText: '近くで甘いもの食べたい',
  runStatus: 'completed',
  failureCode: null,
  committed: true,
  kind: 'propose',
  messages: ['近くのこちらです。'],
  cards: [{ name: '架空 甘味処 こもれび', why: '和パフェの掲載があります', diff: null }],
  searchOutcome: null,
  toolCalls: [
    {
      name: 'search_places',
      args: {
        input: { query: 'スイーツ', area: { kind: 'current_location', radiusMeters: 1000 } },
      },
      result: { status: 'ok', code: null, candidates: 3, issues: [] },
    },
    {
      name: 'respond',
      args: { input: { kind: 'propose' } },
      result: { status: 'committed', code: null, candidates: null, issues: [] },
    },
  ],
  toolResultsMatched: true,
  modelCalls: [
    { ms: 900, inputTokens: 1200, outputTokens: 80, toolNames: ['search_places'], failure: null },
    { ms: 1100, inputTokens: 1800, outputTokens: 120, toolNames: ['respond'], failure: null },
  ],
  respondMissing: [],
  respondRejections: [],
  evalError: null,
  ...overrides,
});

const contextOf = (run: EvalRunResult, config?: Record<string, unknown>) => ({
  providerResponse: { metadata: { evalRun: run } },
  ...(config === undefined ? {} : { config }),
});

describe('evalCaseFrom', () => {
  it('splits turns by line and keeps the production prompt by default', () => {
    const parsed = evalCaseFrom(PRODUCTION_PROMPT, vars);
    expect(parsed).toEqual({
      ok: true,
      value: {
        shopSet: 'shibuya-ebisu',
        now: '2026-10-10T11:00:00.000Z',
        location: 'available',
        turns: ['近くで甘いもの食べたい', 'もう少し静かなところは？'],
        areaText: null,
        budget: null,
      },
    });
  });

  it('sends any other prompt as the system prompt variant', () => {
    const parsed = evalCaseFrom('評価用の案', vars);
    expect(parsed.ok && parsed.value.systemPrompt).toBe('評価用の案');
  });

  it('rejects a time that does not exist or is not in the canonical UTC form', () => {
    for (const now of ['2026-02-30T11:00:00.000Z', '2026-10-10T20:00:00+09:00', '2026-10-10']) {
      expect(evalCaseFrom(PRODUCTION_PROMPT, { ...vars, now })).toEqual({
        ok: false,
        error: '評価ケースのvarsが不正です: now',
      });
    }
  });

  it('names the invalid vars instead of running a broken case', () => {
    expect(evalCaseFrom(PRODUCTION_PROMPT, { ...vars, location: 'somewhere', turns: '' })).toEqual({
      ok: false,
      error: '評価ケースのvarsが不正です: location, turns',
    });
  });
});

describe('renderEvalRun and tokenUsageOf', () => {
  it('renders each turn so a person can read what happened', () => {
    expect(renderEvalRun({ turns: [turn()] })).toBe(
      [
        '[ターン1] 近くで甘いもの食べたい',
        '結果: proposeで確定',
        'メッセージ: 近くのこちらです。',
        'カード1: 架空 甘味処 こもれび — 和パフェの掲載があります',
        'Tool: search_places「スイーツ」（現在地 1000m） → ok 3件',
        'Tool: respond → committed',
        'step: 2（Toolなし 0・確定拒否 0・打ち切り 0）',
      ].join('\n'),
    );
  });

  it('says so instead of listing results that could not be matched to calls', () => {
    expect(renderEvalRun({ turns: [turn({ toolResultsMatched: false })] })).toContain(
      'Tool結果: 呼び出しと対応付けられないため表示しない',
    );
  });

  it('sums the tokens of every model call', () => {
    expect(tokenUsageOf({ turns: [turn(), turn()] })).toEqual({
      total: 6400,
      prompt: 6000,
      completion: 400,
    });
  });
});

describe('evaluationErrorOf', () => {
  const failedCall = (failure: 'call_failed' | 'stream_failed' | 'aborted') =>
    turn({
      committed: false,
      kind: null,
      runStatus: 'failed',
      modelCalls: [{ ms: 10, inputTokens: null, outputTokens: null, toolNames: [], failure }],
    });

  it('separates a run that could not be evaluated from a model that behaved badly', () => {
    expect(evaluationErrorOf({ turns: [turn()] })).toBeUndefined();
    // 確定しなかっただけなら、モデルの振る舞いとして採点する。
    expect(evaluationErrorOf({ turns: [turn({ committed: false, kind: null })] })).toBeUndefined();
    expect(evaluationErrorOf({ turns: [turn(), failedCall('call_failed')] })).toContain('ターン2');
    expect(evaluationErrorOf({ turns: [failedCall('stream_failed')] })).toContain('モデル呼び出し');
  });

  it('grades a call the runtime cut short, since users meet the same failure', () => {
    expect(evaluationErrorOf({ turns: [failedCall('aborted')] })).toBeUndefined();
  });

  it('reports a runtime the settings left unconfigured', () => {
    expect(
      evaluationErrorOf({
        turns: [
          turn({
            committed: false,
            kind: null,
            runStatus: 'failed',
            failureCode: 'RUNTIME_UNCONFIGURED',
          }),
        ],
      }),
    ).toContain('RUNTIME_UNCONFIGURED');
  });

  it('reports a prompt variant that could not be applied', () => {
    expect(
      evaluationErrorOf({
        turns: [turn({ committed: false, kind: null, evalError: 'SYSTEM_PROMPT_NOT_FOUND' })],
      }),
    ).toContain('システムプロンプト案を適用できませんでした');
  });
});

describe('assertions', () => {
  const run = { turns: [turn()] };

  it('passes on the recorded behavior', () => {
    expect(committed('', contextOf(run)).pass).toBe(true);
    expect(kindIs('', contextOf(run, { kind: 'propose' })).pass).toBe(true);
    expect(firstSearchUsesCurrentLocation('', contextOf(run)).pass).toBe(true);
  });

  it('fails when the behavior differs from the expectation', () => {
    expect(kindIs('', contextOf(run, { kind: 'ask' }))).toMatchObject({
      pass: false,
      reason: '期待 ask・実際 propose',
    });
    expect(neverSearchesCurrentLocation('', contextOf(run)).pass).toBe(false);
    expect(searchesNamedArea('', contextOf(run)).pass).toBe(false);
    expect(noCards('', contextOf(run)).pass).toBe(false);
    const uncommitted = { turns: [turn({ committed: false, kind: null, runStatus: 'failed' })] };
    expect(committed('', contextOf(uncommitted)).pass).toBe(false);
  });

  it('does not count a turn that did nothing because it failed as avoiding the mistake', () => {
    const failed = {
      turns: [
        turn({ committed: false, kind: null, runStatus: 'failed', cards: [], toolCalls: [] }),
      ],
    };
    expect(neverSearchesCurrentLocation('', contextOf(failed)).pass).toBe(false);
    expect(noCards('', contextOf(failed)).pass).toBe(false);
    const answered = { turns: [turn({ kind: 'ask', cards: [], toolCalls: [] })] };
    expect(neverSearchesCurrentLocation('', contextOf(answered)).pass).toBe(true);
    expect(noCards('', contextOf(answered)).pass).toBe(true);
  });

  it('fails without a valid record or expectation instead of passing silently', () => {
    expect(committed('', {}).pass).toBe(false);
    expect(committed('', { providerResponse: { metadata: { evalRun: { turns: [] } } } }).pass).toBe(
      false,
    );
    expect(kindIs('', contextOf(run)).pass).toBe(false);
  });
});
