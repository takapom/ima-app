import type { LanguageModel } from 'ai';
import type { GetPlaceDetailsInput, SearchPlacesInput } from '@worker/application/ports/operations';
import type { SubmitCardsInput } from '@worker/application/ports/model';
import { identityObservationId, observationFor } from './runtime-model-observations';

export type RuntimeGateScenario =
  | 'sequence'
  | 'invalid'
  | 'search'
  | 'message'
  | 'repair-limit'
  | 'message-switch'
  | 'empty-final'
  | 'cards-1'
  | 'cards-2'
  | 'cards-3'
  | 'step-valid'
  | 'read-submit'
  | 'two-submit'
  | 'final-tool'
  | 'final-tool-calls'
  | 'unknown-part'
  | 'unknown-tool'
  | 'invalid-arguments'
  | 'structured'
  | 'structured-error'
  | 'timeout'
  | 'cancel';

export type RuntimeGateModelRequest = {
  call: number;
  toolNames: string[];
  sawIdentityObservation: boolean;
  sawOpeningHoursObservation: boolean;
  sawMissingEvidence: boolean;
  sawNativeContent: boolean;
  sawStaleNativeContent: boolean;
};

export type RuntimeGateModelReport = {
  calls: number;
  requests: RuntimeGateModelRequest[];
};

type RuntimeGateToolName = 'search_places' | 'get_place_details' | 'submit_cards';
type RuntimeGateModelInput = SearchPlacesInput | GetPlaceDetailsInput | SubmitCardsInput;
export type RuntimeGateModel = Extract<LanguageModel, { specificationVersion: 'v3' }>;
export type RuntimeGateModelStream = Awaited<ReturnType<RuntimeGateModel['doStream']>>;
export type RuntimeGateModelStreamPart =
  RuntimeGateModelStream['stream'] extends ReadableStream<infer Part> ? Part : never;
type RuntimeGateModelStreamFinish = Extract<RuntimeGateModelStreamPart, { type: 'finish' }>;
export type RuntimeGateModelCallOptions = Parameters<RuntimeGateModel['doStream']>[0];

const usage: RuntimeGateModelStreamFinish['usage'] = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const toolFinish = { unified: 'tool-calls', raw: 'tool-calls' } as const;
const stopFinish = { unified: 'stop', raw: 'stop' } as const;

const detailsInput: GetPlaceDetailsInput = {
  requests: [{ candidateId: 'candidate-1', fields: ['identity', 'opening_hours'] }],
  freshness: 'reuse_valid',
};

const invalidSubmitInput: SubmitCardsInput = {
  message: [{ text: 'fixture selection needs evidence', evidenceIds: [], basis: 'inference' }],
  hero: {
    candidateId: 'candidate-1',
    evidenceIds: [],
    why: { text: 'fixture selection', evidenceIds: [], basis: 'inference' },
  },
  alts: [],
};

const validSubmitInput: SubmitCardsInput = {
  message: [
    {
      text: 'Fixture candidate-1 is open now.',
      evidenceIds: [identityObservationId('candidate-1')],
      basis: 'grounded',
    },
  ],
  hero: {
    candidateId: 'candidate-1',
    evidenceIds: [identityObservationId('candidate-1')],
    why: {
      text: 'Identity is confirmed by the fixture source.',
      evidenceIds: [identityObservationId('candidate-1')],
      basis: 'grounded',
    },
  },
  alts: [],
};

const validAlt = (candidateId: string, text: string): SubmitCardsInput['hero'] => ({
  candidateId,
  evidenceIds: [identityObservationId(candidateId)],
  why: {
    text: 'Identity is confirmed by the fixture source.',
    evidenceIds: [identityObservationId(candidateId)],
    basis: 'grounded',
  },
  diff: {
    text,
    evidenceIds: [identityObservationId(candidateId)],
    basis: 'grounded',
  },
});

const validSubmitInputTwo: SubmitCardsInput = {
  ...validSubmitInput,
  alts: [validAlt('candidate-2', 'Alternative candidate.')],
};

const validSubmitInputThree: SubmitCardsInput = {
  ...validSubmitInputTwo,
  alts: [
    validAlt('candidate-2', 'Alternative candidate.'),
    validAlt('candidate-3', 'Another candidate.'),
  ],
};

const searchInput: Extract<SearchPlacesInput, { mode: 'search' }> = {
  mode: 'search',
  query: 'coffee',
  area: { kind: 'named_area', name: 'Fixture area' },
  limit: 3,
  excludeCandidateIds: [],
};

