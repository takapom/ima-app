export const DEV_FIXTURE_PLACE_ID = 'dev-fixture-place';
export const DEV_FIXTURE_PHOTO_REF = 'places/dev-fixture-place/photos/dev-fixture-photo';

/** Returns the single fictional place used by the keyless development graph. */
export const fixturePlace = (clock: () => string): Record<string, unknown> => {
  const now = Date.parse(clock());
  if (!Number.isFinite(now)) throw new Error('DEV_FIXTURE_CLOCK_INVALID');
  return {
    id: DEV_FIXTURE_PLACE_ID,
    displayName: { text: '灯り坂ラウンジ（サンプル）' },
    formattedAddress: '東京都渋谷区恵比寿・架空のサンプル店舗',
    primaryType: 'cafe',
    businessStatus: 'OPERATIONAL',
    googleMapsUri: 'https://maps.google.com/?cid=dev-fixture',
    priceLevel: 'PRICE_LEVEL_MODERATE',
    priceRange: {
      startPrice: { currencyCode: 'JPY', units: '1200', nanos: 0 },
      endPrice: { currencyCode: 'JPY', units: '2400', nanos: 0 },
    },
    photos: [
      {
        name: DEV_FIXTURE_PHOTO_REF,
        widthPx: 1,
        heightPx: 1,
        googleMapsUri: 'https://maps.google.com/?cid=dev-fixture&photo=1',
        authorAttributions: [{ displayName: 'Ima dev fixture' }],
      },
    ],
    currentOpeningHours: {
      periods: [{ open: { day: 0, hour: 0, minute: 0 } }],
      weekdayDescriptions: ['24時間営業'],
      openNow: true,
    },
    timeZone: { id: 'Asia/Tokyo' },
    attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
  };
};
