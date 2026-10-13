import { describe, expect, it } from 'vitest';
import type { EvalTurnRecord } from '../../tooling/eval/eval-contract';
import {
  committed,
  differsFromPreviousCards,
  excludesPreviousHero,
  firstSearchUsesCurrentLocation,
  heroIn,
  heroIsNot,
  kindIs,
  lastTurnDoesNotSearch,
  neverSearchesCurrentLocation,
  noCards,
  noOpenNowClaim,
  searchesNamedArea,
  singleQuestion,
} from '../../tooling/eval/promptfoo/assertions';
import type { Assertion } from '../../tooling/eval/promptfoo/assertion-support';
import {
  firstRadiusIs1000,
  noRepairs,
  queryAvoidsWords,
} from '../../tooling/eval/promptfoo/scores';
import { evalTurn as turn } from './eval-turn-fixture';

/** 記録の最後のターンを判定する。前のターンも並べられる。 */
const check = (
  assertion: Assertion,
  turns: readonly EvalTurnRecord[],
  config?: Record<string, unknown>,
) =>
  assertion('', {
    providerResponse: { metadata: { evalRun: { turns } } },
    ...(config === undefined ? {} : { config }),
  });

const search = (area: unknown, query = 'カフェ') => ({
  name: 'search_places',
  args: { input: { mode: 'search', query, area } },
  result: { status: 'ok', code: null, candidates: 2, issues: [] },
});
const respondCall = {
  name: 'respond',
  args: { input: {} },
  result: { status: 'committed', code: null, candidates: null, issues: [] },
};
const card = (name: string) => ({ name, why: '掲載に合う', diff: null });
const failed = turn({
  committed: false,
  kind: null,
  runStatus: 'failed',
  cards: [],
  toolCalls: [],
});
const asked = turn({ kind: 'ask', cards: [], toolCalls: [respondCall], messages: ['駅名は？'] });

describe('gates', () => {
  it('fail without a valid record instead of passing silently', () => {
    expect(committed('', {}).pass).toBe(false);
    expect(check(committed, []).pass).toBe(false);
  });

  it('committed and kindIs read the final turn', () => {
    expect(check(committed, [turn()]).pass).toBe(true);
    expect(check(committed, [failed]).pass).toBe(false);
    expect(check(kindIs, [turn()], { kind: 'propose' }).pass).toBe(true);
    expect(check(kindIs, [turn()], { kind: 'ask' })).toMatchObject({
      pass: false,
      reason: '期待 ask・実際 propose',
    });
    expect(check(kindIs, [turn()]).pass).toBe(false);
  });

  it('judge where the turn searched', () => {
    const current = turn({ toolCalls: [search({ kind: 'current_location', radiusMeters: 1000 })] });
    const named = turn({ toolCalls: [search({ kind: 'named_area', name: '恵比寿' })] });
    expect(check(firstSearchUsesCurrentLocation, [current]).pass).toBe(true);
    expect(check(firstSearchUsesCurrentLocation, [named]).pass).toBe(false);
    expect(check(searchesNamedArea, [named]).pass).toBe(true);
    expect(check(searchesNamedArea, [current]).pass).toBe(false);
    expect(check(neverSearchesCurrentLocation, [named]).pass).toBe(true);
    expect(check(neverSearchesCurrentLocation, [current]).pass).toBe(false);
  });

  it('do not count a turn that did nothing because it failed', () => {
    for (const assertion of [
      neverSearchesCurrentLocation,
      noCards,
      lastTurnDoesNotSearch,
      noOpenNowClaim,
      singleQuestion,
    ]) {
      expect(check(assertion, [failed]).pass).toBe(false);
    }
    expect(check(neverSearchesCurrentLocation, [asked]).pass).toBe(true);
    expect(check(noCards, [asked]).pass).toBe(true);
  });

  it('noCards fails when cards are shown', () => {
    expect(check(noCards, [turn()]).pass).toBe(false);
  });

  it('lastTurnDoesNotSearch fails when the explanation searched again', () => {
    const answered = turn({ kind: 'answer', cards: [], toolCalls: [respondCall] });
    expect(check(lastTurnDoesNotSearch, [turn(), answered]).pass).toBe(true);
    expect(check(lastTurnDoesNotSearch, [turn(), turn({ kind: 'answer' })]).pass).toBe(false);
  });

  it('noOpenNowClaim catches assertive wording but allows unconfirmed wording', () => {
    const say = (message: string, why = '掲載に合う') =>
      turn({ messages: [message], cards: [{ name: '架空 店', why, diff: null }] });
    expect(check(noOpenNowClaim, [say('営業中かは未確認です。')]).pass).toBe(true);
    expect(check(noOpenNowClaim, [say('掲載では22時までの営業です。')]).pass).toBe(true);
    expect(check(noOpenNowClaim, [say('今は営業中です。')])).toMatchObject({
      pass: false,
      reason: '断定: 営業中です',
    });
    expect(check(noOpenNowClaim, [say('こちらです。', '今やっているので入れます')]).pass).toBe(
      false,
    );
    expect(check(noOpenNowClaim, [say('空席があります。')]).pass).toBe(false);
  });

  it('singleQuestion allows one question at most', () => {
    expect(check(singleQuestion, [asked]).pass).toBe(true);
    const twice = turn({ kind: 'ask', cards: [], messages: ['駅名は？予算は？'] });
    expect(check(singleQuestion, [twice]).pass).toBe(false);
  });

  it('differsFromPreviousCards requires new shops after asking for another', () => {
    const before = turn({ cards: [card('架空 A'), card('架空 B')] });
    expect(check(differsFromPreviousCards, [before, turn({ cards: [card('架空 C')] })]).pass).toBe(
      true,
    );
    expect(
      check(differsFromPreviousCards, [before, turn({ cards: [card('架空 C'), card('架空 B')] })]),
    ).toMatchObject({ pass: false, reason: '再提案: 架空 B' });
    expect(check(differsFromPreviousCards, [before, asked]).pass).toBe(false);
    expect(check(differsFromPreviousCards, [turn({ cards: [card('架空 C')] })]).pass).toBe(false);
  });

  it('excludesPreviousHero rejects proposing the refused shop again', () => {
    const before = turn({ cards: [card('架空 A'), card('架空 B')] });
    expect(check(excludesPreviousHero, [before, turn({ cards: [card('架空 B')] })]).pass).toBe(
      true,
    );
    expect(
      check(excludesPreviousHero, [before, turn({ cards: [card('架空 C'), card('架空 A')] })]).pass,
    ).toBe(false);
  });

  it('heroIsNot and heroIn check the first card against the case config', () => {
    const proposal = turn({ cards: [card('架空 居酒屋 つばめ'), card('架空 居酒屋 王様')] });
    expect(check(heroIsNot, [proposal], { name: '架空 居酒屋 王様' }).pass).toBe(true);
    expect(check(heroIsNot, [proposal], { name: '架空 居酒屋 つばめ' }).pass).toBe(false);
    expect(check(heroIsNot, [proposal]).pass).toBe(false);
    expect(check(heroIn, [proposal], { names: ['架空 居酒屋 つばめ'] }).pass).toBe(true);
    expect(check(heroIn, [proposal], { names: ['架空 居酒屋 さくら'] }).pass).toBe(false);
    expect(check(heroIn, [proposal], { names: [] }).pass).toBe(false);
  });
});

