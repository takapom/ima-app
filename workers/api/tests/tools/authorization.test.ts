import { describe, expect, it } from 'vitest';
import { asSchema, type ToolExecutionOptions } from 'ai';
import type {
  CancellationToken,
  GetPlaceDetailsInput,
  HarnessContext,
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesInput,
  SubmitCardsPort,
} from '@ima/core';
import { createPublicToolSet, invokePublicTool } from '../../src/tools';
import type { ToolBindingDependencies, ToolRuntime } from '../../src/tools';
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
    homeStationRef: 'station-tools',
    maxWalkMinutes: 15,
    minimumStayMinutes: 20,
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
    walkingRoute: false,
    lastTrain: false,
    supportedScopes: ['tools-fixture'],
  },
};

const detailsInput = (candidateId: string): GetPlaceDetailsInput => ({
  requests: [{ candidateId, fields: ['identity'] }],
  freshness: 'reuse_valid',
});

const searchInput: SearchPlacesInput = {
  mode: 'search',
  query: '静かなカフェ',
  area: { kind: 'named_area', name: '渋谷' },
  openNow: true,
  limit: 2,
  excludeCandidateIds: [],
};

const makeDependencies = (
  registry: ReturnType<typeof createToolRegistry>['registry'],
  calls: { details: number; search: number },
): ToolBindingDependencies => {
  const cancellation: CancellationToken = { isCancelled: () => false };
  const details: PlaceDetailsPort = {
    read: () => {
      calls.details += 1;
      return Promise.resolve({
        status: 'error',
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          path: null,
          retryable: true,
          retryAfterMs: null,
          message: 'unexpected call',
          missingFields: [],
        },
      });
    },
  };
  const search: PlaceSearchPort = {
    search: () => {
      calls.search += 1;
      return Promise.reject(new Error('unexpected call'));
    },
  };
  const submit: SubmitCardsPort = {
    submit: () => Promise.reject(new Error('unexpected call')),
  };
  return {
    registry,
    clock: () => context.serverNow,
    search,
    details,
    submit,
    runtime: (operation): ToolRuntime => ({
      context,
      execution: {
        callId: `server-${operation}`,
        operation,
        threadId: context.threadId,
        turnId: context.turnId,
        revision: context.revision,
      },
      cancellation,
      remainingRepairs: 2,
    }),
  };
};

describe('tool candidate authorization', () => {
  it('allows a candidate registered in the exact owner and thread scope', async () => {
    const fixture = createToolRegistry();
    const calls = { details: 0, search: 0 };
    const result = await invokePublicTool(
      'get_place_details',
      detailsInput(fixture.currentCandidateId),
      makeDependencies(fixture.registry, calls),
      { toolCallId: 'sdk-details-1' },
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(calls.details).toBe(1);
  });

  it('rejects a candidate from another thread before the details Port', async () => {
    const fixture = createToolRegistry();
    const calls = { details: 0, search: 0 };
    const result = await invokePublicTool(
      'get_place_details',
      detailsInput(fixture.otherThreadCandidateId),
      makeDependencies(fixture.registry, calls),
      { toolCallId: 'sdk-details-2' },
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('UNKNOWN_CANDIDATE');
    expect(calls.details).toBe(0);
  });

  it('rejects a candidate from another owner before the details Port', async () => {
    const fixture = createToolRegistry();
    const calls = { details: 0, search: 0 };
    const result = await invokePublicTool(
      'get_place_details',
      detailsInput(fixture.otherOwnerCandidateId),
      makeDependencies(fixture.registry, calls),
      { toolCallId: 'sdk-details-3' },
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('UNKNOWN_CANDIDATE');
    expect(calls.details).toBe(0);
  });

  it('rejects an excluded candidate ID outside the exact scope before search', async () => {
    const fixture = createToolRegistry();
    const calls = { details: 0, search: 0 };
    const result = await invokePublicTool(
      'search_places',
      { ...searchInput, excludeCandidateIds: [fixture.otherThreadCandidateId] },
      makeDependencies(fixture.registry, calls),
      { toolCallId: 'sdk-search-1' },
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('UNKNOWN_CANDIDATE');
    expect(calls.search).toBe(0);
  });

  it('requires the M04 action envelope on the public AI SDK tool', async () => {
    const fixture = createToolRegistry();
    const calls = { details: 0, search: 0 };
    const base = makeDependencies(fixture.registry, calls);
    const successfulSearch: PlaceSearchPort = {
      search: () =>
        Promise.resolve({
          status: 'ok',
          data: {
            searchId: 'search-envelope',
            candidates: [],
            applied: { areaDescription: '渋谷', openNow: true, excludedCount: 0 },
            nextCursor: null,
            coverage: 'provider_results',
          },
          warnings: [],
        }),
    };
    let receivedMetadata: unknown;
    const tools = createPublicToolSet({
      ...base,
      search: successfulSearch,
      runtime: (operation, invocation, metadata) => {
        receivedMetadata = metadata;
        return base.runtime(operation, invocation, metadata);
      },
    });
    const envelope = {
      input: searchInput,
      metadata: {
        turnConstraints: {
          changes: [{ maxWalkMinutes: 15, sourceTurnId: 'turn-1', quote: '滞在' }],
        },
      },
    };
    const schema = asSchema(tools.search_places.inputSchema);
    if (schema.validate === undefined) throw new Error('search schema validator is missing');
    const accepted = await schema.validate(envelope);
    expect(accepted?.success).toBe(true);
    expect(await schema.validate(searchInput)).toMatchObject({
      success: false,
    });
    const execute = tools.search_places.execute;
    if (execute === undefined) throw new Error('search tool execute is missing');
    const options: ToolExecutionOptions = { toolCallId: 'sdk-envelope-1', messages: [] };
    const execution = execute(envelope, options);
    let resultStatus: string;
    if (typeof execution === 'object' && execution !== null && Symbol.asyncIterator in execution) {
      const iterator = execution[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value === undefined) throw new Error('search tool returned no value');
      resultStatus = first.value.status;
    } else {
      const result = await execution;
      resultStatus = result.status;
    }
    expect(resultStatus).toBe('ok');
    expect(receivedMetadata).toEqual(envelope.metadata);
  });

  it('rejects a search Port result whose candidate is outside the registry scope', async () => {
    const fixture = createToolRegistry();
    const calls = { details: 0, search: 0 };
    const dependencies = makeDependencies(fixture.registry, calls);
    let searchCalled = false;
    const forgedSearch: PlaceSearchPort = {
      search: () => {
        searchCalled = true;
        return Promise.resolve({
          status: 'ok',
          data: {
            searchId: 'search-forged',
            candidates: [
              {
                candidateId: 'candidate-forged',
                identity: { status: 'unknown', reason: 'fixture' },
                openingHours: { status: 'unknown', reason: 'fixture' },
                price: { status: 'unknown', reason: 'fixture' },
              },
            ],
            applied: { areaDescription: '渋谷', openNow: true, excludedCount: 0 },
            nextCursor: null,
            coverage: 'provider_results',
          },
          warnings: [],
        });
      },
    };
    const result = await invokePublicTool(
      'search_places',
      searchInput,
      { ...dependencies, search: forgedSearch },
      { toolCallId: 'sdk-search-forged' },
    );

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error.code).toBe('UNKNOWN_CANDIDATE');
    expect(searchCalled).toBe(true);
  });
});
