import {
  HotPepperError,
  type HotPepperFacilitiesSupplement,
  type HotPepperFacilityValue,
  type HotPepperFieldResult,
  type HotPepperPriceSupplement,
} from '@worker/infrastructure/adapters/outbound/providers/hot-pepper/types';
import type { HotPepperShopWire } from '@worker/infrastructure/adapters/outbound/providers/hot-pepper/wire';

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

/**
 * Hot Pepper states a facility as a short verdict, optionally followed by a free-form note after
 * a full-width colon ("なし ：近隣のコインパーキングをご利用ください"). Only the verdict decides the
 * value; the note stays in `sourceText`. Smoking uses its own vocabulary and never the yes/no one.
 */
const facilityVerdict = (value: string): string => {
  const [verdict] = value.normalize('NFKC').split(':', 1);
  return (verdict ?? '').trim().toLocaleLowerCase('ja-JP');
};

const facilityValueFor = (value: unknown): HotPepperFacilityValue => {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value !== 'string') return 'unknown';
  const normalized = facilityVerdict(value);
  if (['yes', 'true', 'あり', '有', '可', '○', 'o', '全面禁煙'].includes(normalized)) return 'yes';
  if (['no', 'false', 'なし', '無', '不可', '×', 'x', '禁煙席なし'].includes(normalized)) {
    return 'no';
  }
  if (['partial', '一部', '条件あり', '場合による', '一部禁煙', '分煙'].includes(normalized)) {
    return 'partial';
  }
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
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.hostname !== 'hotpepper.jp' && !url.hostname.endsWith('.hotpepper.jp'))
    ) {
      return null;
    }
    url.protocol = 'https:';
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
