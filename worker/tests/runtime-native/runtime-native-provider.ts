import type { GetPlaceDetailsInput } from '@worker/application/ports/operations';
import type { RespondInput } from '@worker/application/ports/model';
import {
  modelFor,
  type RuntimeGateModel,
  type RuntimeGateModelCallOptions,
  type RuntimeGateModelReport,
  type RuntimeGateModelStreamPart,
} from '../support/runtime-model-fixture';

/** The scripted provider is a deterministic SDK boundary, not a model-quality evaluation. */
export const RUNTIME_NATIVE_SCENARIOS = [
  'invalid-submit-details-valid',
  'empty-final-after-submit',
  'mixed-batch',
  'unexpected-sdk-error',
  'waiting-for-cancellation',
] as const;

export type RuntimeNativeScenario = (typeof RUNTIME_NATIVE_SCENARIOS)[number];

export const isRuntimeNativeScenario = (value: string): value is RuntimeNativeScenario =>
  RUNTIME_NATIVE_SCENARIOS.some((scenario) => scenario === value);

export type RuntimeNativeModel = RuntimeGateModel;
export type RuntimeNativeModelCallOptions = RuntimeGateModelCallOptions;
export type RuntimeNativeModelStreamPart = RuntimeGateModelStreamPart;
export type RuntimeNativeProviderOptions = {
  readonly openai?: {
    readonly reasoningEffort?: string;
    readonly strictJsonSchema?: boolean;
    readonly store?: boolean;
  };
};
export type RuntimeNativeModelReport = RuntimeGateModelReport & {
  readonly providerOptionsSeen: (RuntimeNativeProviderOptions | undefined)[];
  waitingStarted: boolean;
  abortObserved: boolean;
  rawProviderErrorDetailSeen: boolean;
};
export type RuntimeNativeToolName = 'get_place_details' | 'respond';

export type RuntimeNativeInputs = {
  readonly invalidSubmit: RespondInput;
  readonly details: GetPlaceDetailsInput;
  readonly validSubmit: RespondInput;
};

export type RuntimeNativeAction =
  | {
      readonly kind: 'tool';
      readonly name: RuntimeNativeToolName;
      readonly input: GetPlaceDetailsInput | RespondInput;
    }
  | { readonly kind: 'final'; readonly text: string };

export type RuntimeNativeScriptStep = {
  readonly actions: readonly RuntimeNativeAction[];
  readonly finish: 'tool-calls' | 'stop' | 'provider-error';
};

export type RuntimeNativeExpectedResult = {
  /** Number of SDK model calls before the native loop must stop or fail. */
  readonly modelCalls: number;
  /** Provider-emitted tool calls; the guard may reject them before execution. */
  readonly providerToolCalls: readonly RuntimeNativeToolName[];
  /** Durable reference-only commit count expected from the connected Core application. */
  readonly commitWrites: 0 | 1;
  readonly terminal: 'submit' | 'empty-final' | 'guard-rejected' | 'provider-error' | 'waiting';
  readonly guardError: 'MIXED_TERMINAL_ACTION' | null;
  readonly providerError: 'UNEXPECTED_SDK_ERROR' | null;
};

export type RuntimeNativeScenarioPlan = {
  readonly scenario: RuntimeNativeScenario;
  readonly steps: readonly RuntimeNativeScriptStep[];
  readonly expected: RuntimeNativeExpectedResult;
};

export type RuntimeNativeProviderErrorCode =
  'UNEXPECTED_SDK_ERROR' | 'EXTRA_MODEL_CALL' | 'GENERATE_NOT_CONFIGURED';

export class RuntimeNativeProviderError extends Error {
  readonly code: RuntimeNativeProviderErrorCode;

  constructor(code: RuntimeNativeProviderErrorCode, detail?: string) {
    super(
      detail === undefined
        ? `runtime native scripted provider failed: ${code}`
        : `runtime native scripted provider failed: ${code}: ${detail}`,
    );
    this.name = 'RuntimeNativeProviderError';
    this.code = code;
  }
}

const providerScenario = {
  'invalid-submit-details-valid': 'invalid',
  'empty-final-after-submit': 'empty-final',
  'mixed-batch': 'read-submit',
} as const;

