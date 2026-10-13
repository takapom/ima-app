import type { EvalTurnRecord } from '../../tooling/eval/eval-contract';

/** 確定した提案のターン。各テストで必要な項目だけを上書きして使う。 */
export const evalTurn = (overrides: Partial<EvalTurnRecord> = {}): EvalTurnRecord => ({
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
