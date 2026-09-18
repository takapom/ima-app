import { createPublicToolSet } from '@worker/infrastructure/adapters/inbound/tools';
import type { PrepareStepContext, Session, TurnContext } from '@cloudflare/think';
import type {
  GetPlaceDetailsOutput,
  HarnessContext,
  Result,
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesOutput,
  SubmitCardsPort,
  SubmitCardsPortResult,
} from '@ima/core';
import type { ThreadTurnRequest } from '@ima/contracts';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '@worker/infrastructure/runtime/budget/runtime-budget';
import {
  createRuntimeThinkConnection,
  RuntimeThinkConnectionError,
  type RuntimeThinkComposition,
  type RuntimeThinkPersistMessages,
} from '@worker/infrastructure/runtime/turn-execution/runtime-think-connection';
import { createRuntimeTurnFactory } from '@worker/infrastructure/runtime/turn-execution/runtime-turn-factory';
import {
  RUNTIME_RETENTION_WITHHELD,
  redactedRuntimeToolInput,
  type RuntimeRetentionContext,
} from '@worker/infrastructure/runtime/retention/runtime-retention';
import { createRuntimeRetentionTransform } from '@worker/infrastructure/runtime/retention/runtime-retention-transform';
import { createToolRegistry } from '../../adapters/inbound/tools/registry-fixture';
import { modelFor } from '../../support/runtime-model-fixture';

const NOW = '2026-09-10T00:00:00Z';

const runtimeInput = {
  schemaVersion: 'v1',
  requestId: 'runtime-input-request',
  turnId: 'turn-runtime-connection',
  revision: 1,
  text: '入力の条件',
  clientNow: NOW,
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    homeStationRef: null,
    maxWalkMinutes: null,
    minimumStayMinutes: null,
    areaText: '渋谷',
    budget: 'normal',
  },
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: 'runtime-input-key',
} satisfies ThreadTurnRequest;

const RETENTION = {
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
} as const;

const context: HarnessContext = {
  threadId: 'thread-runtime-connection',
  turnId: 'turn-runtime-connection',
  revision: 1,
  serverNow: NOW,
  ownerScopeRef: 'owner-runtime-connection',
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
    version: 'runtime-turn-factory-v1',
    detailFields: ['identity'],
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['runtime-fixture'],
  },
};

const errorResult = <T>(): Result<T> => ({
  status: 'error',
  error: {
    code: 'UPSTREAM_UNAVAILABLE',
    path: null,
    retryable: true,
    retryAfterMs: null,
    message: 'runtime connection fixture upstream failure',
    missingFields: [],
  },
});