const readStream = async (
  stream: ReadableStream<RuntimeNativeModelStreamPart>,
): Promise<RuntimeNativeModelStreamPart[]> => {
  const reader = stream.getReader();
  const parts: RuntimeNativeModelStreamPart[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return parts;
};

const rewriteToolInputs = (
  parts: readonly RuntimeNativeModelStreamPart[],
  actions: readonly RuntimeNativeAction[],
): RuntimeNativeModelStreamPart[] => {
  const encodedById = new Map<string, string>();
  const emittedDelta = new Set<string>();
  let actionIndex = 0;
  return parts.map((part) => {
    if (part.type === 'tool-input-start') {
      const action = actions[actionIndex];
      if (action?.kind !== 'tool' || action.name !== part.toolName) {
        throw new RuntimeNativeProviderError('EXTRA_MODEL_CALL');
      }
      actionIndex += 1;
      const encoded = JSON.stringify({ input: action.input });
      encodedById.set(part.id, encoded);
      return part;
    }
    if (part.type === 'tool-input-delta') {
      const encoded = encodedById.get(part.id);
      if (encoded === undefined) return part;
      if (emittedDelta.has(part.id)) return { ...part, delta: '' };
      emittedDelta.add(part.id);
      return { ...part, delta: encoded };
    }
    if (part.type === 'tool-call') {
      const encoded = encodedById.get(part.toolCallId);
      return encoded === undefined ? part : { ...part, input: encoded };
    }
    return part;
  });
};

export const createRuntimeNativeScenarioPlan = (
  scenario: RuntimeNativeScenario,
  inputs: RuntimeNativeInputs,
): RuntimeNativeScenarioPlan => {
  if (scenario === 'invalid-submit-details-valid') {
    return {
      scenario,
      steps: [
        {
          actions: [{ kind: 'tool', name: 'respond', input: inputs.invalidSubmit }],
          finish: 'tool-calls',
        },
        {
          actions: [{ kind: 'tool', name: 'get_place_details', input: inputs.details }],
          finish: 'tool-calls',
        },
        {
          actions: [{ kind: 'tool', name: 'respond', input: inputs.validSubmit }],
          finish: 'tool-calls',
        },
      ],
      expected: {
        modelCalls: 3,
        providerToolCalls: ['respond', 'get_place_details', 'respond'],
        commitWrites: 1,
        terminal: 'submit',
        guardError: null,
        providerError: null,
      },
    };
  }
  if (scenario === 'empty-final-after-submit') {
    return {
      scenario,
      steps: [
        {
          actions: [{ kind: 'tool', name: 'respond', input: inputs.validSubmit }],
          finish: 'tool-calls',
        },
        { actions: [{ kind: 'final', text: '' }], finish: 'stop' },
      ],
      expected: {
        modelCalls: 2,
        providerToolCalls: ['respond'],
        commitWrites: 1,
        terminal: 'empty-final',
        guardError: null,
        providerError: null,
      },
    };
  }
  if (scenario === 'mixed-batch') {
    return {
      scenario,
      steps: [
        {
          actions: [
            { kind: 'tool', name: 'get_place_details', input: inputs.details },
            { kind: 'tool', name: 'respond', input: inputs.validSubmit },
          ],
          finish: 'tool-calls',
        },
      ],
      expected: {
        modelCalls: 1,
        providerToolCalls: ['get_place_details', 'respond'],
        commitWrites: 0,
        terminal: 'guard-rejected',
        guardError: 'MIXED_TERMINAL_ACTION',
        providerError: null,
      },
    };
  }
  if (scenario === 'waiting-for-cancellation') {
    return {
      scenario,
      steps: [],
      expected: {
        modelCalls: 1,
        providerToolCalls: [],
        commitWrites: 0,
        terminal: 'waiting',
        guardError: null,
        providerError: null,
      },
    };
  }
  return {
    scenario,
    steps: [{ actions: [], finish: 'provider-error' }],
    expected: {
      modelCalls: 1,
      providerToolCalls: [],
      commitWrites: 0,
      terminal: 'provider-error',
      guardError: null,
      providerError: 'UNEXPECTED_SDK_ERROR',
    },
  };
};

const toolNames = (options: RuntimeNativeModelCallOptions): string[] => {
  if (Array.isArray(options.tools)) {
    return options.tools
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === 'string')
      .sort();
  }
  return Object.keys(options.tools ?? {}).sort();
};

const observedProviderOptions = (
  value: RuntimeNativeModelCallOptions['providerOptions'],
): RuntimeNativeProviderOptions | undefined => {
  const openai = value?.openai;
  if (typeof openai !== 'object' || openai === null || Array.isArray(openai)) return undefined;
  return {
    openai: {
      ...(typeof openai.reasoningEffort === 'string'
        ? { reasoningEffort: openai.reasoningEffort }
        : {}),
      ...(typeof openai.strictJsonSchema === 'boolean'
        ? { strictJsonSchema: openai.strictJsonSchema }
        : {}),
      ...(typeof openai.store === 'boolean' ? { store: openai.store } : {}),
    },
  };
};

