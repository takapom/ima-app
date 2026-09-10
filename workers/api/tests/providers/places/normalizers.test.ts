import { describe, expect, it } from 'vitest';
import {
  normalizeGoogleContact,
  normalizeGooglePhotos,
  normalizeGooglePrice,
} from '../../../src/providers/places/values';
import { normalizeGoogleIdentity } from '../../../src/providers/places/identity';
import {
  GooglePlacesWireError,
  parseGooglePlaceWire,
  parseGooglePlaceWireField,
} from '../../../src/providers/places/wire';

const basePlace = (): Record<string, unknown> => ({
  id: 'ChIJfixture',
  name: 'places/fixture',
  displayName: { text: 'Fixture Cafe', languageCode: 'ja' },
  formattedAddress: '東京都渋谷区恵比寿1-1-1',
  primaryType: 'cafe',
  businessStatus: 'OPERATIONAL',
  googleMapsUri: 'https://maps.google.com/?cid=fixture',
});

const place = (overrides: Record<string, unknown> = {}) =>
  parseGooglePlaceWire({ ...basePlace(), ...overrides });

describe('Google Places wire allowlist', () => {
  it('accepts official attribution/photo metadata and strips unknown fields', () => {
    const parsed = place({
      attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
      photos: [
        {
          name: 'places/fixture/photos/photo-1',
          widthPx: 1200,
          heightPx: 800,
          authorAttributions: [{ displayName: 'Photographer', uri: '//example.com/author' }],
          googleMapsUri: 'https://maps.google.com/?cid=fixture&photo=1',
        },
      ],
    });
    expect(parsed.photos?.[0]?.widthPx).toBe(1200);
    const withUnknown = place({
      unexpectedProviderField: 'must not pass',
      photos: [
        {
          name: 'places/fixture/photos/photo-1',
          authorAttributions: [
            { displayName: 'Photographer', uri: '//example.com/author', unknown: 'drop' },
          ],
          unknownPhotoField: 'drop',
        },
      ],
    });
    expect(withUnknown).not.toHaveProperty('unexpectedProviderField');
    expect(withUnknown.photos?.[0]).not.toHaveProperty('unknownPhotoField');
    expect(withUnknown.photos?.[0]?.authorAttributions?.[0]).not.toHaveProperty('unknown');
  });

  it('parses each requested field independently', () => {
    const identity = parseGooglePlaceWireField('identity', {
      ...basePlace(),
      photos: 'invalid-array',
      priceLevel: 123,
    });
    expect(identity.displayName?.text).toBe('Fixture Cafe');
    expect(identity).not.toHaveProperty('photos');

    expect(() => parseGooglePlaceWireField('photos', { photos: 'invalid-array' })).toThrowError(
      GooglePlacesWireError,
    );
    expect(() => parseGooglePlaceWireField('price', { priceLevel: 123 })).toThrowError(
      GooglePlacesWireError,
    );
  });

  it('uses the host area label and does not infer area from address', () => {
    const result = normalizeGoogleIdentity(place(), '現在地周辺');
    expect(result.value.status).toBe('known');
    if (result.value.status !== 'known') throw new Error('identity should be known');
    expect(result.value.value.name).toBe('Fixture Cafe');
    expect(result.value.value.area).toBe('現在地周辺');
    expect(result.value.value.area).not.toContain('渋谷区');
  });

  it('keeps moved references as internal metadata without following them', () => {
    const result = normalizeGoogleIdentity(
      place({
        businessStatus: 'CLOSED_PERMANENTLY',
        movedPlace: 'places/new-location',
        movedPlaceId: 'new-location',
      }),
      '恵比寿',
    );
    expect(result.metadata).toEqual({
      movedPlace: 'places/new-location',
      movedPlaceId: 'new-location',
      providerBusinessStatus: 'CLOSED_PERMANENTLY',
    });
    expect(result.value.status).toBe('known');
    if (result.value.status !== 'known') throw new Error('identity should be known');
    expect(result.value.value.businessStatus).toBe('permanently_closed');
    expect(JSON.stringify(result.value)).not.toContain('new-location');
  });

  it('distinguishes unknown and contradictory provider statuses', () => {
    const future = normalizeGoogleIdentity(place({ businessStatus: 'FUTURE_OPENING' }), '恵比寿');
    expect(future.value.status).toBe('known');
    if (future.value.status !== 'known') throw new Error('future opening should be represented');
    expect(future.value.value.businessStatus).toBe('unknown');

    const unknown = normalizeGoogleIdentity(place({ businessStatus: 'NEW_STATUS' }), '恵比寿');
    expect(unknown.value.status).toBe('error');
    if (unknown.value.status !== 'error') throw new Error('unknown status should fail');
    expect(unknown.value.code).toBe('SCHEMA_MISMATCH');

    const contradictory = normalizeGoogleIdentity(
      place({ movedPlaceId: 'new-location' }),
      '恵比寿',
    );
    expect(contradictory.value.status).toBe('error');
    if (contradictory.value.status !== 'error') throw new Error('move conflict should fail');
    expect(contradictory.value.code).toBe('SOURCE_CONFLICT');
    expect(contradictory.value.reason.length).toBeGreaterThan(0);
  });
});

