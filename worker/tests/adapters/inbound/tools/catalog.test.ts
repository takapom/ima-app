import { describe, expect, it } from 'vitest';
import {
  HarnessContextSchema,
  type CancellationToken,
  type HarnessContext,
  type ToolExecutionContext,
} from '@worker/application/ports/context';
import {
  type GetPlaceDetailsInput,
  type GetPlaceDetailsOutput,
  type PlaceDetailsPort,
  type PlaceSearchPort,
  type SearchPlacesInput,
  type SearchPlacesOutput,
} from '@worker/application/ports/operations';
import { type Result } from '@worker/domain/result';
import { type SubmitCardsInput } from '@worker/application/ports/model';
import {
  type SubmitCardsPort,
  type SubmitCardsPortResult,
} from '@worker/application/ports/submission';
import * as v from 'valibot';
import {
  createPublicToolSet,
  getPublicTool,
  invokePublicTool,
  invokePublicToolByName,
} from '@worker/adapters/in/tools';
import type { ToolBindingDependencies, ToolRuntime } from '@worker/adapters/in/tools';
import { createToolRegistry } from './registry-fixture';

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
    areaText: '渋谷',
    budget: 'normal',
  },
  budget: {
    wallClockMs: 2_000,
    finalReserveMs: 250,
    modelCallsRemaining: 4,
    readCallsRemaining: 5,
    providerHttpRequestsRemaining: 5,
    retriesRemaining: 1,
  },
  capabilities: {
    version: 'tools-v1',
    detailFields: ['identity'],
    supportedScopes: ['tools-fixture'],
  },
};

const searchInput: SearchPlacesInput = {
  mode: 'search',
  query: '静かなカフェ',
  area: { kind: 'named_area', name: '渋谷' },
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
    why: { text: '候補です', evidenceIds: [], basis: 'conversational' },
  },
  alts: [],
};

const searchResult: Result<SearchPlacesOutput> = {
  status: 'ok',
  data: {
    searchId: 'search-1',
    candidates: [],
    applied: { areaDescription: '渋谷', excludedCount: 0 },
    nextCursor: null,
    coverage: 'provider_results',
  },
  warnings: [],
};

const detailsResult: Result<GetPlaceDetailsOutput> = {
  status: 'ok',
  data: {
    items: [
      {
        candidateId: 'candidate-1',
        fields: { identity: { status: 'unknown', reason: 'fixture has no identity value' } },
      },
    ],
  },
  warnings: [],
};

const committedResult: SubmitCardsPortResult = {
  status: 'committed',
  responseId: 'response-1',
  revision: 1,
  presentation: 'replace',
  cards: submitInput,
};

type Ports = {
  search: number;
  details: number;
  submit: number;
  executions: ToolExecutionContext[];
  contexts: HarnessContext[];
};

const makeDependencies = (
  ports: Ports,
  cancellation: CancellationToken = { isCancelled: () => false },
  remainingRepairs = 2,
  registry = createToolRegistry().registry,
): ToolBindingDependencies => {
  const search: PlaceSearchPort = {
    search: (_input, receivedContext, execution) => {
      ports.search += 1;
      ports.contexts.push(receivedContext);
      ports.executions.push(execution);
      return Promise.resolve(searchResult);
    },
  };
  const details: PlaceDetailsPort = {
    read: (_input, receivedContext, execution) => {
      ports.details += 1;
      ports.contexts.push(receivedContext);
      ports.executions.push(execution);
      return Promise.resolve(detailsResult);
    },
  };
  const submit: SubmitCardsPort = {
    submit: (_input, execution) => {
      ports.submit += 1;
      ports.executions.push(execution);
      return Promise.resolve(committedResult);
    },
  };
  return {
    registry,
    clock: () => context.serverNow,
    search,
    details,
    submit,
    runtime: (operation, _invocation): ToolRuntime => ({
      context,
      execution: {
        callId: `server-${operation}`,
        operation,
        threadId: context.threadId,
        turnId: context.turnId,
        revision: context.revision,
      },
      cancellation,
      remainingRepairs,
    }),
  };
};

