import { shibuyaEbisu } from './shibuya-ebisu';
import { shinjuku } from './shinjuku';
import type { EvalShopSet } from './shop';

export type { EvalShopSet } from './shop';

/** 取得に失敗し続ける構成。店舗は返らず、検索はすべて失敗する。 */
const providerDown: EvalShopSet = {
  origin: shibuyaEbisu.origin,
  shops: [],
  providerUnavailable: true,
};

export const EVAL_SHOP_SETS: Readonly<Record<string, EvalShopSet>> = {
  'shibuya-ebisu': shibuyaEbisu,
  shinjuku,
  'provider-down': providerDown,
};

export const evalShopSetFor = (name: string): EvalShopSet | undefined =>
  Object.hasOwn(EVAL_SHOP_SETS, name) ? EVAL_SHOP_SETS[name] : undefined;
