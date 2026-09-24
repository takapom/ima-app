export const DEV_FIXTURE_PLACE_ID = 'dev-fixture-place';
export const DEV_FIXTURE_PHOTO_REF = 'fixture-photo';

/** A fictional restaurant in the same wire format as the live Hot Pepper API. */
export const fixturePlace = (_clock: () => string): Record<string, unknown> => ({
  id: DEV_FIXTURE_PLACE_ID,
  name: '灯り坂ラウンジ（サンプル）',
  address: '東京都渋谷区恵比寿・架空のサンプル店舗',
  lat: 35.6467,
  lng: 139.7102,
  genre: { name: 'カフェ' },
  catch: '灯りを落とした静かなラウンジ（サンプル）',
  station_name: '恵比寿',
  access: 'ＪＲ 恵比寿駅 西口 徒歩3分',
  open: '24時間営業',
  close: 'なし',
  budget: { name: '1200～2400円', average: '1,200〜2,400円' },
  urls: { pc: 'https://www.hotpepper.jp/strDEVFIXTURE/' },
  wifi: 'あり',
  non_smoking: '全面禁煙',
  private_room: 'なし',
  parking: 'なし',
});
