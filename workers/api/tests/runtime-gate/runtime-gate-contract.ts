import { jsonSchema } from 'ai';
import * as v from 'valibot';
import {
  GetPlaceDetailsInputSchema,
  SearchPlacesInputSchema,
  SubmitCardsInputSchema,
  EvidenceTextSchema,
  ModelActionMetadataSchema,
  ModelDecisionSchema,
  type ModelActionMetadata,
  type GetPlaceDetailsInput,
  type SearchPlacesInput,
  type SubmitCardsInput,
} from '@ima/core';

/** Keep the JSON-schema type coupled to the installed AI SDK without adding a private type dep. */
type JsonSchema = Parameters<typeof jsonSchema>[0];
type JsonSchemaObject = Exclude<JsonSchema, PromiseLike<unknown> | (() => unknown)>;

export type RuntimeGateToolEnvelope<Output> = {
  input: Output;
  metadata: ModelActionMetadata;
};

export type RuntimeGateFinalEnvelope = {
  kind: 'final_message';
  message: {
    text: string;
    evidenceIds: string[];
    basis: 'grounded' | 'inference' | 'conversational';
  };
  metadata: ModelActionMetadata;
};

const searchJsonSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        mode: { const: 'search' },
        query: { type: 'string' },
        area: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { const: 'current_location' },
                radiusMeters: { type: 'number', minimum: 100, maximum: 3000 },
              },
              required: ['kind', 'radiusMeters'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { kind: { const: 'named_area' }, name: { type: 'string' } },
              required: ['kind', 'name'],
              additionalProperties: false,
            },
          ],
        },
        openNow: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
        excludeCandidateIds: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      },
      required: ['mode', 'query', 'area', 'openNow', 'limit', 'excludeCandidateIds'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { mode: { const: 'continue' }, cursor: { type: 'string' } },
      required: ['mode', 'cursor'],
      additionalProperties: false,
    },
  ],
};

const detailsJsonSchema: JsonSchema = {
  type: 'object',
  properties: {
    requests: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          fields: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'string',
              enum: [
                'identity',
                'opening_hours',
                'price',
                'photos',
                'contact',
                'facilities',
                'walking_route',
                'last_train',
              ],
            },
          },
        },
        required: ['candidateId', 'fields'],
        additionalProperties: false,
      },
    },
    freshness: { type: 'string', enum: ['reuse_valid', 'refresh'] },
    travelContext: {
      type: 'object',
      properties: {
        departure: { const: 'now' },
        homeStationRef: { type: 'string' },
        minimumStayMinutes: { type: 'integer', minimum: 1, maximum: 180 },
      },
      required: ['departure'],
      additionalProperties: false,
    },
  },
  required: ['requests', 'freshness'],
  additionalProperties: false,
};

const evidenceTextJsonSchema: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
    basis: { type: 'string', enum: ['grounded', 'inference', 'conversational'] },
  },
  required: ['text', 'evidenceIds', 'basis'],
  additionalProperties: false,
};

const cardSelectionJsonSchema: JsonSchema = {
  type: 'object',
  properties: {
    candidateId: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
    why: evidenceTextJsonSchema,
    diff: evidenceTextJsonSchema,
  },
  required: ['candidateId', 'evidenceIds', 'why'],
  additionalProperties: false,
};

const submitJsonSchema: JsonSchema = {
  type: 'object',
  properties: {
    message: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: evidenceTextJsonSchema,
    },
    hero: cardSelectionJsonSchema,
    alts: { type: 'array', maxItems: 2, items: cardSelectionJsonSchema },
  },
  required: ['message', 'hero', 'alts'],
  additionalProperties: false,
};

const turnConstraintChangeJson: JsonSchema = {
  type: 'object',
  properties: {
    maxWalkMinutes: { type: 'integer', minimum: 1, maximum: 180 },
    homeStationRef: { type: 'string', minLength: 1, maxLength: 128 },
    minimumStayMinutes: { type: 'integer', minimum: 1, maximum: 180 },
    sourceTurnId: { type: 'string', minLength: 1, maxLength: 128 },
    quote: { type: 'string', minLength: 1, maxLength: 300 },
  },
  required: ['sourceTurnId', 'quote'],
  additionalProperties: false,
};

const metadataJsonSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    turnConstraints: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: turnConstraintChangeJson,
        },
      },
      required: ['changes'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const runtimeGateFinalOutputSchema = jsonSchema<RuntimeGateFinalEnvelope>(
  {
    type: 'object',
    properties: {
      kind: { const: 'final_message' },
      message: evidenceTextJsonSchema,
      metadata: metadataJsonSchema,
    },
    required: ['kind', 'message', 'metadata'],
    additionalProperties: false,
  },
  {
    validate(value) {
      const wire = v.safeParse(
        v.strictObject({
          kind: v.literal('final_message'),
          message: EvidenceTextSchema(300),
          metadata: ModelActionMetadataSchema,
        }),
        value,
      );
      if (!wire.success) {
        return { success: false, error: new Error('RUNTIME_GATE_FINAL_SCHEMA_MISMATCH') };
      }
      const decision = v.safeParse(ModelDecisionSchema, {
        actions: [{ kind: 'final_message', message: wire.output.message }],
        metadata: wire.output.metadata,
      });
      return decision.success
        ? { success: true, value: wire.output }
        : { success: false, error: new Error('RUNTIME_GATE_FINAL_METADATA_MISMATCH') };
    },
  },
);

function validatedEnvelope<Output>(
  schema: v.GenericSchema<unknown, Output>,
  inputDefinition: JsonSchemaObject,
) {
  return jsonSchema<RuntimeGateToolEnvelope<Output>>(
    {
      type: 'object',
      properties: { input: inputDefinition, metadata: metadataJsonSchema },
      required: ['input', 'metadata'],
      additionalProperties: false,
    },
    {
      validate(value) {
        const parsed = v.safeParse(
          v.strictObject({ input: schema, metadata: ModelActionMetadataSchema }),
          value,
        );
        return parsed.success
          ? { success: true, value: parsed.output }
          : { success: false, error: new Error('RUNTIME_GATE_CORE_ENVELOPE_MISMATCH') };
      },
    },
  );
}

function validatedSchema<Output>(schema: v.GenericSchema<unknown, Output>, definition: JsonSchema) {
  return jsonSchema<Output>(definition, {
    validate(value) {
      const parsed = v.safeParse(schema, value);
      return parsed.success
        ? { success: true, value: parsed.output }
        : { success: false, error: new Error('RUNTIME_GATE_CORE_SCHEMA_MISMATCH') };
    },
  });
}

export const searchPlacesInputSchema = validatedSchema<SearchPlacesInput>(
  SearchPlacesInputSchema,
  searchJsonSchema,
);
export const getPlaceDetailsInputSchema = validatedSchema<GetPlaceDetailsInput>(
  GetPlaceDetailsInputSchema,
  detailsJsonSchema,
);
export const submitCardsInputSchema = validatedSchema<SubmitCardsInput>(
  SubmitCardsInputSchema,
  submitJsonSchema,
);

export const searchPlacesEnvelopeSchema = validatedEnvelope(
  SearchPlacesInputSchema,
  searchJsonSchema,
);
export const getPlaceDetailsEnvelopeSchema = validatedEnvelope(
  GetPlaceDetailsInputSchema,
  detailsJsonSchema,
);
export const submitCardsEnvelopeSchema = validatedEnvelope(
  SubmitCardsInputSchema,
  submitJsonSchema,
);
