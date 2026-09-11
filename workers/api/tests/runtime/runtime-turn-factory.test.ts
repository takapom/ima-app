import type { TurnContext } from '@cloudflare/think';
import { TurnConstraintError } from '@ima/core';
import type {
  GetPlaceDetailsInput,
  GetPlaceDetailsOutput,
  HarnessContext,
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesInput,
  SearchPlacesOutput,
  SubmitCardsInput,
  SubmitCardsPort,
  SubmitCardsPortResult,
  ToolExecutionContext,
} from '@ima/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '../../src/runtime/runtime-budget';
import {
  createRuntimeTurnFactory,
  RuntimeTurnFactoryError,
  type RuntimeTurnFactoryOptions,
  type RuntimeTurnPortDependencies,
} from '../../src/runtime/runtime-turn-factory';
import { invokePublicToolEnvelope } from '../../src/tools';
import { createToolRegistry } from '../tools/registry-fixture';
import { modelFor } from '../support/runtime-model-fixture';

const context: HarnessContext = {
  threadId: 'thread-tools',
  turnId: 'turn-tools',
  revision: 1,
  serverNow: '2026-09-10T00:00:00Z',
  ownerScopeRef: 'owner-tools',
  location: {
    status: 'unavailable',
    coordinates: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
    revision: 1,
  },
  preferences: {
    homeStationRef: 'station-tools',
    maxWalkMinutes: 15,
    minimumStayMinutes: 20,
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

const searchInput: SearchPlacesInput = {
  mode: 'search',
  query: '静かなカフェ',
  area: { kind: 'named_area', name: '渋谷' },
  openNow: true,
  limit: 2,
  excludeCandidateIds: [],
};

const detailsInput: GetPlaceDetailsInput = {
  requests: [{ candidateId: 'candidate-1', fields: ['identity'] }],
  freshness: 'reuse_valid',
};

const submitInput: SubmitCardsInput = {
  message: [{ text: '候補です', evidenceIds: [], basis: 'conversational' }],
  hero: {
    candidateId: 'candidate-1',
    evidenceIds: [],
    why: { text: '候補です', evidenceIds: [], basis: 'conversational' },
  },
  alts: [],
};

const searchResult = {
  status: 'ok' as const,
  data: {
    searchId: 'search-1',
    candidates: [],
    applied: { areaDescription: '渋谷', openNow: true, excludedCount: 0 },
    nextCursor: null,
    coverage: 'provider_results' as const,
  },
  warnings: [],
} satisfies { status: 'ok'; data: SearchPlacesOutput; warnings: never[] };

const detailsResult = {
  status: 'ok' as const,
  data: {
    items: [
      {
        candidateId: 'candidate-1',
        fields: { identity: { status: 'unknown' as const, reason: 'fixture has no identity' } },
      },
    ],
  },
  warnings: [],
} satisfies { status: 'ok'; data: GetPlaceDetailsOutput; warnings: never[] };

const committedResult: SubmitCardsPortResult = {
  status: 'committed',
  responseId: 'response-1',
  revision: 1,
  presentation: 'replace',
  cards: submitInput,
};

type PortCalls = {
  readonly searches: HarnessContext[];
  readonly searchExecutions: ToolExecutionContext[];
  readonly details: HarnessContext[];
  readonly submits: ToolExecutionContext[];
};

const createPorts = (
  calls: PortCalls,
  clock: () => string = () => context.serverNow,
): RuntimeTurnPortDependencies => {
  const registry = createToolRegistry().registry;
  const search: PlaceSearchPort = {
    search: (_input, receivedContext, execution) => {
      calls.searches.push(receivedContext);
      calls.searchExecutions.push(execution);
      return Promise.resolve(searchResult);
    },
  };
  const details: PlaceDetailsPort = {
    read: (_input, receivedContext) => {
      calls.details.push(receivedContext);
      return Promise.resolve(detailsResult);
    },
  };
  const submit: SubmitCardsPort = {
    submit: (_input, execution) => {
      calls.submits.push(execution);
      return Promise.resolve(committedResult);
    },
  };
  return { registry, clock, search, details, submit };
};

const createBudget = (overrides: Partial<RuntimeBudgetConfig> = {}): RuntimeBudget =>
  new RuntimeBudget({
    config: { ...DEFAULT_RUNTIME_BUDGET, ...overrides },
    startedAtMs: 0,
    now: () => 1,
  });

const createFactory = (
  calls: PortCalls,
  overrides: Partial<RuntimeTurnFactoryOptions> = {},
  clock: () => string = () => context.serverNow,
) => {
  let call = 0;
  const applied: Array<{ readonly maxWalkMinutes: number | null }> = [];
  const stopWhen: NonNullable<RuntimeTurnFactoryOptions['stopWhen']> = () => true;
  const factory = createRuntimeTurnFactory({
    context,
    budget: createBudget(),
    ids: { nextCallId: () => `server-call-${++call}` },
    ports: createPorts(calls, clock),
    constraintContext: {
      threadId: context.threadId,
      originalTurns: [
        {
          threadId: context.threadId,
          turnId: 'turn-source',
          text: '最大徒歩を20分に変更する',
        },
      ],
    },
    applyMetadata: (_metadata, conditions) => {
      applied.push({ maxWalkMinutes: conditions.maxWalkMinutes });
    },
    stopWhen,
    ...overrides,
  });
  return { factory, applied, stopWhen };
};

const envelope = (metadata: object = {}) => ({ input: searchInput, metadata });

describe('createRuntimeTurnFactory', () => {
  it('keeps the exact public tool set and requires the injected stop condition', async () => {
    const calls: PortCalls = {
      searches: [],
      searchExecutions: [],
      details: [],
      submits: [],
    };
    const { factory, stopWhen } = createFactory(calls);
    expect(Object.keys(factory.tools).sort()).toEqual([
      'get_place_details',
      'search_places',
      'submit_cards',
    ]);

    const model = modelFor('message', { calls: 0, requests: [] });
    const turn: TurnContext = {
      system: '',
      messages: [],
      tools: factory.tools,
      model,
      continuation: false,
    };
    const config = await factory.hooks.beforeTurn(turn);
    expect(config).toMatchObject({
      activeTools: ['search_places', 'get_place_details', 'submit_cards'],
      maxSteps: 6,
      maxRetries: 0,
      stopWhen,
    });

    const thinkManagedTurn: TurnContext = {
      ...turn,
      tools: {
        ...factory.tools,
        bash: factory.tools.search_places,
        read: factory.tools.search_places,
        write: factory.tools.search_places,
      },
    };
    await expect(factory.hooks.beforeTurn(thinkManagedTurn)).resolves.toMatchObject({
      activeTools: ['search_places', 'get_place_details', 'submit_cards'],
    });

    const extraToolTurn: TurnContext = {
      ...turn,
      tools: { ...factory.tools, unknown_tool: factory.tools.search_places },
    };
    await expect(factory.hooks.beforeTurn(extraToolTurn)).rejects.toMatchObject({
      code: 'TOOL_SET_MISMATCH',
    });
  });

  it('applies validated turn conditions while preserving the base context and call snapshots', async () => {
    const calls: PortCalls = {
      searches: [],
      searchExecutions: [],
      details: [],
      submits: [],
    };
    const { factory, applied } = createFactory(calls);
    const constraint = {
      turnConstraints: {
        changes: [
          { maxWalkMinutes: 20, sourceTurnId: 'turn-source', quote: '最大徒歩を20分に変更する' },
        ],
      },
    };
    const first = await invokePublicToolEnvelope(
      'search_places',
      envelope(constraint),
      factory.dependencies,
      { toolCallId: 'sdk-search-1' },
    );
    expect(first.status).toBe('ok');
    expect(calls.searches[0]?.preferences.maxWalkMinutes).toBe(20);
    expect(factory.baseContext.preferences.maxWalkMinutes).toBe(15);
    expect(factory.context.preferences.maxWalkMinutes).toBe(20);
    expect(applied).toEqual([{ maxWalkMinutes: 20 }]);

    const second = await invokePublicToolEnvelope(
      'search_places',
      envelope({
        turnConstraints: {
          changes: [
            { maxWalkMinutes: 30, sourceTurnId: 'turn-source', quote: '最大徒歩を20分に変更する' },
          ],
        },
      }),
      factory.dependencies,
      { toolCallId: 'sdk-search-2' },
    );
    expect(second.status).toBe('ok');
    expect(calls.searches[1]?.preferences.maxWalkMinutes).toBe(30);

    const replay = await invokePublicToolEnvelope(
      'search_places',
      envelope(constraint),
      factory.dependencies,
      { toolCallId: 'sdk-search-1' },
    );
    expect(replay.status).toBe('ok');
    expect(calls.searches[2]?.preferences.maxWalkMinutes).toBe(20);
    expect(factory.context.preferences.maxWalkMinutes).toBe(30);
  });

  it('uses a stable server call ID and rejects reuse for another operation or metadata', async () => {
    const calls: PortCalls = {
      searches: [],
      searchExecutions: [],
      details: [],
      submits: [],
    };
    const { factory } = createFactory(calls);
    await invokePublicToolEnvelope('search_places', envelope(), factory.dependencies, {
      toolCallId: 'sdk-call-1',
    });
    await invokePublicToolEnvelope('search_places', envelope(), factory.dependencies, {
      toolCallId: 'sdk-call-1',
    });
    expect(calls.searches).toHaveLength(2);
    expect(calls.searchExecutions).toHaveLength(2);
    expect(calls.searchExecutions.map((execution) => execution.callId)).toEqual([
      'server-call-1',
      'server-call-1',
    ]);

    const conflict = await invokePublicToolEnvelope(
      'get_place_details',
      { input: detailsInput, metadata: {} },
      factory.dependencies,
      { toolCallId: 'sdk-call-1' },
    );
    expect(conflict.status).toBe('error');
    if (conflict.status === 'error') expect(conflict.error.code).toBe('MISSING_CONTEXT');
    expect(calls.details).toHaveLength(0);

    const metadataConflict = await invokePublicToolEnvelope(
      'search_places',
      envelope({
        turnConstraints: {
          changes: [
            { maxWalkMinutes: 20, sourceTurnId: 'turn-source', quote: '最大徒歩を20分に変更する' },
          ],
        },
      }),
      factory.dependencies,
      { toolCallId: 'sdk-call-1' },
    );
    expect(metadataConflict.status).toBe('error');
    if (metadataConflict.status === 'error') {
      expect(metadataConflict.error.code).toBe('MISSING_CONTEXT');
    }
    expect(calls.searches).toHaveLength(2);
  });

  it('rejects a quoted constraint before applying conditions or invoking a Port', () => {
    const calls: PortCalls = {
      searches: [],
      searchExecutions: [],
      details: [],
      submits: [],
    };
    const { factory, applied } = createFactory(calls);
    expect(() =>
      factory.dependencies.runtime(
        'search_places',
        { toolCallId: 'sdk-invalid-quote' },
        {
          turnConstraints: {
            changes: [
              {
                maxWalkMinutes: 20,
                sourceTurnId: 'turn-source',
                quote: 'この引用は元のturnに存在しない',
              },
            ],
          },
        },
      ),
    ).toThrowError(TurnConstraintError);
    expect(factory.getConditions()).toEqual({
      maxWalkMinutes: 15,
      homeStationRef: 'station-tools',
      minimumStayMinutes: 20,
    });
    expect(applied).toEqual([]);
    expect(calls.searches).toHaveLength(0);
  });

  it('reserves and commits submit through the shared RuntimeBudget', async () => {
    const calls: PortCalls = {
      searches: [],
      searchExecutions: [],
      details: [],
      submits: [],
    };
    const { factory } = createFactory(calls);
    const first = await invokePublicToolEnvelope(
      'submit_cards',
      { input: submitInput, metadata: {} },
      factory.dependencies,
      { toolCallId: 'sdk-submit-1' },
    );
    expect(first).toEqual(committedResult);
    expect(factory.budget.snapshot()).toMatchObject({ submitAttempts: 1, completed: true });

    const second = await invokePublicToolEnvelope(
      'submit_cards',
      { input: submitInput, metadata: {} },
      factory.dependencies,
      { toolCallId: 'sdk-submit-2' },
    );
    expect(second).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'BUDGET_EXCEEDED' }],
    });
    expect(calls.submits).toHaveLength(1);
  });

  it('builds the submit adapter with the latest clock and turn conditions', async () => {
    const calls: PortCalls = { searches: [], searchExecutions: [], details: [], submits: [] };
    let now = context.serverNow;
    const built: Array<{ now: string; maxWalkMinutes: number | null }> = [];
    const dynamicSubmit: SubmitCardsPort = {
      submit: () => Promise.resolve(committedResult),
    };
    const { factory } = createFactory(
      calls,
      {
        buildSubmitPort: ({ now: sampledNow, conditions }) => {
          built.push({ now: sampledNow, maxWalkMinutes: conditions.maxWalkMinutes });
          return dynamicSubmit;
        },
      },
      () => now,
    );
    await invokePublicToolEnvelope(
      'search_places',
      envelope({
        turnConstraints: {
          changes: [
            { maxWalkMinutes: 20, sourceTurnId: 'turn-source', quote: '最大徒歩を20分に変更する' },
          ],
        },
      }),
      factory.dependencies,
      { toolCallId: 'sdk-search-for-submit' },
    );
    now = '2026-09-10T00:01:00Z';
    const result = await invokePublicToolEnvelope(
      'submit_cards',
      { input: submitInput, metadata: {} },
      factory.dependencies,
      { toolCallId: 'sdk-submit-fresh-context' },
    );
    expect(result).toEqual(committedResult);
    expect(built).toEqual([{ now, maxWalkMinutes: 20 }]);
  });

  it('propagates caller abort and dispose to the factory signal before a Port call', async () => {
    const calls: PortCalls = {
      searches: [],
      searchExecutions: [],
      details: [],
      submits: [],
    };
    const controller = new AbortController();
    const { factory } = createFactory(calls, { signal: controller.signal });
    controller.abort();
    expect(factory.signal.aborted).toBe(true);
    const aborted = await invokePublicToolEnvelope(
      'search_places',
      envelope(),
      factory.dependencies,
      { toolCallId: 'sdk-aborted' },
    );
    expect(aborted.status).toBe('error');
    expect(calls.searches).toHaveLength(0);

    factory.dispose();
    expect(factory.isDisposed()).toBe(true);
    expect(() =>
      factory.dependencies.runtime('search_places', { toolCallId: 'sdk-after-dispose' }, {}),
    ).toThrow(RuntimeTurnFactoryError);
  });
});
