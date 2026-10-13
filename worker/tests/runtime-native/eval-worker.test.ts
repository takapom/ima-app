import * as v from 'valibot';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MODEL_SYSTEM_PROMPT } from '@worker/runtime/model/system-prompt';
import evalWorker, { type EvalWorkerEnv } from '../../tooling/eval/worker';
import {
  EvalFailureSchema,
  EvalRunResultSchema,
  type EvalCaseInput,
} from '../../tooling/eval/eval-contract';
import { ECHO_SYSTEM_LENGTH, ECHO_SYSTEM_MARKER, ECHO_TOOL_MARKER } from './eval-scripted-thread';

const evalEnv = (): EvalWorkerEnv => {
  if (!('EVAL_THREADS' in env)) throw new Error('EVAL_THREADS binding is missing');
  return env as unknown as EvalWorkerEnv;
};

const NOW = '2026-10-10T11:00:00.000Z';

const post = (body: unknown, target: EvalWorkerEnv = evalEnv()) =>
  evalWorker.fetch(
    new Request('http://eval.local/turns', { method: 'POST', body: JSON.stringify(body) }),
    target,
  );

const caseOf = (overrides: Partial<EvalCaseInput> = {}): EvalCaseInput => ({
  shopSet: 'shibuya-ebisu',
  now: NOW,
  location: 'available',
  turns: ['近くで甘いもの食べたい'],
  ...overrides,
});

describe('evaluation Worker on the production ThreadDO', () => {
  it('runs a real Think turn against the fictional shops and records what the model did', async () => {
    const response = await post(caseOf());
    expect(response.status).toBe(200);
    const raw = await response.text();
    const parsed = v.safeParse(EvalRunResultSchema, JSON.parse(raw));
    if (!parsed.success) throw new Error('eval result does not match the contract');
    const [turn] = parsed.output.turns;

    expect(turn).toMatchObject({
      runStatus: 'completed',
      committed: true,
      kind: 'propose',
      messages: ['近くのカフェです。'],
      cards: [{ name: '架空 甘味処 こもれび', diff: null }],
    });
    expect(turn?.toolCalls.map((call) => [call.name, call.result?.status ?? null])).toEqual([
      ['search_places', 'ok'],
      ['respond', 'committed'],
    ]);
    // 1000m圏のカフェ3件だけが見え、恵比寿の店は含まれない。
    expect(turn?.toolCalls[0]?.result?.candidates).toBe(3);
    expect(turn?.modelCalls).toHaveLength(2);
    expect(turn?.respondMissing).toEqual([]);
    expect(turn?.toolResultsMatched).toBe(true);
    expect(turn?.evalError).toBeNull();
    expect(turn?.modelCalls.map((call) => call.failure)).toEqual([null, null]);
    // 結果には座標もローカル用のキーも出ない。
    expect(raw).not.toContain('35.658');
    expect(raw).not.toContain('eval-stub');
  });

  it('runs on the case clock even when it is after the real session expiry', async () => {
    // 本番はスレッド作成時刻を実際の時刻で保存する。評価では期限もケースの時刻から決めるため、
    // 実際の時刻より後の日時でも期限切れにならない。
    const response = await post(caseOf({ now: '2031-06-14T11:00:00.000Z' }));
    const parsed = v.parse(EvalRunResultSchema, await response.json());
    expect(parsed.turns[0]).toMatchObject({ runStatus: 'completed', committed: true });
  });

  it('runs each case on the production prompt unless a variant is given', async () => {
    const production = v.parse(
      EvalRunResultSchema,
      await (await post(caseOf({ turns: [`${ECHO_SYSTEM_MARKER} 確認`] }))).json(),
    );
    expect(production.turns[0]?.messages).toEqual([
      `system:${MODEL_SYSTEM_PROMPT.slice(0, ECHO_SYSTEM_LENGTH)}`,
    ]);

    const variant = v.parse(
      EvalRunResultSchema,
      await (
        await post(
          caseOf({ turns: [`${ECHO_SYSTEM_MARKER} 確認`], systemPrompt: '評価用の案です' }),
        )
      ).json(),
    );
    expect(variant.turns[0]?.messages).toEqual(['system:評価用の案です']);
    expect(variant.turns[0]?.kind).toBe('answer');
  });

  it('sends a tool description variant in place of the production description', async () => {
    const turnsOf = async (body: unknown) =>
      v.parse(EvalRunResultSchema, await (await post(body)).json()).turns;
    const production = await turnsOf(caseOf({ turns: [`${ECHO_TOOL_MARKER} 確認`] }));
    expect(production[0]?.messages[0]?.startsWith('tool:')).toBe(true);
    expect(production[0]?.messages[0]).not.toBe('tool:検索の案です');

    const variant = await turnsOf(
      caseOf({
        turns: [`${ECHO_TOOL_MARKER} 確認`],
        toolDescriptions: { search_places: '検索の案です' },
      }),
    );
    expect(variant[0]?.messages).toEqual(['tool:検索の案です']);
  });

  it('refuses invalid cases, unknown shop sets and a missing model key explicitly', async () => {
    const failureOf = async (response: Response) =>
      [response.status, v.parse(EvalFailureSchema, await response.json()).error] as const;

    expect(await failureOf(await post({ turns: [] }))).toEqual([400, 'INVALID_CASE']);
    expect(await failureOf(await post(caseOf({ shopSet: 'no-such-set' })))).toEqual([
      400,
      'UNKNOWN_SHOP_SET',
    ]);
    expect(await failureOf(await post(caseOf(), { ...evalEnv(), OPENAI_API_KEY: ' ' }))).toEqual([
      503,
      'OPENAI_API_KEY_MISSING',
    ]);
    expect(
      await failureOf(await evalWorker.fetch(new Request('http://eval.local/'), evalEnv())),
    ).toEqual([404, 'NOT_FOUND']);
  });

  it('reports readiness without exposing the key', async () => {
    const response = await evalWorker.fetch(new Request('http://eval.local/health'), evalEnv());
    // 識別子はProviderが起動時に--varで渡す。このテスト環境では未設定。
    expect(await response.json()).toEqual({
      ready: true,
      modelKeyConfigured: true,
      instance: null,
    });
  });
});