describe('scores', () => {
  it('firstRadiusIs1000 checks the first nearby search', () => {
    const radius = (meters: number) =>
      turn({ toolCalls: [search({ kind: 'current_location', radiusMeters: meters })] });
    expect(check(firstRadiusIs1000, [radius(1000)]).pass).toBe(true);
    expect(check(firstRadiusIs1000, [radius(3000)])).toMatchObject({
      pass: false,
      reason: '最初の半径: 3000m',
    });
  });

  it('queryAvoidsWords flags mood words used as search terms', () => {
    const words = { words: ['まったり', '甘いもの'] };
    const queried = (query: string) =>
      turn({ toolCalls: [search({ kind: 'named_area', name: '渋谷' }, query)] });
    expect(check(queryAvoidsWords, [queried('カフェ')], words).pass).toBe(true);
    expect(check(queryAvoidsWords, [queried('まったり カフェ')], words)).toMatchObject({
      pass: false,
      reason: '要望の語をそのまま検索: まったり',
    });
    expect(check(queryAvoidsWords, [asked], words).pass).toBe(false);
    expect(check(queryAvoidsWords, [queried('カフェ')]).pass).toBe(false);
  });

  it('noRepairs fails on rejected tool input or refused responds', () => {
    expect(check(noRepairs, [turn()]).pass).toBe(true);
    const rejectedInput = turn({
      toolCalls: [
        {
          name: 'search_places',
          args: null,
          result: { status: 'tool_error', code: null, candidates: null, issues: ['input.area'] },
        },
        respondCall,
      ],
    });
    expect(check(noRepairs, [rejectedInput]).pass).toBe(false);
    const refused = turn({
      respondRejections: [{ codes: ['MISSING_EVIDENCE'], remainingRepairs: 1 }],
    });
    expect(check(noRepairs, [refused]).pass).toBe(false);
    expect(check(noRepairs, [failed]).pass).toBe(false);
  });
});
