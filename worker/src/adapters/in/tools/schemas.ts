import { jsonSchema, type FlexibleSchema } from 'ai';
import * as v from 'valibot';
import {
  GetPlaceDetailsInputSchema,
  SearchPlacesInputSchema,
} from '@worker/application/ports/operations';
import { RespondInputSchema } from '@worker/application/ports/model';
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

/** Fields the model may request. Contact stays a Core field but no connected provider has it. */
const detailFields: string[] = ['identity', 'opening_hours', 'price', 'photos', 'facilities'];

const generatedText = (maxLength: number): WireSchema => ({
  type: 'string',
  minLength: 1,
  maxLength,
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
        limit: { type: 'integer', minimum: 1, maximum: 10 },
        excludeCandidateIds: { type: 'array', items: opaqueId, maxItems: 50 },
      },
      required: ['mode', 'query', 'area'],
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
    },
    freshness: { type: 'string', enum: ['reuse_valid', 'refresh'] },
  },
  required: ['requests', 'freshness'],
  additionalProperties: false,
};

const cardSelection = (diffRequired: boolean): WireSchema => ({
  type: 'object',
  properties: {
    candidateId: opaqueId,
    why: generatedText(80),
    diff: generatedText(40),
  },
  required: diffRequired ? ['candidateId', 'why', 'diff'] : ['candidateId', 'why'],
  additionalProperties: false,
});

const messageOnly = (kind: 'ask' | 'answer'): WireSchema => ({
  type: 'object',
  properties: { kind: { const: kind }, message: generatedText(300) },
  required: ['kind', 'message'],
  additionalProperties: false,
});

const respondJsonSchema: WireSchema = {
  oneOf: [
    messageOnly('ask'),
    messageOnly('answer'),
    {
      type: 'object',
      properties: {
        kind: { const: 'propose' },
        message: { type: 'array', minItems: 1, maxItems: 4, items: generatedText(300) },
        hero: cardSelection(false),
        alts: { type: 'array', maxItems: 2, items: cardSelection(true) },
      },
      required: ['kind', 'message', 'hero', 'alts'],
      additionalProperties: false,
    },
  ],
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
  standardSchema(v.strictObject({ input: inputSchema }), {
    type: 'object',
    properties: { input: inputWire },
    required: ['input'],
    additionalProperties: false,
  });

/** AI SDK tools use the same root input envelope as the runtime gate. */
export const searchPlacesToolSchema = envelopeSchema(SearchPlacesInputSchema, searchJsonSchema);
export const getPlaceDetailsToolSchema = envelopeSchema(
  GetPlaceDetailsInputSchema,
  detailsJsonSchema,
);
export const respondToolSchema = envelopeSchema(RespondInputSchema, respondJsonSchema);
