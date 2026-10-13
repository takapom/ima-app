import { HOT_PEPPER_GOURMET_ENDPOINT } from '@worker/adapters/out/providers/hot-pepper/types';
import type { HotPepperShopWire } from '@worker/adapters/out/providers/hot-pepper/wire';
import type { EvalShopSet } from './shops/shop-sets';

/** ホットペッパーの`range`の値と、公式資料にある半径。 */
const RANGE_METERS: Readonly<Record<string, number>> = {
  '1': 300,
  '2': 500,
  '3': 1000,
  '4': 2000,
  '5': 3000,
};

const endpoint = new URL(HOT_PEPPER_GOURMET_ENDPOINT);

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase();

/** 公式資料にあるkeywordの検索対象（店名・住所・駅名・ジャンル・キャッチ）。 */
const searchableText = (shop: HotPepperShopWire): string =>
  normalize(
    [shop.name, shop.address, shop.station_name, shop.genre?.name, shop.catch]
      .filter((value): value is string => typeof value === 'string')
      .join(' '),
  );

const distanceMeters = (
  from: { readonly lat: number; readonly lng: number },
  to: HotPepperShopWire,
): number | undefined => {
  if (to.lat === null || to.lng === null) return undefined;
  const radians = Math.PI / 180;
  const a =
    Math.sin(((to.lat - from.lat) * radians) / 2) ** 2 +
    Math.cos(from.lat * radians) *
      Math.cos(to.lat * radians) *
      Math.sin(((to.lng - from.lng) * radians) / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
};

const positiveInteger = (value: string | null, fallback: number): number | undefined => {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
};

const providerError = (message: string) => ({
  results: { error: [{ code: 3000, message }] },
});

/**
 * 合成店舗に対して、グルメサーチAPIと同じ意味で1回の検索に答える。
 * keywordは空白区切りの部分一致AND、座標は`range`の半径で絞り、`start`/`count`でページを切る。
 * 全店を返すと、モデルの検索語の良し悪しを測れなくなる。
 */
export const searchEvalShops = (shops: readonly HotPepperShopWire[], params: URLSearchParams) => {
  let matched = [...shops];
  const ids = params.get('id');
  if (ids !== null) {
    const wanted = new Set(ids.split(','));
    matched = matched.filter((shop) => wanted.has(shop.id));
  }
  const keyword = params.get('keyword');
  if (keyword !== null) {
    const terms = normalize(keyword).split(/\s+/u).filter(Boolean);
    matched = matched.filter((shop) => {
      const text = searchableText(shop);
      return terms.every((term) => text.includes(term));
    });
  }
  const lat = params.get('lat');
  const lng = params.get('lng');
  if (lat !== null || lng !== null) {
    // 片方だけの座標は、欠けた側を0として検索せず、本物と同じく不正な要求として返す。
    if (lat === null || lng === null) return providerError('invalid location condition');
    const origin = { lat: Number(lat), lng: Number(lng) };
    const radius = RANGE_METERS[params.get('range') ?? '1'];
    if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) || radius === undefined) {
      return providerError('invalid location condition');
    }
    matched = matched.filter((shop) => {
      const meters = distanceMeters(origin, shop);
      return meters !== undefined && meters <= radius;
    });
  }
  const start = positiveInteger(params.get('start'), 1);
  const count = positiveInteger(params.get('count'), 10);
  if (start === undefined || count === undefined) return providerError('invalid page condition');
  const page = matched.slice(start - 1, start - 1 + count);
  return {
    results: {
      results_available: matched.length,
      results_returned: String(page.length),
      // 本物の応答と同じく、空のページの開始位置は0。
      results_start: page.length === 0 ? 0 : start,
      shop: page,
    },
  };
};

/** グルメサーチAPIの宛先だけに答えるfetch。それ以外の宛先はすべて拒否する。 */
export const createHotPepperStub =
  (set: EvalShopSet): typeof fetch =>
  (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      request.method !== 'GET' ||
      url.origin !== endpoint.origin ||
      url.pathname !== endpoint.pathname
    ) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    // 取得に失敗するケースでは、本物の障害と同じくサーバーエラーを返す。
    if (set.providerUnavailable === true) {
      return Promise.resolve(new Response(null, { status: 503 }));
    }
    return Promise.resolve(Response.json(searchEvalShops(set.shops, url.searchParams)));
  };