describe('Google Places price normalization', () => {
  it('maps provider levels without inventing a currency amount', () => {
    const result = normalizeGooglePrice(place({ priceLevel: 'PRICE_LEVEL_MODERATE' }));
    expect(result).toEqual({ status: 'known', value: { level: 2, range: null, rawLabel: null } });
  });

  it('keeps a complete same-currency range and rejects an incomplete range as known data', () => {
    const complete = normalizeGooglePrice(
      place({
        priceRange: {
          startPrice: { currencyCode: 'JPY', units: '1000', nanos: 0 },
          endPrice: { currencyCode: 'JPY', units: '2500', nanos: 0 },
        },
      }),
    );
    expect(complete).toEqual({
      status: 'known',
      value: {
        level: null,
        range: { currency: 'JPY', min: 1000, max: 2500, unit: 'unknown' },
        rawLabel: null,
      },
    });

    const incomplete = normalizeGooglePrice(
      place({
        priceRange: { startPrice: { currencyCode: 'JPY', units: '1000', nanos: 0 } },
      }),
    );
    expect(incomplete.status).toBe('unknown');
    if (incomplete.status !== 'unknown') throw new Error('incomplete range should be unknown');
    expect(incomplete.reason.length).toBeGreaterThan(0);

    const zeroDefaults = normalizeGooglePrice(
      place({
        priceRange: {
          startPrice: { currencyCode: 'JPY' },
          endPrice: { currencyCode: 'JPY', units: '0' },
        },
      }),
    );
    expect(zeroDefaults.status).toBe('known');
    if (zeroDefaults.status !== 'known') throw new Error('zero money defaults should be known');
    expect(zeroDefaults.value.range?.min).toBe(0);
    expect(zeroDefaults.value.range?.max).toBe(0);
  });

  it('does not hide unknown enums or conflicting currencies', () => {
    const unknownLevel = normalizeGooglePrice(place({ priceLevel: 'PRICE_LEVEL_NEW' }));
    expect(unknownLevel.status).toBe('error');
    if (unknownLevel.status !== 'error') throw new Error('unknown level should fail');
    expect(unknownLevel.code).toBe('SCHEMA_MISMATCH');
    const conflictingRange = normalizeGooglePrice(
      place({
        priceRange: {
          startPrice: { currencyCode: 'JPY', units: '1', nanos: 0 },
          endPrice: { currencyCode: 'USD', units: '2', nanos: 0 },
        },
      }),
    );
    expect(conflictingRange.status).toBe('error');
    if (conflictingRange.status !== 'error') throw new Error('currency conflict should fail');
    expect(conflictingRange.code).toBe('SOURCE_CONFLICT');

    const signConflict = normalizeGooglePrice(
      place({
        priceRange: {
          startPrice: { currencyCode: 'JPY', units: '1', nanos: -1 },
          endPrice: { currencyCode: 'JPY', units: '2', nanos: 0 },
        },
      }),
    );
    expect(signConflict.status).toBe('error');
    if (signConflict.status !== 'error') throw new Error('money sign conflict should fail');
    expect(signConflict.code).toBe('SCHEMA_MISMATCH');
  });
});

describe('Google Places contact and photo normalization', () => {
  it('prefers the international phone and rejects non-HTTPS contact links', () => {
    const result = normalizeGoogleContact(
      place({
        websiteUri: 'https://fixture.example',
        internationalPhoneNumber: '+81 3 0000 0000',
        nationalPhoneNumber: '03-0000-0000',
      }),
    );
    expect(result).toEqual({
      status: 'known',
      value: {
        websiteUrl: 'https://fixture.example',
        phone: '+81 3 0000 0000',
        mapUrl: 'https://maps.google.com/?cid=fixture',
      },
    });
    const unsafe = normalizeGoogleContact(place({ websiteUri: 'http://unsafe.example' }));
    expect(unsafe.status).toBe('error');
    if (unsafe.status !== 'error') throw new Error('HTTP website should fail');
    expect(unsafe.code).toBe('SCHEMA_MISMATCH');
    const empty = normalizeGoogleContact(place({ googleMapsUri: undefined }));
    expect(empty.status).toBe('unknown');
  });

  it('retains only Core photo metadata, normalizes protocol-relative attribution, and caps at three', () => {
    const photos = Array.from({ length: 4 }, (_, index) => ({
      name: `places/fixture/photos/photo-${index}`,
      widthPx: 1200,
      heightPx: 800,
      authorAttributions: [{ displayName: `Author ${index}`, uri: '//example.com/author' }],
    }));
    const result = normalizeGooglePhotos(place({ photos }));
    expect(result).toEqual({
      status: 'known',
      value: {
        photos: [
          {
            photoRef: 'places/fixture/photos/photo-0',
            attributions: [{ displayName: 'Author 0', uri: 'https://example.com/author' }],
            sourceUrl: 'https://maps.google.com/?cid=fixture',
          },
          {
            photoRef: 'places/fixture/photos/photo-1',
            attributions: [{ displayName: 'Author 1', uri: 'https://example.com/author' }],
            sourceUrl: 'https://maps.google.com/?cid=fixture',
          },
          {
            photoRef: 'places/fixture/photos/photo-2',
            attributions: [{ displayName: 'Author 2', uri: 'https://example.com/author' }],
            sourceUrl: 'https://maps.google.com/?cid=fixture',
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('widthPx');
    expect(JSON.stringify(result)).not.toContain('photoUri');
  });

  it('withholds photos without displayable author attribution', () => {
    const result = normalizeGooglePhotos(
      place({ photos: [{ name: 'places/fixture/photos/photo-1' }] }),
    );
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') throw new Error('photo without attribution should be unknown');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('rejects a provider photo reference that cannot be used as an internal handle', () => {
    const result = normalizeGooglePhotos(
      place({
        photos: [
          {
            name: 'photo-without-place-resource',
            authorAttributions: [{ displayName: 'Author' }],
          },
        ],
      }),
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('invalid photo reference should fail');
    expect(result.code).toBe('SCHEMA_MISMATCH');
  });
});
