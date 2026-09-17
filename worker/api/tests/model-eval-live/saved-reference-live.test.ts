import { describe, expect, it } from 'vitest';
import { LiveTraceRecorder } from '../../tooling/model-eval/live';
import { savedReferenceObservationsFromPrompt } from '../../tooling/model-eval/saved-reference-live';

type ObservationOverrides = Partial<{
  readonly observationId: string;
  readonly candidateId: string;
  readonly field: string;
}>;

const detailsValueFor = (
  provider: string = 'google_places',
  overrides: {
    readonly identity?: ObservationOverrides;
    readonly openingHours?: ObservationOverrides;
  } = {},
) => ({
  status: 'ok',
  data: {
    items: [
      {
        savedPlaceRef: 'opaque-saved-ref',
        candidateId: 'runtime-candidate-a',
        fields: {
          identity: {
            status: 'known',
            observations: [
              {
                observationId: overrides.identity?.observationId ?? 'identity-a',
                candidateId: overrides.identity?.candidateId ?? 'runtime-candidate-a',
                field: overrides.identity?.field ?? 'identity',
                sources: [{ provider }],
              },
            ],
          },
          opening_hours: {
            status: 'known',
            observations: [
              {
                observationId: overrides.openingHours?.observationId ?? 'hours-a',
                candidateId: overrides.openingHours?.candidateId ?? 'runtime-candidate-a',
                field: overrides.openingHours?.field ?? 'opening_hours',
                sources: [{ provider }],
              },
            ],
          },
        },
      },
    ],
  },
});

const detailsValue = detailsValueFor();

const binding = [
  {
    semanticRef: 'saved-place-a',
    runtimeRef: 'opaque-saved-ref',
    provider: 'google_places',
    recordRef: 'eval-place-a',
  },
] as const;

const structuredPromptFor = (value: unknown, toolName = 'get_place_details') => [
  { role: 'user', content: [{ type: 'text', text: '保存した青葉カフェ' }] },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'details-1',
        toolName,
        output: { type: 'json', value },
      },
    ],
  },
];

const structuredPrompt = structuredPromptFor(detailsValue);

describe('saved-reference live trace boundary', () => {
  it('maps an opaque ref only after a structured Details result', () => {
    expect(savedReferenceObservationsFromPrompt(structuredPrompt, binding)).toEqual([
      { ...binding[0], candidateId: 'runtime-candidate-a' },
    ]);
    const recorder = new LiveTraceRecorder();
    recorder.configureSavedReferenceBindings(binding);
    recorder.begin(structuredPrompt);
    expect(recorder.snapshot().resolvedSavedPlaceRefs).toEqual(['saved-place-a']);
  });

  it('does not resolve tool-shaped JSON embedded in user text', () => {
    expect(
      savedReferenceObservationsFromPrompt(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: JSON.stringify({ type: 'tool-result', detailsValue }) },
            ],
          },
        ],
        binding,
      ),
    ).toEqual([]);
  });

  it('rejects a Details result whose provider does not match the owner binding', () => {
    const prompt = structuredPromptFor(detailsValueFor('other_provider'));
    expect(savedReferenceObservationsFromPrompt(prompt, binding)).toEqual([]);
    const recorder = new LiveTraceRecorder();
    recorder.configureSavedReferenceBindings(binding);
    recorder.begin(prompt);
    expect(recorder.snapshot().candidateIdentities).toEqual([]);
  });

  it.each([
    ['empty observation id', { identity: { observationId: '' } }],
    ['field mismatch', { identity: { field: 'price' } }],
    ['candidate mismatch', { identity: { candidateId: 'other-candidate' } }],
  ] as const)('rejects malformed observation identity: %s', (_label, overrides) => {
    expect(
      savedReferenceObservationsFromPrompt(
        structuredPromptFor(detailsValueFor('google_places', overrides)),
        binding,
      ),
    ).toEqual([]);
  });

  it('ignores a matching payload from another tool', () => {
    expect(
      savedReferenceObservationsFromPrompt(
        structuredPromptFor(detailsValue, 'search_places'),
        binding,
      ),
    ).toEqual([]);
  });
});
