import { createPublicToolSet } from '@worker/adapters/in/tools';
import type {
  GetPlaceDetailsInput,
  GetPlaceDetailsOutput,
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesInput,
  SearchPlacesOutput,
} from '@worker/application/ports/operations';
import type { HarnessContext, ToolExecutionContext } from '@worker/application/ports/context';
import type { RespondInput } from '@worker/application/ports/model';
import type { RespondPortResult, RespondPort } from '@worker/application/ports/submission';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '@worker/runtime/budget/runtime-budget';
import {
  createRuntimeTurnFactory,
  type RuntimeTurnFactoryOptions,
  type RuntimeTurnPortDependencies,
} from '@worker/runtime/turn-execution/runtime-turn-factory';
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
    supportedScopes: ['runtime-fixture'],
  },
};

export const searchInput: SearchPlacesInput = {
  mode: 'search',
  query: '静かなカフェ',
  area: { kind: 'named_area', name: '渋谷' },
  limit: 2,
  excludeCandidateIds: [],
};

export const detailsInput: GetPlaceDetailsInput = {
  requests: [{ candidateId: 'candidate-1', fields: ['identity'] }],
  freshness: 'reuse_valid',
};

export const submitInput: RespondInput = {
  kind: 'propose',
  message: ['候補です'],
  hero: { candidateId: 'candidate-1', why: '候補です' },
  alts: [],
};

export const searchResult = {
  status: 'ok' as const,
  data: {
    searchId: 'search-1',
    candidates: [],
    applied: { areaDescription: '渋谷', excludedCount: 0 },
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

export const committedResult: RespondPortResult = {
  status: 'committed',
  responseId: 'response-1',
  revision: 1,
  kind: 'propose',
  presentation: 'replace',
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
  const respond: RespondPort = {
    respond: (_input, execution) => {
      calls.submits.push(execution);
      return Promise.resolve(committedResult);
    },
  };
  return { registry, clock, search, details, respond };
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
  const stopWhen: NonNullable<RuntimeTurnFactoryOptions['stopWhen']> = () => true;
  const factory = createRuntimeTurnFactory({
    createTools: createPublicToolSet,
    context,
    budget: createBudget(),
    ids: { nextCallId: () => `server-call-${++call}` },
    ports: createPorts(calls, clock),
    stopWhen,
    ...overrides,
  });
  return { factory, stopWhen };
};

export const envelope = (extra: object = {}) => ({ input: searchInput, ...extra });
