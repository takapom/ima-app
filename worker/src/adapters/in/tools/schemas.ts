import { jsonSchema, type FlexibleSchema } from 'ai';
import * as v from 'valibot';
import { ModelActionMetadataSchema } from '@worker/domain/constraints/constraints';
import {
  ModelGetPlaceDetailsInputSchema,
  SearchPlacesInputSchema,
} from '@worker/application/ports/operations';
import { SubmitCardsInputSchema } from '@worker/application/ports/model';
import type { PublicToolEnvelope } from '@worker/runtime/ports/tool-binding';
import { toolInputValidationError } from '@worker/runtime/model/tool-input-error';

type JsonSchema = Parameters<typeof jsonSchema>[0];
type WireSchema = Exclude<JsonSchema, PromiseLike<unknown> | (() => unknown)>;

const opaqueId: WireSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
};

const detailFields: string[] = [
  'identity',
  'opening_hours',
  'price',
  'photos',
  'contact',
  'facilities',
  'walking_route',
  'last_train',
];

/**
 * Only constraints the connected providers can evidence are offered to the model.
 * `maxWalkMinutes` and `homeStationRef` need walking-route and last-train evidence,
 * so declaring them here would invite a proposal that every submit must then reject.
 */
const metadataJsonSchema: WireSchema = {
  type: 'object',
  description:
    'Use {} unless the user explicitly changes minimumStayMinutes. Walking limits and home stations are not supported conditions. Do not omit metadata or use null. Area and query belong in input.',
  properties: {
    turnConstraints: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              minimumStayMinutes: { type: 'integer', minimum: 1, maximum: 180 },
              sourceTurnId: opaqueId,
              quote: { type: 'string', minLength: 1, maxLength: 300 },
            },
            required: ['sourceTurnId', 'quote', 'minimumStayMinutes'],
            additionalProperties: false,
          },
        },
      },
      required: ['changes'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const evidenceText = (maxLength: number): WireSchema => ({
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: maxLength },
    evidenceIds: { type: 'array', items: opaqueId, maxItems: 16 },
    basis: { type: 'string', enum: ['grounded', 'inference', 'conversational'] },
  },
  required: ['text', 'evidenceIds', 'basis'],
  additionalProperties: false,
});

const searchJsonSchema: WireSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        mode: { const: 'search' },
        query: { type: 'string', minLength: 1, maxLength: 200 },
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
              properties: {
                kind: { const: 'named_area' },
                name: { type: 'string', minLength: 1, maxLength: 160 },
              },
              required: ['kind', 'name'],
              additionalProperties: false,
            },
          ],
        },
        openNow: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
        excludeCandidateIds: { type: 'array', items: opaqueId, maxItems: 50 },
      },
      required: ['mode', 'query', 'area', 'openNow', 'limit', 'excludeCandidateIds'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        mode: { const: 'continue' },
        cursor: { type: 'string', minLength: 1, maxLength: 512 },
      },
      required: ['mode', 'cursor'],
      additionalProperties: false,
    },
  ],
};

const detailsJsonSchema: WireSchema = {
  type: 'object',
  properties: {
    requests: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        oneOf: [
          {
            type: 'object',
            properties: {
              candidateId: opaqueId,
              fields: {
                type: 'array',
                minItems: 1,
                maxItems: 8,
                items: { type: 'string', enum: detailFields },
              },
            },
            required: ['candidateId', 'fields'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              savedPlaceRef: opaqueId,
              fields: {
                type: 'array',
                minItems: 1,
                maxItems: 8,
                items: { type: 'string', enum: detailFields },
              },
            },
            required: ['savedPlaceRef', 'fields'],
            additionalProperties: false,
          },
        ],
      },
    },
    freshness: { type: 'string', enum: ['reuse_valid', 'refresh'] },
    travelContext: {
      type: 'object',
      properties: {
        departure: { const: 'now' },
        homeStationRef: opaqueId,
        minimumStayMinutes: { type: 'integer', minimum: 1, maximum: 180 },
      },
      required: ['departure'],
      additionalProperties: false,
    },
  },
  required: ['requests', 'freshness'],
  additionalProperties: false,
};

const submitJsonSchema: WireSchema = {
  type: 'object',
  properties: {
    message: { type: 'array', minItems: 1, maxItems: 4, items: evidenceText(300) },
    hero: {
      type: 'object',
      properties: {
        candidateId: opaqueId,
        evidenceIds: { type: 'array', items: opaqueId, maxItems: 16 },
        why: evidenceText(80),
        diff: evidenceText(40),
      },
      required: ['candidateId', 'evidenceIds', 'why'],
      additionalProperties: false,
    },
    alts: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        properties: {
          candidateId: opaqueId,
          evidenceIds: { type: 'array', items: opaqueId, maxItems: 16 },
          why: evidenceText(80),
          diff: evidenceText(40),
        },
        required: ['candidateId', 'evidenceIds', 'why', 'diff'],
        additionalProperties: false,
      },
    },
  },
  required: ['message', 'hero', 'alts'],
  additionalProperties: false,
};

const standardSchema = <T>(
  schema: v.GenericSchema<unknown, T>,
  wire: WireSchema,
): FlexibleSchema<T> =>
  jsonSchema<T>(wire, {
    validate(value) {
      const parsed = v.safeParse(schema, value);
      return parsed.success
        ? { success: true, value: parsed.output }
        : { success: false, error: toolInputValidationError(parsed.issues) };
    },
  });

const envelopeSchema = <T>(
  inputSchema: v.GenericSchema<unknown, T>,
  inputWire: WireSchema,
): FlexibleSchema<PublicToolEnvelope<T>> =>
  standardSchema(v.strictObject({ input: inputSchema, metadata: ModelActionMetadataSchema }), {
    type: 'object',
    properties: { input: inputWire, metadata: metadataJsonSchema },
    required: ['input', 'metadata'],
    additionalProperties: false,
  });

/** AI SDK tools use the same root action envelope as the M04 runtime gate. */
export const searchPlacesToolSchema = envelopeSchema(SearchPlacesInputSchema, searchJsonSchema);
export const getPlaceDetailsToolSchema = envelopeSchema(
  ModelGetPlaceDetailsInputSchema,
  detailsJsonSchema,
);
export const submitCardsToolSchema = envelopeSchema(SubmitCardsInputSchema, submitJsonSchema);