const invocation = { toolCallId: 'sdk-tool-1' };

describe('public tool catalog', () => {
  it('exposes exactly three AI SDK tools and rejects unknown names without a Port call', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports);
    const tools = createPublicToolSet(dependencies);

    expect(Object.keys(tools).sort()).toEqual([
      'get_place_details',
      'search_places',
      'submit_cards',
    ]);
    expect(tools.search_places.description).toContain('空白区切りのAND検索');
    expect(tools.search_places.description).toContain('地域名もqueryと同じkeywordへ連結');
    expect(tools.search_places.description).toContain('ジャンル語へ置き換えて');
    expect(tools.search_places.description).toContain('0件のときは語を減らす');
    expect(tools.search_places.description).not.toContain('openNow');
    expect(tools.get_place_details.description).toContain('まとめて1回のget_place_details');
    expect(tools.get_place_details.description).toContain(
      'fieldsへidentity、opening_hours、price、photos、facilities',
    );
    expect(tools.get_place_details.description).toContain('identityとopening_hoursは確定に必須');
    expect(tools.get_place_details.description).toContain('写真や価格が無い店舗でも提案できます');
    expect(tools.submit_cards.description).toContain('2nd step');
    expect(tools.submit_cards.description).toContain('システムが付けます');
    expect(tools.submit_cards.description).not.toContain('observationId');
    expect(tools.get_place_details.description).not.toContain('observationId');
    expect(tools.submit_cards.description).toContain('読み取りと確定は同じstepにできません');
    expect(getPublicTool(tools, 'walking_route')).toBeUndefined();
    const result = await invokePublicToolByName(
      'walking_route',
      searchInput,
      dependencies,
      invocation,
    );
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('INVALID_ARGUMENT');
    expect(ports).toMatchObject({ search: 0, details: 0, submit: 0 });
  });

  it('strictly rejects model input before calling a Port', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports);
    const result = await invokePublicTool(
      'search_places',
      { ...searchInput, ownerScopeRef: 'model-forged' },
      dependencies,
      invocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('INVALID_ARGUMENT');
    expect(ports.search).toBe(0);
  });

  it('injects owner context and a server call ID while preserving provider-swappable I/O', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports);
    const result = await invokePublicTool('search_places', searchInput, dependencies, invocation);

    expect(result).toEqual(searchResult);
    expect(ports.search).toBe(1);
    expect(ports.contexts[0]?.ownerScopeRef).toBe('owner-tools');
    expect(ports.contexts[0]?.budget.readCallsRemaining).toBe(5);
    expect(ports.executions[0]?.callId).toBe('server-search_places');
    expect(ports.executions[0]?.callId).not.toBe(invocation.toolCallId);
  });

  it('returns unsupported fields without calling the details Port', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports);
    const result = await invokePublicTool(
      'get_place_details',
      { ...detailsInput, requests: [{ candidateId: 'candidate-1', fields: ['price'] }] },
      dependencies,
      invocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('UNSUPPORTED_FIELD');
    expect(ports.details).toBe(0);
  });

  it('rejects a model-supplied travel context as an unknown input property', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports);
    const result = await invokePublicTool(
      'get_place_details',
      { ...detailsInput, travelContext: { departure: 'now', minimumStayMinutes: 5 } },
      dependencies,
      invocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.path).toBe('input');
    }
    expect(ports.details).toBe(0);
  });

  it('does not turn a details field mismatch into a successful response', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports);
    const mismatched: PlaceDetailsPort = {
      read: () =>
        Promise.resolve({
          status: 'ok',
          data: {
            items: [
              {
                candidateId: 'candidate-1',
                fields: { price: { status: 'unknown', reason: 'not supplied' } },
              },
            ],
          },
          warnings: [],
        }),
    };
    const result = await invokePublicTool(
      'get_place_details',
      detailsInput,
      { ...dependencies, details: mismatched },
      invocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('SCHEMA_MISMATCH');
  });

  it('does not report a successful read when cancellation arrives during the Port call', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    let cancelled = false;
    const dependencies = makeDependencies(ports, { isCancelled: () => cancelled });
    const delayedSearch: PlaceSearchPort = {
      search: () => {
        cancelled = true;
        return Promise.resolve(searchResult);
      },
    };
    const result = await invokePublicTool(
      'search_places',
      searchInput,
      { ...dependencies, search: delayedSearch },
      invocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('CANCELLED');
  });

  it('does not turn a cancellation exception into an upstream success', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    let cancelled = false;
    const dependencies = makeDependencies(ports, { isCancelled: () => cancelled });
    const throwingSearch: PlaceSearchPort = {
      search: () => {
        cancelled = true;
        return Promise.reject(new Error('aborted'));
      },
    };
    const result = await invokePublicTool(
      'search_places',
      searchInput,
      { ...dependencies, search: throwingSearch },
      invocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('CANCELLED');
  });

  it('preserves a structured provider failure instead of returning an empty success', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports);
    const failedSearch: PlaceSearchPort = {
      search: () =>
        Promise.resolve({
          status: 'error',
          error: {
            code: 'UPSTREAM_UNAVAILABLE',
            path: null,
            retryable: true,
            retryAfterMs: null,
            message: 'provider unavailable',
            missingFields: [],
          },
        }),
    };
    const result = await invokePublicTool(
      'search_places',
      searchInput,
      { ...dependencies, search: failedSearch },
      invocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('turns a malformed runtime factory result into a context error without a TypeError', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports);
    const result = await invokePublicTool(
      'search_places',
      searchInput,
      { ...dependencies, runtime: () => undefined },
      invocation,
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('MISSING_CONTEXT');
    expect(ports.search).toBe(0);
  });

  it('returns cancellation before all three Ports can observe a call', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports, { isCancelled: () => true });
    const [search, details, submit] = await Promise.all([
      invokePublicTool('search_places', searchInput, dependencies, invocation),
      invokePublicTool('get_place_details', detailsInput, dependencies, invocation),
      invokePublicTool('submit_cards', submitInput, dependencies, invocation),
    ]);

    expect(search.status).toBe('error');
    if (search.status === 'error') expect(search.error.code).toBe('CANCELLED');
    expect(details.status).toBe('error');
    if (details.status === 'error') expect(details.error.code).toBe('CANCELLED');
    expect(submit.status).toBe('invalid');
    if (submit.status === 'invalid') {
      expect(submit.issues[0]?.code).toBe('CANCELLED');
      expect(submit.repairable).toBe(false);
      expect(submit.remainingRepairs).toBe(0);
    }
    expect(ports).toMatchObject({ search: 0, details: 0, submit: 0 });
  });

  it('uses the injected repair budget for invalid submit input', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports, undefined, 1);
    const result = await invokePublicTool(
      'submit_cards',
      { ...submitInput, unexpected: true },
      dependencies,
      invocation,
    );

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues[0]?.code).toBe('INVALID_ARGUMENT');
      expect(result.repairable).toBe(true);
      expect(result.remainingRepairs).toBe(1);
    }
    expect(ports.submit).toBe(0);
  });

  it('forwards a committed Application result and keeps provider replacement contract stable', async () => {
    const ports: Ports = { search: 0, details: 0, submit: 0, executions: [], contexts: [] };
    const dependencies = makeDependencies(ports);
    const alternateSearch: PlaceSearchPort = {
      search: () => Promise.resolve({ ...searchResult, warnings: [] }),
    };
    const alternate = await invokePublicTool(
      'search_places',
      searchInput,
      { ...dependencies, search: alternateSearch },
      invocation,
    );
    const submit = await invokePublicTool('submit_cards', submitInput, dependencies, invocation);

    expect(alternate).toEqual(searchResult);
    expect(submit).toEqual(committedResult);
    expect(ports.submit).toBe(1);
  });
});

it('keeps the fixture HarnessContext aligned with the public context schema', () => {
  expect(v.safeParse(HarnessContextSchema, context).success).toBe(true);
});
