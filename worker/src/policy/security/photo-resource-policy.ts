import * as v from 'valibot';

/** Only Hot Pepper's image CDN may be fetched through the photo proxy. */
export const HotPepperPhotoUrlSchema = v.pipe(
  v.string(),
  v.maxLength(512),
  v.regex(/^https:\/\/imgfp\.hotp\.jp\/IMGH\/[A-Za-z0-9_/-]+\.(?:jpg|jpeg|png|webp|gif)$/u),
);
