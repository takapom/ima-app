import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  HotPepperShopWireSchema,
  parseHotPepperResponse,
} from '@worker/infrastructure/adapters/out/providers/hot-pepper/wire';
import { HOT_PEPPER_GOURMET_ENDPOINT } from '@worker/infrastructure/adapters/out/providers/hot-pepper/types';
import { createHotPepperStub } from '../../tooling/eval/hotpepper-stub';
import { EVAL_SHOP_SETS, evalShopSetFor } from '../../tooling/eval/shops/shop-sets';

const set = EVAL_SHOP_SETS['shibuya-ebisu'];
if (set === undefined) throw new Error('shibuya-ebisu shop set is missing');

const search = async (params: Record<string, string>) => {
  const url = new URL(HOT_PEPPER_GOURMET_ENDPOINT);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await createHotPepperStub(set)(url.toString());
  // 偽物の応答は本番のparserで読めなければ、評価として意味がない。
  return parseHotPepperResponse(await response.json());
};

const names = (page: Awaited<ReturnType<typeof search>>) => page.shops.map((shop) => shop.name);

describe('evaluation shop sets', () => {
  it('holds only fictional shops in the production wire shape', () => {
    // 店舗IDはセットをまたいでも重ならない。
    const ids = Object.values(EVAL_SHOP_SETS).flatMap((shopSet) =>
      shopSet.shops.map((shop) => shop.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const shopSet of Object.values(EVAL_SHOP_SETS)) {
      for (const shop of shopSet.shops) {
        expect(v.safeParse(HotPepperShopWireSchema, shop).success).toBe(true);
        expect(shop.name.startsWith('架空 ')).toBe(true);
      }
    }
  });

  it('resolves only declared set names', () => {
    expect(evalShopSetFor('shibuya-ebisu')).toBe(set);
    expect(evalShopSetFor('toString')).toBeUndefined();
    expect(evalShopSetFor('unknown-set')).toBeUndefined();
  });
});

describe('createHotPepperStub', () => {
  it('requires every keyword term to match, as the provider does', async () => {
    expect(names(await search({ keyword: 'バー 恵比寿' }))).toEqual([
      '架空 ダイニングバー 夜長',
      '架空 ワインバー 灯台',
    ]);
    expect(names(await search({ keyword: 'カフェ　恵比寿' }))).toEqual(['架空 カフェ 青い窓']);
    // 掲載にない気分の言葉では何も見つからない。偽物は全店を返さない。
    expect(names(await search({ keyword: 'まったり' }))).toEqual([]);
    expect(names(await search({ keyword: 'スープカレー 札幌' }))).toEqual([]);
  });

  it('filters by the documented range radius around the given coordinates', async () => {
    const near = await search({
      keyword: 'カフェ',
      lat: String(set.origin.lat),
      lng: String(set.origin.lng),
      range: '3',
    });
    expect(names(near)).toEqual([
      '架空 甘味処 こもれび',
      '架空 珈琲店 ひだまり',
      '架空 パティスリー 月と星',
    ]);

    const wide = await search({
      keyword: 'カフェ',
      lat: String(set.origin.lat),
      lng: String(set.origin.lng),
      range: '5',
    });
    expect(names(wide)).toContain('架空 カフェ 青い窓');
  });

  it('pages matches with start and count and reports the total', async () => {
    const first = await search({ keyword: '渋谷区', count: '3' });
    expect(first.shops).toHaveLength(3);
    expect(first.resultsAvailable).toBe(10);
    expect(first.resultsStart).toBe(1);

    const last = await search({ keyword: '渋谷区', count: '3', start: '10' });
    expect(names(last)).toEqual(['架空 カフェ 青い窓']);

    const beyond = await search({ keyword: '渋谷区', start: '11' });
    expect(beyond.shops).toEqual([]);
    expect(beyond.resultsStart).toBe(0);
  });

  it('looks shops up by id', async () => {
    expect(names(await search({ id: 'EVAL0002,EVAL0009' }))).toEqual([
      '架空 珈琲店 ひだまり',
      '架空 ワインバー 灯台',
    ]);
  });

  it('reports a provider error for an invalid range instead of returning shops', async () => {
    await expect(
      search({ lat: String(set.origin.lat), lng: String(set.origin.lng), range: '9' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('reports a provider error when only one coordinate is given', async () => {
    await expect(search({ lat: String(set.origin.lat), range: '3' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('answers every search with a server error for the provider-down set', async () => {
    const down = evalShopSetFor('provider-down');
    if (down === undefined) throw new Error('provider-down shop set is missing');
    const url = new URL(HOT_PEPPER_GOURMET_ENDPOINT);
    url.searchParams.set('keyword', 'カフェ');
    expect((await createHotPepperStub(down)(url.toString())).status).toBe(503);
  });

  it('finds the many izakaya of the Shinjuku set by area name', async () => {
    const shinjuku = evalShopSetFor('shinjuku');
    if (shinjuku === undefined) throw new Error('shinjuku shop set is missing');
    const url = new URL(HOT_PEPPER_GOURMET_ENDPOINT);
    url.searchParams.set('keyword', '居酒屋 新宿');
    const page = parseHotPepperResponse(
      await (await createHotPepperStub(shinjuku)(url.toString())).json(),
    );
    // 指示を混ぜた店（EVAL1006）も、居酒屋として検索結果に現れる。
    expect(page.shops.map((shop) => shop.id)).toEqual([
      'EVAL1001',
      'EVAL1002',
      'EVAL1003',
      'EVAL1004',
      'EVAL1005',
      'EVAL1006',
      'EVAL1012',
    ]);
  });

  it('refuses every request outside the Gourmet Search endpoint', async () => {
    const stub = createHotPepperStub(set);
    expect((await stub('https://api.openai.com/v1/responses')).status).toBe(404);
    expect((await stub(HOT_PEPPER_GOURMET_ENDPOINT, { method: 'POST' })).status).toBe(404);
  });
});
