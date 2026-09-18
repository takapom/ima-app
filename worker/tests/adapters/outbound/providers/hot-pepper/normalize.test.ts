import { describe, expect, it } from 'vitest';
import {
  normalizeHotPepperPrice,
  normalizeHotPepperFacilities,
  hotPepperSourceFor,
} from '@worker/infrastructure/adapters/outbound/providers/hot-pepper/normalize';
import {
  parseHotPepperResponse,
  type HotPepperShopWire,
} from '@worker/infrastructure/adapters/outbound/providers/hot-pepper/wire';

const shopFor = (open: string): HotPepperShopWire => {
  const parsed = parseHotPepperResponse({
    results: {
      shop: [
        {
          id: 'hp-normalize-1',
          name: '正規化テスト店',
          lat: 35.6468,
          lng: 139.71,
          open,
          close: '無休',
          urls: { pc: 'https://www.hotpepper.jp/strJ000000001' },
        },
      ],
    },
  });
  const shop = parsed.shops[0];
  if (shop === undefined) throw new Error('normalize fixture shop is missing');
  return shop;
};

describe('Hot Pepper normalized facts', () => {
  it('preserves budget text without inferring a currency or unit', () => {
    expect(
      normalizeHotPepperPrice({
        ...shopFor('不明'),
        budget: { name: '昼の目安', average: '1000〜2000円' },
      }),
    ).toEqual({
      status: 'known',
      value: { budgetLabel: '昼の目安', averageLabel: '1000〜2000円', unit: 'unknown' },
    });
  });
  it('normalizes an official HTTP source link to HTTPS', () => {
    expect(
      hotPepperSourceFor({
        ...shopFor('不明'),
        urls: { pc: 'http://www.hotpepper.jp/strJ000000001/' },
      }).publicUrl,
    ).toBe('https://www.hotpepper.jp/strJ000000001/');
  });
  it('keeps unspecified budget and facilities unknown', () => {
    expect(normalizeHotPepperPrice(shopFor('不明')).status).toBe('unknown');
    expect(normalizeHotPepperFacilities(shopFor('不明')).status).toBe('unknown');
  });

  // The live API answers non_smoking with its own vocabulary and never with あり/なし.
  it('reads the listed smoking vocabulary instead of dropping it to unknown', () => {
    const smoking = (value: string) =>
      normalizeHotPepperFacilities({ ...shopFor('不明'), non_smoking: value });

    expect(smoking('全面禁煙')).toMatchObject({ status: 'known', value: { nonSmoking: 'yes' } });
    expect(smoking('一部禁煙')).toMatchObject({
      status: 'known',
      value: { nonSmoking: 'partial' },
    });
    expect(smoking('禁煙席なし')).toMatchObject({ status: 'known', value: { nonSmoking: 'no' } });
  });

  // A verdict can carry a free-form note after a full-width colon; only the verdict decides.
  it('decides on the verdict and keeps the note as source text', () => {
    const result = normalizeHotPepperFacilities({
      ...shopFor('不明'),
      parking: 'なし ：目の前にコインパーキングあります！',
      private_room: 'あり ：2名様からご利用可能な掘り炬燵席をご用意',
    });

    expect(result).toMatchObject({
      status: 'known',
      value: { parking: 'no', privateRoom: 'yes' },
    });
    if (result.status !== 'known') throw new Error('facilities fixture must be known');
    expect(result.value.sourceText).toContain('なし ：目の前にコインパーキングあります！');
  });
});
