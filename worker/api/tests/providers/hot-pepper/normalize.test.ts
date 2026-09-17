import { describe, expect, it } from 'vitest';
import {
  normalizeHotPepperPrice,
  normalizeHotPepperFacilities,
  hotPepperSourceFor,
} from '@api/providers/hot-pepper/normalize';
import { parseHotPepperResponse, type HotPepperShopWire } from '@api/providers/hot-pepper/wire';

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
});
