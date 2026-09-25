import * as v from 'valibot';
import type { PhotoTokenIssuer } from '@worker/application/ports/photo-token-issuer';
import {
  PhotoTokenError,
  PhotoTokenInputSchema,
  type PhotoTokenCodec,
} from '@worker/runtime/ports/photo';
/** Provider references and signing failures are interpreted only at this boundary. */
export const createPhotoTokenIssuer = (codec: PhotoTokenCodec): PhotoTokenIssuer => ({
  async issue(input, now) {
    const parsed = v.safeParse(PhotoTokenInputSchema, input);
    if (!parsed.success) return { status: 'withheld' };
    try {
      return { status: 'issued', token: await codec.issue(parsed.output, now) };
    } catch (error: unknown) {
      if (!(error instanceof PhotoTokenError)) throw error;
      return { status: 'withheld' };
    }
  },
});