export const PUBLIC_TOOLS = ['search_places', 'get_place_details', 'submit_cards'] as const;
export const DENIED_MARKER = 'M04_PROVIDER_FIELD_DENIED';
/** Audit-only marker used to prove a previous native input is not re-injected. */
export const STALE_NATIVE_CONTENT_CANARY = 'M04_NATIVE_CONTENT_OLD_CANARY';

function stepEnvelope(input: RuntimeGateModelInput): Record<string, unknown> {
  return { input };
}

function stepToolParts(
  call: number,
  toolName: string,
  input: RuntimeGateModelInput,
): RuntimeGateModelStreamPart[] {
  const id = `step-${toolName}-${call}`;
  const encoded = JSON.stringify(stepEnvelope(input));
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: encoded },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: encoded },
  ];
}

function stepFinalParts(text: string = 'Fixture final answer.'): RuntimeGateModelStreamPart[] {
  const finalEnvelope = JSON.stringify({
    kind: 'final_message',
    message: {
      text,
      evidenceIds: [identityObservationId('candidate-1')],
      basis: 'grounded',
    },
  });
  return [
    { type: 'text-start', id: 'step-final' },
    { type: 'text-delta', id: 'step-final', delta: finalEnvelope },
    { type: 'text-end', id: 'step-final' },
  ];
}

function streamOf(parts: RuntimeGateModelStreamPart[]): ReadableStream<RuntimeGateModelStreamPart> {
  return new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });
}

function pendingStream(): ReadableStream<RuntimeGateModelStreamPart> {
  return new ReadableStream({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      return undefined;
    },
  });
}

function textParts(call: number, text: string): RuntimeGateModelStreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...stepFinalParts(text),
    { type: 'finish', usage, finishReason: stopFinish },
  ];
}

function toolParts(
  call: number,
  toolName: RuntimeGateToolName,
  input: RuntimeGateModelInput,
): RuntimeGateModelStreamPart[] {
  const toolCallId = `${toolName}-${call}`;
  const encoded = JSON.stringify(stepEnvelope(input));
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: encoded },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: encoded },
    { type: 'finish', usage, finishReason: toolFinish },
  ];
}

function nextParts(scenario: RuntimeGateScenario, call: number): RuntimeGateModelStreamPart[] {
  if (scenario === 'step-valid') {
    return [
      { type: 'stream-start', warnings: [] },
      ...stepFinalParts(),
      { type: 'finish', usage, finishReason: stopFinish },
    ];
  }
  if (scenario === 'read-submit') {
    return [
      { type: 'stream-start', warnings: [] },
      ...stepToolParts(call, 'get_place_details', detailsInput),
      ...stepToolParts(call, 'submit_cards', validSubmitInput),
      { type: 'finish', usage, finishReason: toolFinish },
    ];
  }
  if (scenario === 'two-submit') {
    return [
      { type: 'stream-start', warnings: [] },
      ...stepToolParts(call, 'submit_cards', validSubmitInput),
      ...stepToolParts(call + 1, 'submit_cards', validSubmitInput),
      { type: 'finish', usage, finishReason: toolFinish },
    ];
  }
  if (scenario === 'final-tool' || scenario === 'final-tool-calls') {
    return [
      { type: 'stream-start', warnings: [] },
      ...stepFinalParts(DENIED_MARKER),
      ...stepToolParts(call, 'submit_cards', validSubmitInput),
      {
        type: 'finish',
        usage,
        finishReason: scenario === 'final-tool' ? stopFinish : toolFinish,
      },
    ];
  }
  if (scenario === 'unknown-part') {
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: DENIED_MARKER },
      { type: 'finish', usage, finishReason: stopFinish },
    ];
  }
  if (scenario === 'unknown-tool') {
    return [
      { type: 'stream-start', warnings: [] },
      ...stepToolParts(call, 'bash', searchInput),
      { type: 'finish', usage, finishReason: toolFinish },
    ];
  }
  if (scenario === 'invalid-arguments') {
    return call === 0
      ? [
          { type: 'stream-start', warnings: [] },
          ...stepToolParts(call, 'search_places', { ...searchInput, limit: 0 }),
          { type: 'finish', usage, finishReason: toolFinish },
        ]
      : textParts(call, '入力を補正できたため終了します。');
  }
  if (scenario === 'repair-limit') {
    return [
      { type: 'stream-start', warnings: [] },
      ...toolParts(call, 'submit_cards', invalidSubmitInput),
    ];
  }
  if (scenario === 'message-switch') {
    return call === 0
      ? [
          { type: 'stream-start', warnings: [] },
          ...toolParts(call, 'submit_cards', invalidSubmitInput),
        ]
      : textParts(call, '根拠がないため候補は変更しません。');
  }
  if (scenario === 'empty-final') {
    return call === 0
      ? toolParts(call, 'submit_cards', validSubmitInput)
      : [
          { type: 'stream-start', warnings: [] },
          { type: 'finish', usage, finishReason: stopFinish },
        ];
  }
  if (scenario === 'cards-1') {
    return toolParts(call, 'submit_cards', validSubmitInput);
  }
  if (scenario === 'cards-2') {
    return toolParts(call, 'submit_cards', validSubmitInputTwo);
  }
  if (scenario === 'cards-3') {
    return toolParts(call, 'submit_cards', validSubmitInputThree);
  }
  if (scenario === 'timeout') {
    return [
      { type: 'stream-start', warnings: [] },
      ...toolParts(call, 'search_places', searchInput),
    ];
  }
  if (scenario === 'cancel') {
    return [
      { type: 'stream-start', warnings: [] },
      ...toolParts(call, 'search_places', searchInput),
    ];
  }
  if (scenario === 'structured' || scenario === 'structured-error') {
    return call === 0
      ? [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: `structured-${call}` },
          {
            type: 'text-delta',
            id: `structured-${call}`,
            delta: `provider generated ${DENIED_MARKER}`,
          },
          { type: 'text-end', id: `structured-${call}` },
          ...toolParts(call, 'search_places', searchInput).slice(0, -1),
          { type: 'finish', usage, finishReason: toolFinish },
        ]
      : textParts(call, `derived answer ${DENIED_MARKER}`);
  }
  if (scenario === 'sequence') {
    return call === 0
      ? toolParts(call, 'get_place_details', detailsInput)
      : toolParts(call, 'submit_cards', validSubmitInput);
  }
  if (scenario === 'invalid') {
    if (call === 0) return toolParts(call, 'submit_cards', invalidSubmitInput);
    if (call === 1) return toolParts(call, 'get_place_details', detailsInput);
    return toolParts(call, 'submit_cards', validSubmitInput);
  }
  if (scenario === 'search') {
    return call === 0
      ? toolParts(call, 'search_places', searchInput)
      : textParts(call, 'Fixture search completed.');
  }
  return textParts(call, 'Fixture message completed.');
}

