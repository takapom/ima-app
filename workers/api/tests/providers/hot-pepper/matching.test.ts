import { describe, expect, it } from 'vitest';
import {
  hotPepperDistanceMeters,
  hotPepperNameSimilarity,
  matchHotPepperShop,
} from '../../../src/providers/hot-pepper/matching';
import type {
  HotPepperCandidateReference,
  HotPepperError,
} from '../../../src/providers/hot-pepper/types';
import {
  parseHotPepperResponse,
  type HotPepperShopWire,
} from '../../../src/providers/hot-pepper/wire';

const candidate: HotPepperCandidateReference = {
  candidateId: 'candidate-1',
  name: 'カフェ恵比寿',
  lat: 35.6467,
  lng: 139.71,
};

const shop = (
  id: string,
  name = 'カフェ恵比寿',
  lat: number | null = 35.6468,
  lng: number | null = 139.71,
): HotPepperShopWire => {
  const parsed = parseHotPepperResponse({
    results: {
      shop: [
        {
          id,
          name,
          lat,
          lng,
          urls: { pc: 'https://www.hotpepper.jp/strJ000000001' },
        },
      ],
    },
  });
  const value = parsed.shops[0];
  if (value === undefined) throw new Error('fixture shop is missing');
  return value;
};

const expectCode = (callback: () => unknown, code: HotPepperError['code']): void => {
  try {
    callback();
    throw new Error('expected Hot Pepper matching failure');
  } catch (error: unknown) {
    expect(error).toMatchObject({ code });
  }
};

describe('Hot Pepper candidate matching', () => {
  it('normalizes harmless punctuation differences while retaining a strict name match', () => {
    expect(hotPepperNameSimilarity(' カフェ・恵比寿 ', 'カフェ恵比寿')).toBe(1);
    const result = matchHotPepperShop(candidate, [shop('hp-1', 'カフェ・恵比寿')]);
    expect(result.shop.id).toBe('hp-1');
    expect(result.nameSimilarity).toBe(1);
    expect(result.distanceMeters).toBeLessThan(50);
  });

  it('does not select a same-name branch from fuzzy similarity alone', () => {
    const branch = shop('hp-east', 'カフェ恵比寿東', 35.64671, 139.71);
    expect(hotPepperNameSimilarity(candidate.name, branch.name)).toBeGreaterThanOrEqual(0.8);
    expectCode(() => matchHotPepperShop(candidate, [branch]), 'NO_MATCH');
  });

  it('rejects two exact-name shops inside the location threshold as ambiguous', () => {
    expectCode(
      () =>
        matchHotPepperShop(candidate, [
          shop('hp-east', 'カフェ恵比寿', 35.64671, 139.71),
          shop('hp-west', 'カフェ恵比寿', 35.64672, 139.71),
        ]),
      'AMBIGUOUS_MATCH',
    );
  });

  it('rejects a far branch and a provider item without coordinates', () => {
    expectCode(
      () => matchHotPepperShop(candidate, [shop('hp-far', 'カフェ恵比寿', 35.65, 139.71)]),
      'NO_MATCH',
    );
    expectCode(
      () => matchHotPepperShop(candidate, [shop('hp-no-location', 'カフェ恵比寿', null, null)]),
      'NO_MATCH',
    );
  });

  it('uses a verified provider reference to distinguish a branch', () => {
    const withReference = { ...candidate, hotPepperRecordRef: 'hp-west' };
    const result = matchHotPepperShop(withReference, [
      shop('hp-east', 'カフェ恵比寿', 35.64671, 139.71),
      shop('hp-west', 'カフェ恵比寿', 35.64672, 139.71),
    ]);
    expect(result.shop.id).toBe('hp-west');
  });

  it('reports relocation, missing records, and name changes as source conflicts', () => {
    const withReference = { ...candidate, hotPepperRecordRef: 'hp-old' };
    expectCode(
      () => matchHotPepperShop(withReference, [shop('hp-new', 'カフェ恵比寿')]),
      'SOURCE_CONFLICT',
    );
    expectCode(
      () => matchHotPepperShop(withReference, [shop('hp-old', '別の店')]),
      'SOURCE_CONFLICT',
    );
    expectCode(
      () => matchHotPepperShop(withReference, [shop('hp-old', 'カフェ恵比寿', 35.6467, 139.711)]),
      'SOURCE_CONFLICT',
    );
  });

  it('never presents straight-line distance as a route measurement', () => {
    const distance = hotPepperDistanceMeters(candidate, shop('hp-1'));
    expect(distance).toBeDefined();
    expect(distance).toBeLessThan(50);
  });
});
