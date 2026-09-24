import * as v from 'valibot';
import {
  CandidateIdSchema,
  DetailFieldSchema,
  NonNegativeFiniteNumberSchema,
  NonNegativeSafeIntegerSchema,
  OpaqueIdSchema,
  SafeIntegerSchema,
  Text,
} from '@worker/domain/primitives';
import { FieldResultSchema } from '@worker/domain/result';
import type { Result } from '@worker/domain/result';
import {
  OpeningHoursSchema,
  PlaceIdentitySchema,
  PriceInfoSchema,
  PhotoInfoSchema,
  ContactInfoSchema,
  FacilitiesInfoSchema,
} from '@worker/domain/places/place-values';
import type {
  CancellationToken,
  HarnessContext,
  ToolExecutionContext,
} from '@worker/application/ports/context';

const CurrentLocationAreaSchema = v.strictObject({
  kind: v.literal('current_location'),
  radiusMeters: v.pipe(NonNegativeFiniteNumberSchema, v.minValue(100), v.maxValue(3_000)),
});
const NamedAreaSchema = v.strictObject({
  kind: v.literal('named_area'),
  name: Text(160),
});

export const SearchPlacesInputSchema = v.union([
  v.strictObject({
    mode: v.literal('search'),
    query: Text(200),
    area: v.union([CurrentLocationAreaSchema, NamedAreaSchema]),
    /** Omitted means the provider page limit; null is still invalid. */
    limit: v.optional(v.pipe(SafeIntegerSchema, v.minValue(1), v.maxValue(10)), 10),
    excludeCandidateIds: v.optional(
      v.pipe(
        v.array(CandidateIdSchema),
        v.maxLength(50),
        v.check((ids) => new Set(ids).size === ids.length, 'duplicate excluded candidate'),
      ),
      () => [],
    ),
  }),
  v.strictObject({
    mode: v.literal('continue'),
    cursor: Text(512),
  }),
]);
export type SearchPlacesInput = v.InferOutput<typeof SearchPlacesInputSchema>;

export const SearchPlacesOutputSchema = v.pipe(
  v.strictObject({
    searchId: OpaqueIdSchema,
    candidates: v.pipe(
      v.array(
        v.strictObject({
          candidateId: CandidateIdSchema,
          identity: FieldResultSchema(PlaceIdentitySchema),
          openingHours: FieldResultSchema(OpeningHoursSchema),
          price: FieldResultSchema(PriceInfoSchema),
        }),
      ),
      v.maxLength(20),
    ),
    applied: v.strictObject({
      areaDescription: Text(160),
      excludedCount: NonNegativeSafeIntegerSchema,
    }),
    nextCursor: v.nullable(Text(512)),
    coverage: v.literal('provider_results'),
  }),
  v.check((output) => {
    if (
      new Set(output.candidates.map((candidate) => candidate.candidateId)).size !==
      output.candidates.length
    ) {
      return false;
    }
    return output.candidates.every((candidate) => {
      const matches = [
        ['identity', candidate.identity],
        ['opening_hours', candidate.openingHours],
        ['price', candidate.price],
      ] as const;
      return matches.every(([field, result]) => {
        if (result.status !== 'known') return true;
        return result.observations.every(
          (observation) =>
            observation.candidateId === candidate.candidateId && observation.field === field,
        );
      });
    });
  }, 'candidate IDs and field observations must correspond'),
);
export type SearchPlacesOutput = v.InferOutput<typeof SearchPlacesOutputSchema>;

const DetailFieldsSchema = v.pipe(
  v.array(DetailFieldSchema),
  v.minLength(1),
  v.maxLength(8),
  v.check((fields) => new Set(fields).size === fields.length, 'duplicate detail field'),
);

/** Core details Port input; only a current thread candidate may cross this boundary. */
export const DetailsRequestSchema = v.strictObject({
  candidateId: CandidateIdSchema,
  fields: DetailFieldsSchema,
});
export type DetailsRequest = v.InferOutput<typeof DetailsRequestSchema>;

export const GetPlaceDetailsInputSchema = v.strictObject({
  requests: v.pipe(
    v.array(DetailsRequestSchema),
    v.minLength(1),
    v.maxLength(5),
    v.check(
      (requests) =>
        new Set(requests.map((request) => request.candidateId)).size === requests.length,
      'candidate IDs must be unique',
    ),
  ),
  freshness: v.picklist(['reuse_valid', 'refresh']),
});
export type GetPlaceDetailsInput = v.InferOutput<typeof GetPlaceDetailsInputSchema>;

const DetailValuesSchema = v.strictObject({
  identity: v.optional(FieldResultSchema(PlaceIdentitySchema)),
  opening_hours: v.optional(FieldResultSchema(OpeningHoursSchema)),
  price: v.optional(FieldResultSchema(PriceInfoSchema)),
  photos: v.optional(FieldResultSchema(PhotoInfoSchema)),
  contact: v.optional(FieldResultSchema(ContactInfoSchema)),
  facilities: v.optional(FieldResultSchema(FacilitiesInfoSchema)),
});

export const GetPlaceDetailsOutputSchema = v.pipe(
  v.strictObject({
    items: v.pipe(
      v.array(v.strictObject({ candidateId: CandidateIdSchema, fields: DetailValuesSchema })),
      v.minLength(1),
      v.maxLength(5),
    ),
  }),
  v.check((output) => {
    const candidateIds = output.items.map((item) => item.candidateId);
    if (new Set(candidateIds).size !== candidateIds.length) return false;
    return output.items.every((item) => {
      const presentFields = Object.entries(item.fields).filter(([, value]) => value !== undefined);
      if (presentFields.length === 0) return false;
      return presentFields.every(([field, result]) => {
        if (!result || result.status !== 'known') return true;
        return result.observations.every(
          (observation) =>
            observation.candidateId === item.candidateId && observation.field === field,
        );
      });
    });
  }, 'details output candidates and fields must correspond'),
);
export type GetPlaceDetailsOutput = v.InferOutput<typeof GetPlaceDetailsOutputSchema>;

/** Cross-checks response fields against the exact candidate/field request. */
export const matchesDetailsRequest = (input: unknown, output: unknown): boolean => {
  const parsedInput = v.safeParse(GetPlaceDetailsInputSchema, input);
  const parsedOutput = v.safeParse(GetPlaceDetailsOutputSchema, output);
  if (!parsedInput.success || !parsedOutput.success) return false;
  const requested = new Map(
    parsedInput.output.requests.map((request) => [request.candidateId, new Set(request.fields)]),
  );
  if (requested.size !== parsedOutput.output.items.length) return false;
  return parsedOutput.output.items.every((item) => {
    const fields = requested.get(item.candidateId);
    if (fields === undefined) return false;
    const returned = new Set(
      Object.entries(item.fields)
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field),
    );
    return returned.size === fields.size && [...fields].every((field) => returned.has(field));
  });
};

export interface PlaceSearchPort {
  search(
    input: SearchPlacesInput,
    context: HarnessContext,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<Result<SearchPlacesOutput>>;
}

export interface PlaceDetailsPort {
  read(
    input: GetPlaceDetailsInput,
    context: HarnessContext,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<Result<GetPlaceDetailsOutput>>;
}
