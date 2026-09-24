import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type {
  CommitHashPort,
  CommitPort,
  CommitPortResult,
  CommitRequest,
} from '@worker/application/ports/commit';
import type { HarnessContext } from '@worker/application/ports/context';
import type {
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesOutput,
} from '@worker/application/ports/operations';
import type { Result } from '@worker/domain/result';
import type { SubmitCardsPort } from '@worker/application/ports/submission';
import type { SubmitValidationContext } from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';
import type { JSONValue, TextStreamPart, ToolResultPart, ToolSet } from 'ai';
import { createToolRegistry } from '../../adapters/inbound/tools/registry-fixture';
import { modelFor } from '../../support/runtime-model-fixture';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '@worker/runtime/budget/runtime-budget';
import {
  createRuntimeTurnComposition,
  type RuntimeCompositionModelContext,
  type RuntimeCompositionPersistMessages,
  type RuntimeCompositionTurnRequest,
  type RuntimePublicResponseDependencies,
  type RuntimeTurnCompositionCoreOptions,
  type RuntimeTurnCompositionPublicOptions,
} from '@worker/composition/runtime-turn-composition';
import type { RuntimeRetentionContext } from '@worker/runtime/retention/runtime-retention';
import type { RuntimeTurnPortDependencies } from '@worker/runtime/turn-execution/runtime-turn-factory';

export const NOW = '2026-09-10T00:00:00Z';
export const SCOPE = { ownerScopeRef: 'owner-tools', threadId: 'thread-tools' };
export const context: HarnessContext = {
  ...SCOPE,
  turnId: 'turn-composition',
  revision: 1,
  serverNow: NOW,
  location: {
    status: 'unavailable',
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision: 1,
  },
  preferences: {
    areaText: '渋谷',
    budget: 'normal',
  },
  budget: {
    wallClockMs: 12_000,
    finalReserveMs: 2_000,
    modelCallsRemaining: 6,
    readCallsRemaining: 8,
    providerHttpRequestsRemaining: 20,
    retriesRemaining: 1,
  },
  capabilities: {
    version: 'runtime-composition-v1',
    detailFields: ['identity'],
    supportedScopes: ['runtime-fixture'],
  },
};

export const retention = {
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  turnId: context.turnId,
  retention: {
    retentionDecision: 'deny',
    retentionMode: 'session_only',
    sessionExpiresAt: '2026-09-10T04:00:00Z',
    freshUntil: null,
    displayUntil: null,
    retentionUntil: null,
    deletionScheduledAt: null,
    attribution: null,
    restoreMode: 'reference_only',
    policyStatus: 'policy_withheld',
    displayPolicyStatus: 'policy_withheld',
  },
} as const;

export const allowRetention = {
  ...retention,
  retention: {
    retentionDecision: 'allow',
    retentionMode: 'session_only',
    sessionExpiresAt: '2026-09-10T04:00:00Z',
    freshUntil: '2026-09-10T00:01:00Z',
    displayUntil: '2026-09-10T00:01:30Z',
    retentionUntil: '2026-09-10T00:01:45Z',
    deletionScheduledAt: '2026-09-10T00:01:45Z',
    attribution: null,
    restoreMode: 'full',
    policyStatus: 'available',
    displayPolicyStatus: 'available',
  },
} as const;

export const modelContext: RuntimeCompositionModelContext = {
  userText: 'ORIGINAL_USER_CANARY',
  history: [],
  cardSet: null,
  evidence: [],
};

export const validationContext: SubmitValidationContext = {
  scope: SCOPE,
  serverNow: NOW,
  expectedObservationContext: {
    ownerScopeRef: SCOPE.ownerScopeRef,
    threadId: SCOPE.threadId,
    capabilityVersion: 'runtime-composition-v1',
    locationRevision: 1,
    timeContext: 'now',
  },
  requireLastOrderAtArrival: false,
};

export const searchResult: Result<SearchPlacesOutput> = {
  status: 'ok',
  data: {
    searchId: 'search-composition',
    candidates: [],
    applied: { areaDescription: '渋谷', excludedCount: 0 },
    nextCursor: null,
    coverage: 'provider_results',
  },
  warnings: [],
};

export class RecordingCommit implements CommitPort {
  readonly requests: CommitRequest[] = [];

  constructor(private readonly receiptResponseId?: string) {}

  commit(request: CommitRequest): CommitPortResult {
    this.requests.push(request);
    return {
      status: 'committed',
      receipt: {
        responseId: this.receiptResponseId ?? request.record.responseId,
        revision: request.record.revision,
        payloadDigest: request.record.payloadDigest,
        presentation: request.record.presentation,
        replayed: this.receiptResponseId !== undefined,
      },
    };
  }
}

const createBudget = (overrides: Partial<RuntimeBudgetConfig> = {}): RuntimeBudget =>
  new RuntimeBudget({
    config: { ...DEFAULT_RUNTIME_BUDGET, ...overrides },
    startedAtMs: 0,
    now: () => 1,
  });

const createPorts = (
  calls: { readonly search: number[] },
  registry: CandidateObservationRegistryPort,
): RuntimeTurnPortDependencies => {
  const search: PlaceSearchPort = {
    search: (_input, _context, _execution, cancellation) => {
      if (cancellation.isCancelled()) {
        return Promise.resolve({
          status: 'error',
          error: {
            code: 'CANCELLED',
            path: null,
            retryable: false,
            retryAfterMs: null,
            message: 'cancelled',
            missingFields: [],
          },
        });
      }
      calls.search.push(1);
      return Promise.resolve(searchResult);
    },
  };
  const details: PlaceDetailsPort = {
    read: () =>
      Promise.resolve({
        status: 'error',
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          path: null,
          retryable: false,
          retryAfterMs: null,
          message: 'details fixture not used',
          missingFields: [],
        },
      }),
  };
  const submit: SubmitCardsPort = {
    submit: () =>
      Promise.resolve({
        status: 'invalid',
        issues: [
          {
            code: 'INVALID_ARGUMENT',
            path: 'submit',
            message: 'raw submit should not be called',
            missingFields: [],
          },
        ],
        repairable: false,
        remainingRepairs: 0,
      }),
  };
  return { registry, clock: () => NOW, search, details, submit };
};

export const createComposition = (
  commit = new RecordingCommit(),
  currentTurnStart: number | undefined = 1,
  retentionValue: RuntimeRetentionContext = retention,
  clock: () => string = () => NOW,
  hashes: CommitHashPort = { digest: () => 'composition-digest' },
  publicResponse?: RuntimePublicResponseDependencies,
  input: Pick<RuntimeTurnCompositionCoreOptions, 'historyRetention'> & {
    readonly modelContext?: RuntimeCompositionModelContext;
  } = {},
) => {
  const calls = { search: [] as number[] };
  const fixture = createToolRegistry();
  const registry = fixture.registry;
  const model = modelFor('message', { calls: 0, requests: [] });
  const request: RuntimeCompositionTurnRequest = {
    ...SCOPE,
    turnId: context.turnId,
    revision: context.revision,
    serverNow: NOW,
    messages: [{ id: 'request-user', role: 'user', parts: [{ type: 'text', text: 'raw' }] }],
  };
  const persistMessages: RuntimeCompositionPersistMessages = () =>
    Promise.resolve({ requestId: 'composition-request', status: 'completed' });
  const baseOptions = {
    request,
    context,
    model,
    modelContext: input.modelContext ?? modelContext,
    ...(input.historyRetention === undefined ? {} : { historyRetention: input.historyRetention }),
    retention: retentionValue,
    budget: createBudget(),
    clock,
    ids: {
      nextCallId: () => 'composition-call',
      nextResponseId: () => 'composition-response',
    },
    hashes,
    registry,
    ports: createPorts(calls, registry),
    commit,
    resolveReadCost: () => ({ costUnits: 1, providerHttpRequests: 1 }),
    validationContext,
    persistMessages,
    isFinalResponse: () => true,
    ...(currentTurnStart === undefined ? {} : { currentTurnStart }),
    idempotencyKey: 'composition-idempotency',
  } satisfies Omit<RuntimeTurnCompositionCoreOptions, 'publicResponse'>;
  const composition =
    publicResponse === undefined
      ? createRuntimeTurnComposition(baseOptions)
      : createRuntimeTurnComposition({
          ...baseOptions,
          publicResponse,
        } satisfies RuntimeTurnCompositionPublicOptions);
  return {
    composition,
    calls,
    model,
    registry,
    currentCandidateId: fixture.currentCandidateId,
  };
};

export type CompositionPart = TextStreamPart<ToolSet>;

export type CapturedToolResult = {
  readonly toolCallId: string;
  readonly output: ToolResultPart['output'];
};

export const captureToolResult = async (
  composition: ReturnType<typeof createComposition>['composition'],
  output: JSONValue,
): Promise<CapturedToolResult> => {
  const transform = composition.retention.transform;
  if (Array.isArray(transform)) throw new Error('composition transform must be a single stream');
  const source = new ReadableStream<CompositionPart>({
    start(controller) {
      controller.enqueue({
        type: 'tool-call',
        toolCallId: 'provider-call',
        toolName: 'search_places',
        input: { query: 'provider-input' },
        dynamic: true,
      });
      controller.enqueue({
        type: 'tool-result',
        toolCallId: 'provider-call',
        toolName: 'search_places',
        input: { query: 'provider-input' },
        output: { type: 'json', value: output },
        dynamic: true,
      });
      controller.close();
    },
  });
  const transformed = source.pipeThrough(transform({ tools: {}, stopStream: () => undefined }));
  const reader = transformed.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error('tool result was not transformed');
    if (next.value.type === 'tool-result') {
      return { toolCallId: next.value.toolCallId, output: { type: 'json', value: output } };
    }
  }
};

export const stepMessages = (toolCallId: string, output: CapturedToolResult['output']) => [
  { role: 'user' as const, content: 'current-turn' },
  {
    role: 'assistant' as const,
    content: [{ type: 'tool-call' as const, toolCallId, toolName: 'search_places', input: {} }],
  },
  {
    role: 'tool' as const,
    content: [{ type: 'tool-result' as const, toolCallId, toolName: 'search_places', output }],
  },
  { role: 'assistant' as const, content: 'next-step' },
];
