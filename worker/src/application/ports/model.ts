import * as v from 'valibot';
import { CandidateIdSchema, Text } from '@worker/domain/primitives';

/**
 * Card facts are attached by the Core from the registry; the model only picks and explains.
 * Generated text is plain text: the harness, not the model, tracks what the model was shown.
 */
export const CardSelectionSchema = v.strictObject({
  candidateId: CandidateIdSchema,
  why: Text(80),
  diff: v.optional(Text(40)),
});
export type CardSelection = v.InferOutput<typeof CardSelectionSchema>;

export const SubmitCardsPayloadSchema = v.strictObject({
  message: v.pipe(v.array(Text(300)), v.minLength(1), v.maxLength(4)),
  hero: CardSelectionSchema,
  alts: v.pipe(v.array(CardSelectionSchema), v.maxLength(2)),
});

export const SubmitCardsInputSchema = v.pipe(
  SubmitCardsPayloadSchema,
  v.check(
    (input) => input.alts.every((alt) => alt.diff !== undefined),
    'alternative cards require diff evidence',
  ),
  v.check(
    (input) =>
      new Set([input.hero.candidateId, ...input.alts.map((alt) => alt.candidateId)]).size ===
      input.alts.length + 1,
    'hero and alternative candidates must be unique',
  ),
);
export type SubmitCardsInput = v.InferOutput<typeof SubmitCardsInputSchema>;
