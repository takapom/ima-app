import * as v from 'valibot';
import { EvidenceTextSchema } from '../domain/evidence';
import { ModelActionMetadataSchema } from '../domain/constraints';
import type { Result } from '../domain/result';
import { CandidateIdSchema, ObservationIdSchema, Text } from '../domain/primitives';
import { ModelContextSchema } from './context';
import type { CancellationToken } from './context';
import { GetPlaceDetailsInputSchema, SearchPlacesInputSchema } from './operations';

const EvidenceIdsSchema = v.pipe(
  v.array(ObservationIdSchema),
  v.maxLength(16),
  v.check((ids) => new Set(ids).size === ids.length, 'duplicate evidence ID'),
);

export const CardSelectionSchema = v.strictObject({
  candidateId: CandidateIdSchema,
  evidenceIds: EvidenceIdsSchema,
  why: EvidenceTextSchema(80),
  diff: v.optional(EvidenceTextSchema(40)),
});
export type CardSelection = v.InferOutput<typeof CardSelectionSchema>;

export const SubmitCardsPayloadSchema = v.strictObject({
  message: v.pipe(v.array(EvidenceTextSchema(300)), v.minLength(1), v.maxLength(4)),
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

export const ModelActionSchema = v.union([
  v.strictObject({ kind: v.literal('search_places'), input: SearchPlacesInputSchema }),
  v.strictObject({ kind: v.literal('get_place_details'), input: GetPlaceDetailsInputSchema }),
  v.strictObject({ kind: v.literal('submit_cards'), input: SubmitCardsInputSchema }),
  v.strictObject({ kind: v.literal('final_message'), message: EvidenceTextSchema(300) }),
]);
export type ModelAction = v.InferOutput<typeof ModelActionSchema>;

export const ModelRequestSchema = v.strictObject({
  userText: Text(500),
  context: ModelContextSchema,
});
export type ModelRequest = v.InferOutput<typeof ModelRequestSchema>;

export const ModelDecisionSchema = v.pipe(
  v.strictObject({
    /** One SDK step may contain several independent reads before a submit/final action. */
    actions: v.pipe(v.array(ModelActionSchema), v.minLength(1), v.maxLength(8)),
    metadata: ModelActionMetadataSchema,
  }),
  v.check(
    (decision) =>
      decision.actions.every(
        (action) => action.kind !== 'submit_cards' && action.kind !== 'final_message',
      ) || decision.actions.length === 1,
    'submit or final message cannot share a step with another action',
  ),
);
export type ModelDecision = v.InferOutput<typeof ModelDecisionSchema>;

export interface ModelPort {
  /** Adapter boundary only; loop ownership remains with the selected SDK/runtime. */
  respond(request: ModelRequest, cancellation: CancellationToken): Promise<Result<ModelDecision>>;
}
