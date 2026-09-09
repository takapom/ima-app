import { expect, it } from 'vitest';
import {
  getPlaceDetailsEnvelopeSchema,
  runtimeGateFinalOutputSchema,
  searchPlacesEnvelopeSchema,
  submitCardsEnvelopeSchema,
} from './runtime-gate-contract';
import { detailsInput, searchInput, validSubmitInput } from './runtime-gate-provider';

const metadata = {
  turnConstraints: {
    changes: [
      {
        maxWalkMinutes: 15,
        homeStationRef: 'home-stn',
        minimumStayMinutes: 30,
        sourceTurnId: 'turn-1',
        quote: '15分以内',
      },
    ],
  },
};

async function accepted(
  schema: { validate?: (value: unknown) => unknown },
  value: unknown,
): Promise<boolean> {
  const result = await schema.validate?.(value);
  return (
    typeof result === 'object' && result !== null && 'success' in result && result.success === true
  );
}

it('connects each Core input Port to a strict AI SDK envelope schema', async () => {
  expect(await accepted(searchPlacesEnvelopeSchema, { input: searchInput, metadata })).toBe(true);
  expect(await accepted(getPlaceDetailsEnvelopeSchema, { input: detailsInput, metadata })).toBe(
    true,
  );
  expect(await accepted(submitCardsEnvelopeSchema, { input: validSubmitInput, metadata })).toBe(
    true,
  );
});

it.each([
  [
    'search envelope extra key',
    searchPlacesEnvelopeSchema,
    { input: searchInput, metadata, extra: true },
  ],
  [
    'details unknown field',
    getPlaceDetailsEnvelopeSchema,
    {
      input: { ...detailsInput, requests: [{ candidateId: 'candidate-1', fields: ['unknown'] }] },
      metadata,
    },
  ],
  [
    'submit duplicate candidate',
    submitCardsEnvelopeSchema,
    {
      input: {
        ...validSubmitInput,
        alts: [{ ...validSubmitInput.hero, candidateId: validSubmitInput.hero.candidateId }],
      },
      metadata,
    },
  ],
  [
    'metadata extra key',
    searchPlacesEnvelopeSchema,
    { input: searchInput, metadata: { ...metadata, extra: true } },
  ],
  [
    'metadata duplicate source turn',
    searchPlacesEnvelopeSchema,
    {
      input: searchInput,
      metadata: {
        turnConstraints: {
          changes: [
            { maxWalkMinutes: 15, sourceTurnId: 'turn-1', quote: '徒歩' },
            { minimumStayMinutes: 20, sourceTurnId: 'turn-1', quote: '滞在' },
          ],
        },
      },
    },
  ],
] as const)('%s is rejected before the Core Port', async (_label, schema, value) => {
  expect(await accepted(schema, value)).toBe(false);
});

it('validates final output through the same Core decision schema', async () => {
  expect(
    await accepted(runtimeGateFinalOutputSchema, {
      kind: 'final_message',
      message: {
        text: 'Fixture final answer.',
        evidenceIds: ['obs-identity-1'],
        basis: 'grounded',
      },
      metadata,
    }),
  ).toBe(true);

  const invalid = [
    {
      kind: 'final_message',
      message: {
        text: 'Fixture final answer.',
        evidenceIds: [],
        basis: 'grounded',
      },
      metadata,
    },
    {
      kind: 'final_message',
      message: {
        text: 'Fixture final answer.',
        evidenceIds: ['obs-identity-1'],
        basis: 'grounded',
        extra: true,
      },
      metadata,
    },
    { kind: 'final', message: { text: 'bad', evidenceIds: [], basis: 'inference' }, metadata },
  ];
  for (const value of invalid) {
    expect(await accepted(runtimeGateFinalOutputSchema, value)).toBe(false);
  }
});
