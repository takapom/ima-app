import type { HotPepperShopWire } from '@worker/infrastructure/adapters/out/providers/hot-pepper/wire';

/**
 * ホットペッパーのwire形で書いた架空の店舗。評価結果はディスクに残るため、実在店舗のデータを
 * ここに置いてはいけない。そのことが一目で分かるよう、店名はすべて「架空」で始める。
 */
export type EvalShopSet = {
  /** 位置情報が取得できるケースで、ユーザーがいる地点。 */
  readonly origin: { readonly lat: number; readonly lng: number };
  readonly shops: readonly HotPepperShopWire[];
  /** trueなら偽ホットペッパーはすべての要求に503を返す。取得に失敗したときの振る舞いを測る。 */
  readonly providerUnavailable?: boolean;
};

export type ShopInput = {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly lat: number;
  readonly lng: number;
  readonly station: string;
  readonly genre: string;
  readonly catchText: string;
  readonly open: string;
  readonly close: string;
  readonly budget: string;
  readonly average: string;
  readonly nonSmoking: string;
  readonly privateRoom: string;
  readonly wifi: string;
};

export const shop = (input: ShopInput): HotPepperShopWire => ({
  id: input.id,
  name: input.name,
  address: input.address,
  lat: input.lat,
  lng: input.lng,
  open: input.open,
  close: input.close,
  budget: { code: null, name: input.budget, average: input.average, budget_memo: null },
  genre: { code: null, name: input.genre },
  // 本番の正規化はhotpepper.jpのURLだけを出典として認める。実在しないID（EVAL…）のページで、取得もしない。
  urls: { pc: `https://www.hotpepper.jp/str${input.id}/`, mobile: null },
  photo: null,
  catch: input.catchText,
  access: `${input.station}駅から徒歩圏内`,
  station_name: input.station,
  wifi: input.wifi,
  non_smoking: input.nonSmoking,
  private_room: input.privateRoom,
  parking: 'なし',
  other_memo: null,
  shop_detail_memo: null,
});