const createPorts = () => {
  const registry = createToolRegistry().registry;
  const search: PlaceSearchPort = {
    search: (): Promise<Result<SearchPlacesOutput>> => Promise.resolve(errorResult()),
  };
  const details: PlaceDetailsPort = {
    read: (): Promise<Result<GetPlaceDetailsOutput>> => Promise.resolve(errorResult()),
  };
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

const createBudget = (overrides: Partial<RuntimeBudgetConfig> = {}): RuntimeBudget =>
  new RuntimeBudget({
    config: { ...DEFAULT_RUNTIME_BUDGET, ...overrides },
    startedAtMs: 0,
    now: () => 1,
  });

const retention: RuntimeRetentionContext = {
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  turnId: context.turnId,
  retention: RETENTION,
};

const retentionTransform = createRuntimeRetentionTransform({
  projectToolInput: (toolName) => redactedRuntimeToolInput(toolName),
  projectToolOutput: () => ({
    output: { status: 'withheld' },
    localFreshUntil: NOW,
    localExpiresAt: '2026-09-10T00:05:00Z',
  }),
});

const configureSession = (session: Session): Session =>
  session.onCompaction((messages) => {
    const first = messages[0];
    const last = messages.at(-1);
    return Promise.resolve(
      first === undefined || last === undefined
        ? null
        : {
            summary: RUNTIME_RETENTION_WITHHELD,
            fromMessageId: first.id,
            toMessageId: last.id,
          },
    );
  });

const userMessage = (text: string): UIMessage => ({
  id: 'runtime-connection-user',
  role: 'user',
  parts: [{ type: 'text', text }],
});

const buildComposition = (
  onAccepted: NonNullable<RuntimeThinkComposition['onAccepted']>,
  projection: RuntimeThinkComposition['projectStep'],
  persistMessages: RuntimeThinkPersistMessages,
  turnContext: HarnessContext = context,
): RuntimeThinkComposition<{ readonly responseId: string }> => {
  const applied: Array<{ readonly maxWalkMinutes: number | null }> = [];
  const ports = createPorts();
  const turn = createRuntimeTurnFactory({
    createTools: createPublicToolSet,
    context: turnContext,
    budget: createBudget(),
    ids: {
      nextCallId: (() => {
        let next = 0;
        return () => `runtime-connection-call-${++next}`;
      })(),
    },
    ports,
    constraintContext: { threadId: turnContext.threadId, originalTurns: [] },
    applyMetadata: (_metadata, conditions) => applied.push(conditions),
    stopWhen: () => true,
    beforeStep: () => ({ activeTools: ['search_places', 'get_place_details', 'submit_cards'] }),
  });
  return {
    model: modelFor('message', { calls: 0, requests: [] }),
    turn,
    retention: { context: retention, transform: retentionTransform },
    projectStep: projection,
    persistMessages,
    isFinalResponse: () => true,
    onAccepted,
    getCommittedResponse: () => ({ responseId: 'response-runtime-connection' }),
    dispose: () => {
      expect(applied).toEqual([]);
    },
  };
};

const turnContext = (model: TurnContext['model'], tools: TurnContext['tools']): TurnContext => ({
  system: '',
  messages: [],
  tools,
  model,
  continuation: false,
});

const stepContext = (model: PrepareStepContext['model']): PrepareStepContext => ({
  steps: [],
  stepNumber: 0,
  model,
  messages: [],
  experimental_context: undefined,
});

describe('RuntimeThinkConnection', () => {
  it('fails closed before an injected per-turn composition exists', () => {
    const connection = createRuntimeThinkConnection({
      clock: () => NOW,
      buildTurn: () => {
        throw new Error('builder should not run');
      },
      configureSession,
    });

    expect(() => connection.getModel()).toThrowError(
      new RuntimeThinkConnectionError('RUNTIME_UNCONFIGURED'),
    );
    expect(() => connection.getTools()).toThrowError(
      new RuntimeThinkConnectionError('RUNTIME_UNCONFIGURED'),
    );
  });

  it('connects the guarded model, factory hooks, current projection, and save boundary', async () => {
    const accepted: string[] = [];
    const projectedAt: string[] = [];
    let saved: UIMessage[] = [];
    let disposed = 0;
    type Connection = ReturnType<
      typeof createRuntimeThinkConnection<{
        readonly responseId: string;
      }>
    >;
    const holder: { connection?: Connection } = {};
    const getConnection = (): Connection => {
      const value = holder.connection;
      if (value === undefined) throw new Error('connection fixture is not initialized');
      return value;
    };
    const persist: RuntimeThinkPersistMessages = async (messages, options) => {
      expect(options?.signal?.aborted).toBe(false);
      saved = typeof messages === 'function' ? await messages([]) : messages;
      const connection = getConnection();
      const model = connection.getModel();
      const tools = connection.getTools();
      const turnConfig = await connection.beforeTurn(turnContext(model, tools));
      expect(turnConfig.experimental_transform).toBe(retentionTransform);
      const step = await connection.beforeStep(stepContext(model));
      expect(step).toMatchObject({ messages: [{ content: 'M08-current-turn-projection' }] });
      await connection.beforeToolCall({
        type: 'tool-call',
        toolCallId: 'runtime-connection-tool',
        toolName: 'search_places',
        input: {},
        dynamic: true,
        stepNumber: 0,
        messages: [],
        abortSignal: options?.signal,
      });
      const result = await model.doStream({ prompt: [] });
      const reader = result.stream.getReader();
      while (!(await reader.read()).done) {
        // Drain the guard's replay stream so the accepted provider step is complete.
      }
      reader.releaseLock();
      return { requestId: 'runtime-connection-request', status: 'completed' };
    };
    const connection = createRuntimeThinkConnection<{ readonly responseId: string }>({
      clock: () => NOW,
      buildTurn: (request) => {
        expect(request.runtimeInput).toBe(runtimeInput);
        const composition = buildComposition(
          (acceptance) => {
            if (acceptance.finalText !== null) accepted.push(acceptance.finalText);
          },
          (_step, serverNow) => {
            projectedAt.push(serverNow);
            return {
              messages: [{ role: 'user', content: 'M08-current-turn-projection' }],
            };
          },
          persist,
        );
        return {
          ...composition,
          dispose: () => {
            disposed += 1;
            composition.dispose();
          },
        };
      },
      configureSession,
    });
    holder.connection = connection;
    const result = await connection.run({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      turnId: context.turnId,
      revision: context.revision,
      messages: [userMessage('secret-user-body')],
      runtimeInput,
    });

    expect(result).toEqual({
      requestId: 'runtime-connection-request',
      status: 'completed',
      response: { responseId: 'response-runtime-connection' },
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toContain('Fixture message completed.');
    expect(projectedAt).toEqual([NOW]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.parts).toEqual([{ type: 'text', text: RUNTIME_RETENTION_WITHHELD }]);
    expect(saved[0]?.metadata).toMatchObject({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      turnId: context.turnId,
    });
    expect(disposed).toBe(1);
    expect(connection.isActive()).toBe(false);
    expect(() => connection.getModel()).toThrowError(
      new RuntimeThinkConnectionError('RUNTIME_UNCONFIGURED'),
    );
  });

  it('does not build or persist a pre-aborted turn', async () => {
    const controller = new AbortController();
    controller.abort();
    let builds = 0;
    const connection = createRuntimeThinkConnection({
      clock: () => NOW,
      buildTurn: () => {
        builds += 1;
        throw new Error('pre-aborted turn was built');
      },
      configureSession,
    });
    await expect(
      connection.run({
        ownerScopeRef: context.ownerScopeRef,
        threadId: context.threadId,
        turnId: context.turnId,
        revision: context.revision,
        messages: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(builds).toBe(0);
  });

  it('cancels a turn while the asynchronous builder is still resolving', async () => {
    let markBuildStarted!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      markBuildStarted = resolve;
    });
    let releaseBuild!: () => void;
    const buildRelease = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const persist: RuntimeThinkPersistMessages = () =>
      Promise.resolve({ requestId: 'unexpected', status: 'completed' });
    const connection = createRuntimeThinkConnection({
      clock: () => NOW,
      configureSession,
      buildTurn: async () => {
        markBuildStarted();
        await buildRelease;
        return buildComposition(
          () => undefined,
          () => ({ messages: [] }),
          persist,
        );
      },
    });
    const running = connection.run({
      ownerScopeRef: context.ownerScopeRef,
      threadId: context.threadId,
      turnId: context.turnId,
      revision: context.revision,
      messages: [],
    });
    await buildStarted;
    connection.cancel();
    releaseBuild();
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(connection.isActive()).toBe(false);
  });

  it('preserves the run error while still disposing after a cleanup failure', async () => {
    const runError = new Error('persist failed');
    let turn: RuntimeThinkComposition['turn'] | undefined;
    const connection = createRuntimeThinkConnection({
      clock: () => NOW,
      configureSession,
      buildTurn: () => {
        const composition = buildComposition(
          () => undefined,
          () => ({ messages: [] }),
          () => Promise.reject(runError),
        );
        turn = composition.turn;
        return {
          ...composition,
          dispose: () => {
            throw new Error('cleanup failed');
          },
        };
      },
    });
    await expect(
      connection.run({
        ownerScopeRef: context.ownerScopeRef,
        threadId: context.threadId,
        turnId: context.turnId,
        revision: context.revision,
        messages: [],
      }),
    ).rejects.toBe(runError);
    expect(turn?.isDisposed()).toBe(true);
    expect(connection.isActive()).toBe(false);
  });

  it('rejects a composition whose factory context changes the requested turn', async () => {
    const persist: RuntimeThinkPersistMessages = () =>
      Promise.resolve({ requestId: 'unexpected', status: 'completed' });
    const mismatchedContext: HarnessContext = {
      ...context,
      turnId: 'turn-other',
    };
    const connection = createRuntimeThinkConnection({
      clock: () => NOW,
      configureSession,
      buildTurn: () =>
        buildComposition(
          () => undefined,
          () => ({ messages: [] }),
          persist,
          mismatchedContext,
        ),
    });
    await expect(
      connection.run({
        ownerScopeRef: context.ownerScopeRef,
        threadId: context.threadId,
        turnId: context.turnId,
        revision: context.revision,
        messages: [],
      }),
    ).rejects.toMatchObject({ code: 'COMPOSITION_INVALID' });
  });
});