export function normalizeScenario(value: string | null): RuntimeGateScenario {
  if (
    value === 'sequence' ||
    value === 'invalid' ||
    value === 'search' ||
    value === 'message' ||
    value === 'repair-limit' ||
    value === 'message-switch' ||
    value === 'empty-final' ||
    value === 'cards-1' ||
    value === 'cards-2' ||
    value === 'cards-3' ||
    value === 'step-valid' ||
    value === 'read-submit' ||
    value === 'two-submit' ||
    value === 'final-tool' ||
    value === 'final-tool-calls' ||
    value === 'unknown-part' ||
    value === 'unknown-tool' ||
    value === 'invalid-arguments' ||
    value === 'structured' ||
    value === 'structured-error' ||
    value === 'timeout' ||
    value === 'cancel'
  ) {
    return value;
  }
  return 'sequence';
}

export function modelFor(
  scenario: RuntimeGateScenario,
  report: RuntimeGateModelReport,
  nativeContent: () => string | null = () => null,
): RuntimeGateModel {
  let call = 0;
  return {
    specificationVersion: 'v3',
    provider: 'm04-runtime-gate-scripted-provider',
    modelId: scenario,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('RUNTIME_GATE_STREAM_ONLY')),
    doStream: (options: RuntimeGateModelCallOptions) => {
      const currentCall = call;
      call += 1;
      const prompt = JSON.stringify(options.prompt);
      const currentNativeContent = nativeContent();
      report.calls += 1;
      report.requests.push({
        call: currentCall,
        toolNames: (options.tools ?? []).map((tool) => tool.name).sort(),
        sawIdentityObservation: prompt.includes(identityObservationId('candidate-1')),
        sawOpeningHoursObservation: prompt.includes(
          observationFor('candidate-1', 'opening_hours').observationId,
        ),
        sawMissingEvidence: prompt.includes('MISSING_EVIDENCE'),
        sawNativeContent: currentNativeContent !== null && prompt.includes(currentNativeContent),
        sawStaleNativeContent: prompt.includes(STALE_NATIVE_CONTENT_CANARY),
      });
      return Promise.resolve({
        stream:
          scenario === 'timeout' ? pendingStream() : streamOf(nextParts(scenario, currentCall)),
      });
    },
  };
}

export {
  detailsInput,
  invalidSubmitInput,
  searchInput,
  validSubmitInput,
  validSubmitInputTwo,
  validSubmitInputThree,
};
