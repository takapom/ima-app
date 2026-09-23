import { describe, expect, it } from 'vitest';
import type { HarnessContext, ToolExecutionContext } from '@worker/application/ports/context';
import type {
  PlaceDetailsPort,
  PlaceSearchPort,
  SearchPlacesInput,
  SearchPlacesOutput,
} from '@worker/application/ports/operations';
import type { SubmitCardsPort } from '@worker/application/ports/submission';
import { invokePublicTool } from '@worker/adapters/in/tools';
import type { ToolBindingDependencies, ToolRuntime } from '@worker/adapters/in/tools';
import { createToolRegistry } from './registry-fixture';

const context: HarnessContext = {
  threadId: 'thread-clock',
  turnId: 'turn-clock',
  revision: 1,
  serverNow: '2026-09-10T00:00:00Z',
  ownerScopeRef: 'owner-clock',
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
    version: 'tools-clock-v1',
    detailFields: ['identity'],
    supportedScopes: ['clock-fixture'],
  },
};

const input: SearchPlacesInput = {
  mode: 'search',
  query: '静かなカフェ',
  area: { kind: 'named_area', name: '渋谷' },
  openNow: true,
  limit: 1,
  excludeCandidateIds: [],
};

const result: { status: 'ok'; data: SearchPlacesOutput; warnings: [] } = {
  status: 'ok',
  data: {
    searchId: 'search-clock',
    candidates: [],
    applied: { areaDescription: '渋谷', openNow: true, excludedCount: 0 },
    nextCursor: null,
    coverage: 'provider_results',
  },
  warnings: [],
};

const execution = (operation: ToolExecutionContext['operation']): ToolExecutionContext => ({
  callId: `call-${operation}`,
  operation,
  threadId: context.threadId,
  turnId: context.turnId,
  revision: context.revision,
});

const unusedDetails: PlaceDetailsPort = {
  read: () => Promise.reject(new Error('unused details Port')),
};
const unusedSubmit: SubmitCardsPort = {
  submit: () => Promise.reject(new Error('unused submit Port')),
};

describe('public tool read clock', () => {
  it('samples the injected clock only after the search Port settles', async () => {
    let settled = false;
    let release: (() => void) | undefined;
    let start: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const clockSamples: boolean[] = [];
    const search: PlaceSearchPort = {
      search: () =>
        new Promise((resolve) => {
          start?.();
          release = () => resolve(result);
        }),
    };
    const dependencies: ToolBindingDependencies = {
      registry: createToolRegistry().registry,
      clock: () => {
        clockSamples.push(settled);
        return context.serverNow;
      },
      search,
      details: unusedDetails,
      submit: unusedSubmit,
      runtime: (operation): ToolRuntime => ({
        context,
        execution: execution(operation),
        cancellation: { isCancelled: () => false },
        remainingRepairs: 0,
      }),
    };

    const pending = invokePublicTool('search_places', input, dependencies, {
      toolCallId: 'sdk-clock',
    });
    await started;
    expect(clockSamples).toEqual([]);
    if (release === undefined) throw new Error('search Port did not expose its release');
    settled = true;
    release();
    await expect(pending).resolves.toEqual(result);
    expect(clockSamples).toEqual([true]);
  });
});
