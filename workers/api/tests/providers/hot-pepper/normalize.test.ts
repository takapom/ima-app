import { describe, expect, it } from 'vitest';
import { normalizeHotPepperOpeningHours } from '../../../src/providers/hot-pepper/normalize';
import {
  parseHotPepperResponse,
  type HotPepperShopWire,
} from '../../../src/providers/hot-pepper/wire';

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

describe('Hot Pepper opening-hours normalization', () => {
  it('withholds same-clock LO values with different day qualifiers', () => {
    expect(
      normalizeHotPepperOpeningHours(
        shopFor('17:00〜翌0:00（料理 L.O. 23:00 ドリンク L.O. 翌23:00）'),
      ),
    ).toEqual({
      status: 'unknown',
      reason: 'Hot Pepper last-order text is not unambiguous',
    });
  });

  it.each([
    '17:00〜翌0:00（料理 L.O. 23:00 ドリンク L.O. 23:00）',
    '17:00〜翌0:00（料理 L.O. 翌23:00 ドリンク L.O. 翌23:00）',
  ])('keeps repeated equivalent LO qualifiers: %s', (open) => {
    expect(normalizeHotPepperOpeningHours(shopFor(open))).toMatchObject({
      status: 'known',
      value: { lastOrderAt: null },
    });
  });
});
