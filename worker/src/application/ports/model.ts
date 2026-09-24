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

type CardsPayload = v.InferOutput<typeof SubmitCardsPayloadSchema>;

const altsExplainDifferences = (input: CardsPayload): boolean =>
  input.alts.every((alt) => alt.diff !== undefined);

const candidatesAreUnique = (input: CardsPayload): boolean =>
  new Set([input.hero.candidateId, ...input.alts.map((alt) => alt.candidateId)]).size ===
  input.alts.length + 1;

export const SubmitCardsInputSchema = v.pipe(
  SubmitCardsPayloadSchema,
  v.check(altsExplainDifferences, 'alternative cards require a diff'),
  v.check(candidatesAreUnique, 'hero and alternative candidates must be unique'),
);
export type SubmitCardsInput = v.InferOutput<typeof SubmitCardsInputSchema>;

/**
 * The one way the model ends a turn. The kinds are equal choices: ask a question, answer
 * (explain, compare, or report that nothing fits), or propose cards. Asking and answering keep
 * the cards on screen; proposing replaces them.
 */
export const RespondInputSchema = v.pipe(
  v.variant('kind', [
    v.strictObject({ kind: v.literal('ask'), message: Text(300) }),
    v.strictObject({ kind: v.literal('answer'), message: Text(300) }),
    v.strictObject({ kind: v.literal('propose'), ...SubmitCardsPayloadSchema.entries }),
  ]),
  v.check(
    (input) => input.kind !== 'propose' || altsExplainDifferences(input),
    'alternative cards require a diff',
  ),
  v.check(
    (input) => input.kind !== 'propose' || candidatesAreUnique(input),
    'hero and alternative candidates must be unique',
  ),
);
export type RespondInput = v.InferOutput<typeof RespondInputSchema>;
export type RespondKind = RespondInput['kind'];
