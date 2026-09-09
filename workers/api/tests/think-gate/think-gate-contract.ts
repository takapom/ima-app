import { jsonSchema } from 'ai';
import * as v from 'valibot';
import {
  GetPlaceDetailsInputSchema,
  SearchPlacesInputSchema,
  SubmitCardsInputSchema,
  type GetPlaceDetailsInput,
  type SearchPlacesInput,
  type SubmitCardsInput,
} from '@ima/core';

type JsonSchema = Parameters<typeof jsonSchema>[0];

function validatedSchema<Output>(schema: v.GenericSchema<unknown, Output>, definition: JsonSchema) {
  return jsonSchema<Output>(definition, {
    validate(value) {
      const parsed = v.safeParse(schema, value);
      return parsed.success
        ? { success: true, value: parsed.output }
        : { success: false, error: new Error('THINK_GATE_CORE_SCHEMA_MISMATCH') };
    },
  });
}

const searchDefinition: JsonSchema = {
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

const detailsDefinition: JsonSchema = {
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
  },
  required: ['requests', 'freshness'],
  additionalProperties: false,
};

const evidenceTextDefinition: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
    basis: { type: 'string', enum: ['grounded', 'inference', 'conversational'] },
  },
  required: ['text', 'evidenceIds', 'basis'],
  additionalProperties: false,
};

const cardDefinition: JsonSchema = {
  type: 'object',
  properties: {
    candidateId: { type: 'string' },
    evidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 16 },
    why: evidenceTextDefinition,
    diff: evidenceTextDefinition,
  },
  required: ['candidateId', 'evidenceIds', 'why'],
  additionalProperties: false,
};

const submitDefinition: JsonSchema = {
  type: 'object',
  properties: {
    message: { type: 'array', minItems: 1, maxItems: 4, items: evidenceTextDefinition },
    hero: cardDefinition,
    alts: { type: 'array', maxItems: 2, items: cardDefinition },
  },
  required: ['message', 'hero', 'alts'],
  additionalProperties: false,
};

export const searchPlacesInputSchema = validatedSchema<SearchPlacesInput>(
  SearchPlacesInputSchema,
  searchDefinition,
);
export const getPlaceDetailsInputSchema = validatedSchema<GetPlaceDetailsInput>(
  GetPlaceDetailsInputSchema,
  detailsDefinition,
);
export const submitCardsInputSchema = validatedSchema<SubmitCardsInput>(
  SubmitCardsInputSchema,
  submitDefinition,
);
