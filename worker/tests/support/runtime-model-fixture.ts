import type { LanguageModel } from 'ai';
import type { GetPlaceDetailsInput, SearchPlacesInput } from '@worker/application/ports/operations';
import type { RespondInput } from '@worker/application/ports/model';
import { identityObservationId, observationFor } from './runtime-model-observations';

export type RuntimeGateScenario = 'invalid' | 'search' | 'message' | 'empty-final' | 'read-submit';

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

type RuntimeGateToolName = 'search_places' | 'get_place_details' | 'respond';
type RuntimeGateModelInput = SearchPlacesInput | GetPlaceDetailsInput | RespondInput;
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

// Invalid until a details read registers the candidate's identity and opening hours.
const invalidSubmitInput: RespondInput = {
  kind: 'propose',
  message: ['fixture selection needs evidence'],
  hero: { candidateId: 'candidate-1', why: 'fixture selection' },
  alts: [],
};

const validSubmitInput: RespondInput = {
  kind: 'propose',
  message: ['Fixture candidate-1 is open now.'],
  hero: { candidateId: 'candidate-1', why: 'Identity is confirmed by the fixture source.' },
  alts: [],
};

const answerInput = (message: string): RespondInput => ({ kind: 'answer', message });

const searchInput: Extract<SearchPlacesInput, { mode: 'search' }> = {
  mode: 'search',
  query: 'coffee',
  area: { kind: 'named_area', name: 'Fixture area' },
  limit: 3,
  excludeCandidateIds: [],
};

export const PUBLIC_TOOLS = ['search_places', 'get_place_details', 'respond'] as const;
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

function streamOf(parts: RuntimeGateModelStreamPart[]): ReadableStream<RuntimeGateModelStreamPart> {
  return new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });
}

function toolParts(
  call: number,
  toolName: RuntimeGateToolName,
  input: RuntimeGateModelInput,
): RuntimeGateModelStreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...stepToolParts(call, toolName, input),
    { type: 'finish', usage, finishReason: toolFinish },
  ];
}

function nextParts(scenario: RuntimeGateScenario, call: number): RuntimeGateModelStreamPart[] {
  if (scenario === 'read-submit') {
    return [
      { type: 'stream-start', warnings: [] },
      ...stepToolParts(call, 'get_place_details', detailsInput),
      ...stepToolParts(call, 'respond', validSubmitInput),
      { type: 'finish', usage, finishReason: toolFinish },
    ];
  }
  if (scenario === 'empty-final') {
    return call === 0
      ? toolParts(call, 'respond', validSubmitInput)
      : [
          { type: 'stream-start', warnings: [] },
          { type: 'finish', usage, finishReason: stopFinish },
        ];
  }
  if (scenario === 'invalid') {
    if (call === 0) return toolParts(call, 'respond', invalidSubmitInput);
    if (call === 1) return toolParts(call, 'get_place_details', detailsInput);
    return toolParts(call, 'respond', validSubmitInput);
  }
  if (scenario === 'search') {
    return call === 0
      ? toolParts(call, 'search_places', searchInput)
      : toolParts(call, 'respond', answerInput('Fixture search completed.'));
  }
  return toolParts(call, 'respond', answerInput('Fixture message completed.'));
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
      return Promise.resolve({ stream: streamOf(nextParts(scenario, currentCall)) });
    },
  };
}
