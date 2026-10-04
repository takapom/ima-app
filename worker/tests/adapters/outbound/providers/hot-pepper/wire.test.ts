import { describe, expect, it } from 'vitest';
import { HotPepperError } from '@worker/adapters/out/providers/hot-pepper/types';
import { parseHotPepperResponse } from '@worker/adapters/out/providers/hot-pepper/wire';

const shop = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'hp-1',
  name: 'カフェ恵比寿',
  address: '東京都渋谷区恵比寿1-1-1',
  lat: 35.6467,
  lng: 139.71,
  open: '月〜日 17:00〜翌0:00（料理L.O. 23:00）',
  close: '無休',
  last_order: null,
  budget: {
    code: 'B001',
    name: '2001〜3000円',
    average: '2500円',
    budget_memo: '原文メモ',
  },
  genre: { code: 'G001', name: 'カフェ・スイーツ' },
  urls: { pc: 'https://www.hotpepper.jp/strJ000000001', mobile: null },
  catch: '落ち着いた店内',
  access: '駅から徒歩数分',
  wifi: 'あり',
  non_smoking: 'なし',
  private_room: '一部',
  parking: false,
  other_memo: '補足',
  shop_detail_memo: '詳細補足',
  unexpected: 'must be stripped',
  ...overrides,
});

describe('Hot Pepper wire boundary', () => {
  it('accepts the documented envelope and strips fields outside the allowlist', () => {
    const parsed = parseHotPepperResponse({
      results: {
        results_available: 1,
        results_returned: 1,
        results_start: 1,
        shop: [shop()],
        unexpected: 'drop',
      },
      unexpected: 'drop',
    });

    expect(parsed.resultsAvailable).toBe(1);
    expect(parsed.resultsStart).toBe(1);
    expect(parsed.shops).toHaveLength(1);
    expect(parsed.shops[0]).not.toHaveProperty('unexpected');
    expect(parsed.shops[0]?.budget).toEqual({
      code: 'B001',
      name: '2001〜3000円',
      average: '2500円',
      budget_memo: '原文メモ',
    });
  });

  it('keeps an empty successful page distinct from a malformed page', () => {
    expect(
      parseHotPepperResponse({ results: { results_available: 0, results_returned: 0, shop: [] } }),
    ).toEqual({ resultsAvailable: 0, resultsStart: null, shops: [] });
    // The live API starts an empty page at 0 (#66).
    expect(
      parseHotPepperResponse({
        results: {
          api_version: '1.30',
          results_available: 0,
          results_returned: '0',
          results_start: 0,
          shop: [],
        },
      }),
    ).toEqual({ resultsAvailable: 0, resultsStart: 0, shops: [] });
    expect(() => parseHotPepperResponse({ results: { shop: 'invalid' } })).toThrowError(
      HotPepperError,
    );
    try {
      parseHotPepperResponse({ results: { shop: 'invalid' } });
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'SCHEMA_MISMATCH' });
    }
  });

  it('maps the API error envelope without exposing its message', () => {
    expect(() =>
      parseHotPepperResponse({
        results: { error: [{ code: 2000, message: 'private key and request details' }] },
      }),
    ).toThrowError(new HotPepperError('INVALID_REQUEST'));
    try {
      parseHotPepperResponse({
        results: { error: [{ code: 1000, message: 'provider secret response' }] },
      });
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect(error).not.toHaveProperty('message', 'provider secret response');
      expect(String(error)).not.toContain('provider secret response');
    }
  });

  it('rejects invalid coordinates and unbounded provider text at the wire edge', () => {
    expect(() => parseHotPepperResponse({ results: { shop: [shop({ lat: 91 })] } })).toThrowError(
      HotPepperError,
    );
    expect(() =>
      parseHotPepperResponse({ results: { shop: [shop({ name: 'x'.repeat(161) })] } }),
    ).toThrowError(HotPepperError);
  });
});
