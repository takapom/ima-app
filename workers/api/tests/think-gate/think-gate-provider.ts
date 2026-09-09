import type { LanguageModel } from 'ai';

export const THINK_GATE_TOOLS = ['search_places', 'get_place_details', 'submit_cards'] as const;
export type ThinkGateToolName = (typeof THINK_GATE_TOOLS)[number];

export type ThinkGateModel = Extract<LanguageModel, { specificationVersion: 'v3' }>;
export type ThinkGateModelOptions = Parameters<ThinkGateModel['doStream']>[0];
export type ThinkGateModelStream = Awaited<ReturnType<ThinkGateModel['doStream']>>;
export type ThinkGateStreamPart =
  ThinkGateModelStream['stream'] extends ReadableStream<infer Part> ? Part : never;

export type ThinkGateModelRequest = {
  call: number;
  toolNames: string[];
  activeTools: string[] | null;
  promptHasMarker: boolean;
  promptHasRequiredStoreFact: boolean;
  promptHasToolPayload: boolean;
};

export type ThinkGateModelReport = {
  calls: number;
  requests: ThinkGateModelRequest[];
};

export type ThinkGateScenario = 'mixed-step' | 'final-sentinel' | 'tool-result-sentinel';

export const REQUIRED_STORE_FACT = 'THINK_GATE_STORE_FACT_CAFE_LUNA';
export const DENIED_MARKER = REQUIRED_STORE_FACT;
export const TOOL_RESULT_PAYLOAD = 'THINK_GATE_TOOL_RESULT_PAYLOAD';

const usage: Extract<ThinkGateStreamPart, { type: 'finish' }>['usage'] = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const toolFinish = { unified: 'tool-calls', raw: 'tool-calls' } as const;
const stopFinish = { unified: 'stop', raw: 'stop' } as const;

const detailsInput = {
  requests: [{ candidateId: 'candidate-1', fields: ['identity'] }],
  freshness: 'reuse_valid',
};

const submitInput = {
  message: [
    {
      text: 'Candidate 1 is supported by the fixture observation.',
      evidenceIds: ['obs-identity-1'],
      basis: 'grounded',
    },
  ],
  hero: {
    candidateId: 'candidate-1',
    evidenceIds: ['obs-identity-1'],
    why: {
      text: 'Identity is supported by the fixture observation.',
      evidenceIds: ['obs-identity-1'],
      basis: 'grounded',
    },
  },
  alts: [],
};

function streamOf(parts: ThinkGateStreamPart[]): ReadableStream<ThinkGateStreamPart> {
  return new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });
}

function toolParts(
  toolName: ThinkGateToolName,
  call: number,
  input: unknown,
): ThinkGateStreamPart[] {
  const id = `think-gate-${toolName}-${call}`;
  const encoded = JSON.stringify(input);
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: encoded },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: encoded },
  ];
}

function mixedStep(call: number): ThinkGateStreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...toolParts('get_place_details', call, detailsInput),
    ...toolParts('submit_cards', call, submitInput),
    { type: 'finish', usage, finishReason: toolFinish },
  ];
}

function toolResultStep(call: number): ThinkGateStreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...toolParts('get_place_details', call, detailsInput),
    { type: 'finish', usage, finishReason: toolFinish },
  ];
}

function finalStep(call: number): ThinkGateStreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: `think-gate-text-${call}` },
    { type: 'text-delta', id: `think-gate-text-${call}`, delta: DENIED_MARKER },
    { type: 'text-end', id: `think-gate-text-${call}` },
    { type: 'finish', usage, finishReason: stopFinish },
  ];
}

function toolNames(options: ThinkGateModelOptions): string[] {
  if (Array.isArray(options.tools)) {
    return options.tools
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === 'string')
      .sort();
  }
  return Object.keys(options.tools ?? {}).sort();
}

export function createThinkGateModel(
  scenario: ThinkGateScenario,
  report: ThinkGateModelReport,
): ThinkGateModel {
  let call = 0;
  return {
    specificationVersion: 'v3',
    provider: 'm04-think-gate-scripted-provider',
    modelId: scenario,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('THINK_GATE_STREAM_ONLY')),
    doStream: (options: ThinkGateModelOptions) => {
      const currentCall = call;
      call += 1;
      report.calls += 1;
      const prompt = JSON.stringify(options.prompt) ?? '';
      report.requests.push({
        call: currentCall,
        toolNames: toolNames(options),
        activeTools: null,
        promptHasMarker: prompt.includes(DENIED_MARKER),
        promptHasRequiredStoreFact: prompt.includes(REQUIRED_STORE_FACT),
        promptHasToolPayload: prompt.includes(TOOL_RESULT_PAYLOAD),
      });
      const parts =
        scenario === 'mixed-step'
          ? mixedStep(currentCall)
          : scenario === 'final-sentinel'
            ? finalStep(currentCall)
            : currentCall === 0
              ? toolResultStep(currentCall)
              : finalStep(currentCall);
      return Promise.resolve({ stream: streamOf(parts) });
    },
  };
}