const recordUnexpectedRequest = (
  report: RuntimeNativeModelReport,
  call: number,
  options: RuntimeNativeModelCallOptions,
): void => {
  report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
  report.calls += 1;
  const prompt = JSON.stringify(options.prompt) ?? '';
  report.requests.push({
    call,
    toolNames: toolNames(options),
    sawIdentityObservation: false,
    sawOpeningHoursObservation: false,
    sawMissingEvidence: prompt.includes('MISSING_EVIDENCE'),
    sawNativeContent: false,
    sawStaleNativeContent: false,
  });
};

const rawProviderErrorDetail = (options: RuntimeNativeModelCallOptions): string | undefined => {
  const prompt = JSON.stringify(options.prompt) ?? '';
  // The audit fixture deliberately simulates an upstream error carrying raw fields.
  return prompt.includes('M24_USER_SENTINEL')
    ? `${prompt} M24_PROVIDER_PAYLOAD_SENTINEL M24_KEY_SENTINEL`
    : undefined;
};

type RuntimeNativeStreamResult = Awaited<ReturnType<RuntimeNativeModel['doStream']>>;

const waitForAbort = (
  signal: AbortSignal,
  report: RuntimeNativeModelReport,
): Promise<RuntimeNativeStreamResult> =>
  new Promise((resolve) => {
    const onAbort = (): void => {
      report.abortObserved = true;
      signal.removeEventListener('abort', onAbort);
      resolve({ stream: streamOf([]) });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

/** Reuses the existing Worker V3 fixture for normal steps and only extends its error case. */
export const createRuntimeNativeModel = (
  scenario: RuntimeNativeScenario,
  inputs: RuntimeNativeInputs,
  report: RuntimeNativeModelReport,
): RuntimeNativeModel => {
  if (scenario === 'waiting-for-cancellation') {
    let call = 0;
    return {
      specificationVersion: 'v3',
      provider: 'm10-runtime-native-scripted-provider',
      modelId: scenario,
      supportedUrls: {},
      doGenerate: (options) => {
        recordUnexpectedRequest(report, call, options);
        call += 1;
        return Promise.reject(new RuntimeNativeProviderError('GENERATE_NOT_CONFIGURED'));
      },
      doStream: (options) => {
        recordUnexpectedRequest(report, call, options);
        call += 1;
        report.waitingStarted = true;
        const signal = options.abortSignal;
        return signal === undefined
          ? Promise.reject(new RuntimeNativeProviderError('GENERATE_NOT_CONFIGURED'))
          : waitForAbort(signal, report);
      },
    };
  }

  const plan = createRuntimeNativeScenarioPlan(scenario, inputs);
  if (scenario === 'unexpected-sdk-error') {
    let call = 0;
    return {
      specificationVersion: 'v3',
      provider: 'm10-runtime-native-scripted-provider',
      modelId: scenario,
      supportedUrls: {},
      doGenerate: (options) => {
        recordUnexpectedRequest(report, call, options);
        call += 1;
        const detail = rawProviderErrorDetail(options);
        report.rawProviderErrorDetailSeen ||= detail !== undefined;
        return Promise.reject(new RuntimeNativeProviderError('UNEXPECTED_SDK_ERROR', detail));
      },
      doStream: (options) => {
        recordUnexpectedRequest(report, call, options);
        call += 1;
        const detail = rawProviderErrorDetail(options);
        report.rawProviderErrorDetailSeen ||= detail !== undefined;
        return Promise.reject(new RuntimeNativeProviderError('UNEXPECTED_SDK_ERROR', detail));
      },
    };
  }

  const base = modelFor(providerScenario[scenario], report);
  let call = 0;
  return {
    ...base,
    provider: 'm10-runtime-native-scripted-provider',
    modelId: scenario,
    doStream: async (options) => {
      const currentCall = call;
      call += 1;
      report.providerOptionsSeen.push(observedProviderOptions(options.providerOptions));
      const step = plan.steps[currentCall];
      if (step === undefined) {
        throw new RuntimeNativeProviderError('EXTRA_MODEL_CALL');
      }
      const result = await base.doStream(options);
      const parts = await readStream(result.stream);
      return {
        ...result,
        stream: streamOf(rewriteToolInputs(parts, step.actions)),
      };
    },
  };
};

const streamOf = (
  parts: readonly RuntimeNativeModelStreamPart[],
): ReadableStream<RuntimeNativeModelStreamPart> =>
  new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });
