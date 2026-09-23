import type {
  CommitHashPort,
  CommitPort,
  CommitPortResult,
  CommitRequest,
} from '@worker/application/ports/commit';
import type { CommittedResponse } from '@worker/application/use-cases/submit-response/submit-application';
import type { HarnessContext } from '@worker/application/ports/context';
import type {
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesOutput,
} from '@worker/application/ports/operations';
import type { Result } from '@worker/domain/result';
import type { SubmitCardsPort, SubmitCardsPortResult } from '@worker/application/ports/submission';
import type { SubmitValidationContext } from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_BUDGET, RuntimeBudget } from '@worker/runtime/budget/runtime-budget';
import {
  createRuntimeThinkConnection,
  type RuntimeThinkConnection,
  type RuntimeThinkPersistMessages,
} from '@worker/runtime/turn-execution/runtime-think-connection';
import { createRuntimeTurnComposition } from '@worker/composition/runtime-turn-composition';
import type {
  RuntimeModelGuardModel,
  RuntimeModelGuardStreamPart,
} from '@worker/runtime/turn-execution/runtime-model-guard';
import { createToolRegistry, toolScope } from '../../adapters/inbound/tools/registry-fixture';

const NOW = '2026-09-10T00:00:00Z';
const TURN_ID = 'runtime-cancel-turn';
const RESPONSE_ID = 'runtime-cancel-response';
const scope = { ownerScopeRef: toolScope.ownerScopeRef, threadId: toolScope.threadId };

const retention = {
  ownerScopeRef: scope.ownerScopeRef,
  threadId: scope.threadId,
  turnId: TURN_ID,
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

const context: HarnessContext = {
  ...scope,
  turnId: TURN_ID,
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
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: 'fixture',
    budget: 'normal',
  },
  budget: {
    wallClockMs: 12_000,
    finalReserveMs: 2_000,
    modelCallsRemaining: 6,
    readCallsRemaining: 8,
    providerHttpRequestsRemaining: 20,
    retriesRemaining: 0,
  },
  capabilities: {
    version: 'runtime-cancel-v1',
    detailFields: ['identity'],
    supportedScopes: ['runtime-fixture'],
  },
};

const validationContext: SubmitValidationContext = {
  scope,
  serverNow: NOW,
  expectedObservationContext: {
    ownerScopeRef: scope.ownerScopeRef,
    threadId: scope.threadId,
    capabilityVersion: 'runtime-cancel-v1',
    locationRevision: 1,
    timeContext: 'now',
  },
  requireLastOrderAtArrival: false,
};

const errorResult = <T>(): Result<T> => ({
  status: 'error',
  error: {
    code: 'UPSTREAM_UNAVAILABLE',
    path: null,
    retryable: false,
    retryAfterMs: null,
    message: 'cancel fixture does not use this port',
    missingFields: [],
  },
});

const createPorts = () => {
  const registry = createToolRegistry().registry;
  const search: PlaceSearchPort = {
    search: () => Promise.resolve(errorResult<SearchPlacesOutput>()),
  };
  const details: PlaceDetailsPort = { read: () => Promise.resolve(errorResult<never>()) };
  const submit: SubmitCardsPort = {
    submit: (): Promise<SubmitCardsPortResult> =>
      Promise.resolve({
        status: 'invalid',
        issues: [],
        repairable: false,
        remainingRepairs: 0,
      }),
  };
  return { registry, clock: () => NOW, search, details, submit };
};

class RecordingCommit implements CommitPort {
  calls = 0;

  commit(request: CommitRequest): CommitPortResult {
    this.calls += 1;
    return {
      status: 'committed',
      receipt: {
        responseId: request.record.responseId,
        revision: request.record.revision,
        payloadDigest: request.record.payloadDigest,
        presentation: request.record.presentation,
        replayed: false,
      },
    };
  }
}

class DeferredHash implements CommitHashPort {
  private resolver: ((value: string) => void) | undefined;
  private markStarted: () => void = () => undefined;
  private readonly started: Promise<void>;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  digest(_value: string): Promise<string> {
    this.markStarted();
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  waitStarted(): Promise<void> {
    return this.started;
  }

  release(): void {
    const resolver = this.resolver;
    if (resolver === undefined) throw new Error('cancel hash was not started');
    this.resolver = undefined;
    resolver('runtime-cancel-hash');
  }
}

type FinalResponse = CommittedResponse;
type Connection = RuntimeThinkConnection<FinalResponse>;

const modelFor = (): RuntimeModelGuardModel => {
  type Part = RuntimeModelGuardStreamPart;
  const usage: Extract<Part, { type: 'finish' }>['usage'] = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const envelope = JSON.stringify({
    kind: 'final_message',
    message: { text: '取消前の最終文', evidenceIds: [], basis: 'conversational' },
  });
  const stream = (): ReadableStream<Part> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'runtime-cancel-final' });
        controller.enqueue({ type: 'text-delta', id: 'runtime-cancel-final', delta: envelope });
        controller.enqueue({ type: 'text-end', id: 'runtime-cancel-final' });
        controller.enqueue({
          type: 'finish',
          usage,
          finishReason: { unified: 'stop', raw: 'stop' },
        });
        controller.close();
      },
    });
  return {
    specificationVersion: 'v3',
    provider: 'runtime-cancel-fixture',
    modelId: 'runtime-cancel-fixture',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('RUNTIME_CANCEL_STREAM_ONLY')),
    doStream: () => Promise.resolve({ stream: stream() }),
  } satisfies RuntimeModelGuardModel;
};

const drain = async (stream: ReadableStream<RuntimeModelGuardStreamPart>): Promise<void> => {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // The guard has already buffered and accepted the complete final step.
    }
  } finally {
    reader.releaseLock();
  }
};

type CancellationMode = 'cancel' | 'signal';

const runCancellationScenario = async (mode: CancellationMode) => {
  const ports = createPorts();
  const hashes = new DeferredHash();
  const commits = new RecordingCommit();
  const budget = new RuntimeBudget({
    config: DEFAULT_RUNTIME_BUDGET,
    startedAtMs: 0,
    now: () => 1,
  });
  const requestMessages: UIMessage[] = [
    { id: 'runtime-cancel-user', role: 'user' as const, parts: [{ type: 'text', text: 'raw' }] },
  ];
  const modelContext = { userText: 'current turn', history: [], cardSet: null, evidence: [] };
  const holder: {
    connection?: Connection;
    composition?: ReturnType<typeof createRuntimeTurnComposition>;
  } = {};
  const persistMessages: RuntimeThinkPersistMessages = async () => {
    const connection = holder.connection;
    if (connection === undefined) {
      throw new Error('cancel fixture composition is not initialized');
    }
    const result = await connection.getModel().doStream({ prompt: [] });
    await drain(result.stream);
    return { requestId: 'runtime-cancel-persist', status: 'completed' };
  };
  const connection = createRuntimeThinkConnection<FinalResponse>({
    clock: () => NOW,
    configureSession: (session) => session,
    buildTurn: (turnRequest) => {
      const composition = createRuntimeTurnComposition({
        request: turnRequest,
        context,
        model: modelFor(),
        modelContext,
        retention,
        budget,
        clock: { now: () => NOW },
        ids: {
          nextCallId: () => 'runtime-cancel-call',
          nextResponseId: () => RESPONSE_ID,
        },
        hashes,
        registry: ports.registry,
        ports,
        commit: commits,
        resolveReadCost: () => ({ costUnits: 1, providerHttpRequests: 1, routeElements: 0 }),
        validationContext,
        persistMessages,
        isFinalResponse: () => true,
        currentTurnStart: 1,
      });
      holder.composition = composition;
      return composition;
    },
  });
  holder.connection = connection;
  const requestAbort = new AbortController();
  const running = connection.run({
    ...scope,
    turnId: TURN_ID,
    revision: context.revision,
    messages: requestMessages,
    ...(mode === 'signal' ? { signal: requestAbort.signal } : {}),
  });

  await hashes.waitStarted();
  if (mode === 'cancel') connection.cancel();
  else requestAbort.abort();
  const disposedAtCancellation = holder.composition?.turn.isDisposed() === true;
  hashes.release();
  const result = await running;
  return { result, commits, connection, disposedAtCancellation };
};

describe('RuntimeThinkConnection cancellation and Core composition', () => {
  it('clears Core ephemeral state before a delayed final hash can reach CommitPort on cancel()', async () => {
    const outcome = await runCancellationScenario('cancel');

    expect(outcome.disposedAtCancellation).toBe(true);
    expect(outcome.result).toMatchObject({ status: 'completed', response: null });
    expect(outcome.commits.calls).toBe(0);
    expect(outcome.connection.isActive()).toBe(false);
  });

  it('clears Core ephemeral state before a delayed final hash can reach CommitPort on request abort', async () => {
    const outcome = await runCancellationScenario('signal');

    expect(outcome.disposedAtCancellation).toBe(true);
    expect(outcome.result).toMatchObject({ status: 'completed', response: null });
    expect(outcome.commits.calls).toBe(0);
    expect(outcome.connection.isActive()).toBe(false);
  });
});
