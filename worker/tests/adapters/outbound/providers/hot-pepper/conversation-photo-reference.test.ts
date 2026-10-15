import { describe, expect, it } from 'vitest';
import {
  isHotPepperPhotoIdentity,
  isHotPepperPhotoRecordRef,
  parseHotPepperPhotoIdentity,
} from '@worker/infrastructure/adapters/out/providers/hot-pepper/conversation-photo-reference';

const boundaryId = `J${'1'.repeat(127)}`;

describe('hot pepper photo shop references', () => {
  it('keeps the current shop id shape and length used for photo refresh', () => {
    expect(isHotPepperPhotoRecordRef('J1')).toBe(true);
    expect(isHotPepperPhotoRecordRef('J000123456')).toBe(true);
    expect(isHotPepperPhotoRecordRef(boundaryId)).toBe(true);
    expect(boundaryId).toHaveLength(128);
  });

  it.each(['', 'J', 'j123', 'J123a', ' J123', `J${'1'.repeat(128)}`])(
    'rejects shop id %j before it can be sent to the provider',
    (recordRef) => {
      expect(isHotPepperPhotoRecordRef(recordRef)).toBe(false);
      expect(isHotPepperPhotoIdentity({ provider: 'hotpepper', recordRef })).toBe(false);
    },
  );

  it('does not treat another provider record as a hot pepper shop', () => {
    expect(isHotPepperPhotoIdentity({ provider: 'example', recordRef: 'J123' })).toBe(false);
    expect(isHotPepperPhotoIdentity({ provider: 'hotpepper', recordRef: 'J123' })).toBe(true);
  });

  it('reads a shop id only from a canonical https shop page', () => {
    expect(parseHotPepperPhotoIdentity('https://www.hotpepper.jp/strJ000123456/')).toEqual({
      provider: 'hotpepper',
      recordRef: 'J000123456',
    });
    expect(
      parseHotPepperPhotoIdentity('https://www.hotpepper.jp/strJ000123456/?vos=example'),
    ).toEqual({
      provider: 'hotpepper',
      recordRef: 'J000123456',
    });
    expect(
      parseHotPepperPhotoIdentity(`https://www.hotpepper.jp/str${boundaryId}/`)?.recordRef,
    ).toBe(boundaryId);
  });

  it.each([
    'not a url',
    'http://www.hotpepper.jp/strJ123/',
    'https://evil.test/strJ123/',
    'https://www.hotpepper.jp.evil.test/strJ123/',
    'https://user@www.hotpepper.jp/strJ123/',
    'https://user:secret@www.hotpepper.jp/strJ123/',
    'https://www.hotpepper.jp/str../../',
    'https://www.hotpepper.jp/strJ123/menu/',
    'https://www.hotpepper.jp/strJ123',
    'https://www.hotpepper.jp:444/strJ123/',
    `https://www.hotpepper.jp/strJ${'1'.repeat(128)}/`,
  ])('does not infer a shop id from %s', (sourceUrl) => {
    expect(parseHotPepperPhotoIdentity(sourceUrl)).toBeUndefined();
  });
});
