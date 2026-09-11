import {
  HotPepperError,
  type HotPepperFacilitiesSupplement,
  type HotPepperFacilityValue,
  type HotPepperFieldResult,
  type HotPepperOpeningHoursSupplement,
  type HotPepperPriceSupplement,
} from './types';
import type { HotPepperShopWire } from './wire';

type Normalized<T> = Exclude<HotPepperFieldResult<T>, { readonly status: 'unsupported' }>;

const unknownValue = <T>(reason: string): Normalized<T> => ({ status: 'unknown', reason });
const errorValue = <T>(
  code: 'SCHEMA_MISMATCH' | 'SOURCE_CONFLICT',
  reason: string,
): Normalized<T> => ({ status: 'error', code, reason });

const boundedText = (value: string | null | undefined, maxLength: number): string | null => {
  if (value === undefined || value === null || value.trim().length === 0) return null;
  return value.length <= maxLength ? value : null;
};

const markerForLastOrder = /(?:L(?:[.．]\s*)?O(?:[.．])?|ラストオーダー)/iu;
const lastOrderTime =
  /(?:(?:料理|ドリンク)\s*)?(?:L(?:[.．]\s*)?O(?:[.．])?|ラストオーダー)\s*[:：]?\s*(?:翌\s*)?\d{1,2}[:：]\d{2}/giu;
const clockTime = /(?:翌\s*)?(\d{1,2})[:：](\d{2})/u;
type InvalidLastOrder = { readonly kind: 'invalid' };
const invalidLastOrder: InvalidLastOrder = { kind: 'invalid' };

const lastOrderFor = (source: string | null): string | null | InvalidLastOrder => {
  if (source === null) return null;
  if (!markerForLastOrder.test(source)) return null;
  const matches = [...source.matchAll(lastOrderTime)].map((match) => match[0]);
  if (matches.length === 0) return invalidLastOrder;
  const times = matches.map((match) => clockTime.exec(match));
  if (times.some((match) => match === null || Number(match[1]) > 29 || Number(match[2]) > 59)) {
    return invalidLastOrder;
  }
  const distinct = new Set(times.map((match) => `${match?.[1] ?? ''}:${match?.[2] ?? ''}`));
  return distinct.size === 1 ? (matches[0] ?? invalidLastOrder) : invalidLastOrder;
};

/** Normalizes only explicit LO markers; HP `close` is a regular-holiday field. */
export const normalizeHotPepperOpeningHours = (
  shop: HotPepperShopWire,
): Normalized<HotPepperOpeningHoursSupplement> => {
  const openText = boundedText(shop.open, 300);
  const regularHolidayText = boundedText(shop.close, 300);
  const orderSource = boundedText(shop.last_order, 160) ?? boundedText(shop.open, 2_000);
  const lastOrder = lastOrderFor(orderSource);
  if (lastOrder === invalidLastOrder) {
    return unknownValue('Hot Pepper last-order text is not unambiguous');
  }
  if (openText === null && regularHolidayText === null && lastOrder === null) {
    return unknownValue('Hot Pepper opening or last-order data is missing');
  }
  return {
    status: 'known',
    value: {
      openText,
      regularHolidayText,
      lastOrderRaw: typeof lastOrder === 'string' ? lastOrder : null,
      lastOrderAt: null,
    },
  };
};

export const normalizeHotPepperPrice = (
  shop: HotPepperShopWire,
): Normalized<HotPepperPriceSupplement> => {
  const budget = shop.budget;
  const budgetLabel = boundedText(budget?.name, 160);
  const averageLabel = boundedText(budget?.average, 160);
  if (budgetLabel === null && averageLabel === null) {
    return unknownValue('Hot Pepper budget data is missing');
  }
  return {
    status: 'known',
    value: { budgetLabel, averageLabel, unit: 'unknown' },
  };
};

const facilityValueFor = (value: unknown): HotPepperFacilityValue => {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
  if (['yes', 'true', 'あり', '有', '可', '○', 'o'].includes(normalized)) return 'yes';
  if (['no', 'false', 'なし', '無', '不可', '×', 'x'].includes(normalized)) return 'no';
  if (['partial', '一部', '条件あり', '場合による'].includes(normalized)) return 'partial';
  return 'unknown';
};

const sourceTextFor = (shop: HotPepperShopWire): readonly string[] => {
  const values = [shop.wifi, shop.non_smoking, shop.private_room, shop.parking].flatMap((value) =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 300 ? [value] : [],
  );
  return [...new Set(values)].slice(0, 4);
};

export const normalizeHotPepperFacilities = (
  shop: HotPepperShopWire,
): Normalized<HotPepperFacilitiesSupplement> => {
  const value: HotPepperFacilitiesSupplement = {
    wifi: facilityValueFor(shop.wifi),
    nonSmoking: facilityValueFor(shop.non_smoking),
    privateRoom: facilityValueFor(shop.private_room),
    parking: facilityValueFor(shop.parking),
    sourceText: sourceTextFor(shop),
  };
  if (
    value.sourceText.length === 0 &&
    [value.wifi, value.nonSmoking, value.privateRoom, value.parking].every(
      (item) => item === 'unknown',
    )
  ) {
    return unknownValue('Hot Pepper facility data is missing or not explicit');
  }
  return { status: 'known', value };
};

const officialHotPepperUrl = (shop: HotPepperShopWire): string | null => {
  const raw = shop.urls?.pc ?? shop.urls?.mobile;
  if (raw === undefined || raw === null || raw.trim().length === 0) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.hostname !== 'hotpepper.jp' && !url.hostname.endsWith('.hotpepper.jp'))
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
};

export const hotPepperSourceFor = (
  shop: HotPepperShopWire,
): { readonly recordRef: string; readonly publicUrl: string } => {
  const raw = shop.urls?.pc ?? shop.urls?.mobile;
  const publicUrl = officialHotPepperUrl(shop);
  if (publicUrl === null) {
    throw new HotPepperError(
      raw === undefined || raw === null || raw.trim().length === 0
        ? 'MISSING_ATTRIBUTION'
        : 'SOURCE_CONFLICT',
    );
  }
  return { recordRef: shop.id, publicUrl };
};

export const invalidHotPepperField = <T>(reason: string): HotPepperFieldResult<T> =>
  errorValue<T>('SCHEMA_MISMATCH', reason);
