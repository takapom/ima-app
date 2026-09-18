import { createPublicToolSet } from '@worker/infrastructure/adapters/inbound/tools';
import type {
  GetPlaceDetailsInput,
  GetPlaceDetailsOutput,
  HarnessContext,
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesInput,
  SearchPlacesOutput,
  SubmitCardsInput,
  SubmitCardsPortResult,
  SubmitCardsPort,
  ToolExecutionContext,
} from '@ima/core';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '@worker/infrastructure/runtime/budget/runtime-budget';
import {
  createRuntimeTurnFactory,
  type RuntimeTurnFactoryOptions,
  type RuntimeTurnPortDependencies,
} from '@worker/infrastructure/runtime/turn-execution/runtime-turn-factory';
import { createToolRegistry } from '../adapters/inbound/tools/registry-fixture';

/** Reports no walking-route or last-train capability, matching the connected providers. */
export const context: HarnessContext = {
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

export const searchInput: SearchPlacesInput = {
  mode: 'search',
  query: '静かなカフェ',
  area: { kind: 'named_area', name: '渋谷' },
  openNow: true,
  limit: 2,
  excludeCandidateIds: [],
};

export const detailsInput: GetPlaceDetailsInput = {
  requests: [{ candidateId: 'candidate-1', fields: ['identity'] }],
  freshness: 'reuse_valid',
};

export const submitInput: SubmitCardsInput = {
  message: [{ text: '候補です', evidenceIds: [], basis: 'conversational' }],
  hero: {
    candidateId: 'candidate-1',
    evidenceIds: [],
    why: { text: '候補です', evidenceIds: [], basis: 'conversational' },
  },
  alts: [],
};

export const searchResult = {
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

export const detailsResult = {
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

export const committedResult: SubmitCardsPortResult = {
  status: 'committed',
  responseId: 'response-1',
  revision: 1,
  presentation: 'replace',
  cards: submitInput,
};

export type PortCalls = {
  readonly searches: HarnessContext[];
  readonly searchExecutions: ToolExecutionContext[];
  readonly details: HarnessContext[];
  readonly submits: ToolExecutionContext[];
};

export const emptyPortCalls = (): PortCalls => ({
  searches: [],
  searchExecutions: [],
  details: [],
  submits: [],
});

export const createPorts = (
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

export const createBudget = (overrides: Partial<RuntimeBudgetConfig> = {}): RuntimeBudget =>
  new RuntimeBudget({
    config: { ...DEFAULT_RUNTIME_BUDGET, ...overrides },
    startedAtMs: 0,
    now: () => 1,
  });

export const createFactory = (
  calls: PortCalls,
  overrides: Partial<RuntimeTurnFactoryOptions> = {},
  clock: () => string = () => context.serverNow,
) => {
  let call = 0;
  const applied: Array<{ readonly maxWalkMinutes: number | null }> = [];
  const stopWhen: NonNullable<RuntimeTurnFactoryOptions['stopWhen']> = () => true;
  const factory = createRuntimeTurnFactory({
    createTools: createPublicToolSet,
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

/** Capability-enabled variant for a constraint the base fixture intentionally denies. */
export const withWalkingRoute = (): Partial<RuntimeTurnFactoryOptions> => ({
  context: { ...context, capabilities: { ...context.capabilities, walkingRoute: true } },
});

export const envelope = (metadata: object = {}) => ({ input: searchInput, metadata });
