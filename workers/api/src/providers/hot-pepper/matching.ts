import * as v from 'valibot';
import {
  HOT_PEPPER_MATCH_DISTANCE_METERS,
  HOT_PEPPER_MIN_NAME_SIMILARITY,
  HotPepperCandidateReferenceSchema,
  HotPepperError,
  type HotPepperCandidateReference,
} from './types';
import type { HotPepperShopWire } from './wire';

export type HotPepperMatchPolicy = {
  readonly maxDistanceMeters?: number;
  readonly minNameSimilarity?: number;
};

export type HotPepperShopMatch = {
  readonly shop: HotPepperShopWire;
  readonly distanceMeters: number;
  readonly nameSimilarity: number;
};

const finite = (value: number): boolean => Number.isFinite(value);

const normalizedName = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '');

const nameTokens = (value: string): ReadonlySet<string> => {
  const normalized = normalizedName(value);
  const words = normalized.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  if (words.length > 1) return new Set(words);
  const word = words[0] ?? '';
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(word)) {
    return new Set(Array.from(word));
  }
  return new Set(word.length === 0 ? [] : [word]);
};

export const hotPepperNameSimilarity = (left: string, right: string): number => {
  const leftName = normalizedName(left);
  const rightName = normalizedName(right);
  if (leftName.length === 0 || rightName.length === 0) return 0;
  if (leftName === rightName) return 1;
  const leftTokens = nameTokens(left);
  const rightTokens = nameTokens(right);
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
};

/** Haversine is used only to reject an HP overlay; it is never returned as walking time. */
export const hotPepperDistanceMeters = (
  left: Pick<HotPepperCandidateReference, 'lat' | 'lng'>,
  right: Pick<HotPepperShopWire, 'lat' | 'lng'>,
): number | undefined => {
  if (right.lat === null || right.lng === null) return undefined;
  const latitudeOne = (left.lat * Math.PI) / 180;
  const latitudeTwo = (right.lat * Math.PI) / 180;
  const deltaLatitude = ((right.lat - left.lat) * Math.PI) / 180;
  const deltaLongitude = ((right.lng - left.lng) * Math.PI) / 180;
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeOne) * Math.cos(latitudeTwo) * Math.sin(deltaLongitude / 2) ** 2;
  const distance = 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return finite(distance) ? distance : undefined;
};

const policyValue = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const result = value ?? fallback;
  if (!finite(result) || result < minimum || result > maximum) {
    throw new HotPepperError('INVALID_REQUEST');
  }
  return result;
};

const validateCandidate = (candidate: HotPepperCandidateReference): HotPepperCandidateReference => {
  const parsed = v.safeParse(HotPepperCandidateReferenceSchema, candidate);
  if (!parsed.success) throw new HotPepperError('INVALID_REQUEST');
  return parsed.output;
};

const nameMatches = (
  candidate: HotPepperCandidateReference,
  shop: HotPepperShopWire,
  minimumNameSimilarity: number,
): number =>
  hotPepperNameSimilarity(candidate.name, shop.name) >= minimumNameSimilarity
    ? hotPepperNameSimilarity(candidate.name, shop.name)
    : 0;

const sameNameShops = (
  candidate: HotPepperCandidateReference,
  shops: readonly HotPepperShopWire[],
  minimumNameSimilarity: number,
): readonly { readonly shop: HotPepperShopWire; readonly similarity: number }[] =>
  shops.flatMap((shop) => {
    // Fuzzy similarity is diagnostic only. Branches such as "東口店" and "西口店"
    // must not become interchangeable merely because they share most characters.
    if (normalizedName(candidate.name) !== normalizedName(shop.name)) return [];
    const similarity = nameMatches(candidate, shop, minimumNameSimilarity);
    return similarity === 0 ? [] : [{ shop, similarity }];
  });

/**
 * Selects one overlay only when both name similarity and provider coordinates agree.
 * A same-name branch is never selected by itself, and a previously verified record
 * cannot silently follow a relocation to another provider record.
 */
export const matchHotPepperShop = (
  candidateInput: HotPepperCandidateReference,
  shops: readonly HotPepperShopWire[],
  policy: HotPepperMatchPolicy = {},
): HotPepperShopMatch => {
  const candidate = validateCandidate(candidateInput);
  const maxDistanceMeters = policyValue(
    policy.maxDistanceMeters,
    HOT_PEPPER_MATCH_DISTANCE_METERS,
    0.001,
    500,
  );
  const minNameSimilarity = policyValue(
    policy.minNameSimilarity,
    HOT_PEPPER_MIN_NAME_SIMILARITY,
    HOT_PEPPER_MIN_NAME_SIMILARITY,
    1,
  );
  const named = sameNameShops(candidate, shops, minNameSimilarity);

  if (candidate.hotPepperRecordRef !== undefined) {
    const expectedShop = shops.find((shop) => shop.id === candidate.hotPepperRecordRef);
    if (expectedShop === undefined) {
      throw new HotPepperError('SOURCE_CONFLICT');
    }
    const expectedSimilarity = nameMatches(candidate, expectedShop, minNameSimilarity);
    if (expectedSimilarity === 0) {
      throw new HotPepperError('SOURCE_CONFLICT');
    }
    const distance = hotPepperDistanceMeters(candidate, expectedShop);
    if (distance === undefined || distance >= maxDistanceMeters) {
      throw new HotPepperError('SOURCE_CONFLICT');
    }
    return { shop: expectedShop, distanceMeters: distance, nameSimilarity: expectedSimilarity };
  }

  if (named.length === 0) throw new HotPepperError('NO_MATCH');

  const nearby = named.flatMap(({ shop, similarity }) => {
    const distance = hotPepperDistanceMeters(candidate, shop);
    return distance !== undefined && distance < maxDistanceMeters
      ? [{ shop, distance, similarity }]
      : [];
  });
  if (nearby.length === 0) throw new HotPepperError('NO_MATCH');
  if (nearby.length > 1) throw new HotPepperError('AMBIGUOUS_MATCH');
  const match = nearby[0];
  if (match === undefined) throw new HotPepperError('NO_MATCH');
  return {
    shop: match.shop,
    distanceMeters: match.distance,
    nameSimilarity: match.similarity,
  };
};
